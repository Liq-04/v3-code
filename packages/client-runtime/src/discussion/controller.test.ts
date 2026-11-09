import { DiscussionId, ThreadId, type DiscussionMicMode } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { openDiscussion, type DuplexAudio } from "./controller.ts";

const threadId = ThreadId.make("thread-1");
const discussionId = DiscussionId.make("discussion-1");

class FakeSocket extends EventTarget {
  readyState = 0;
  binaryType = "blob";
  sent: Array<string | Int16Array> = [];
  send(data: string | Int16Array) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  receive(data: string | ArrayBuffer) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  frames() {
    return this.sent.map((data) =>
      typeof data === "string" ? (JSON.parse(data) as { type: string }).type : "audio",
    );
  }
}

function fakeAudio() {
  let onFrame!: (pcm: Int16Array<ArrayBuffer>, level: number) => void;
  const audio = {
    start: vi.fn<DuplexAudio["start"]>(async (handlers) => {
      onFrame = handlers.onFrame;
    }),
    play: vi.fn<DuplexAudio["play"]>(),
    flush: vi.fn<DuplexAudio["flush"]>(),
    isPlaying: () => false,
    close: vi.fn<DuplexAudio["close"]>(),
  } satisfies DuplexAudio;
  return { audio, frame: (level: number) => onFrame(new Int16Array(1600), level) };
}

async function connect(micMode: DiscussionMicMode = "open") {
  const socket = new FakeSocket();
  const { audio, frame } = fakeAudio();
  const environment = {
    start: vi.fn(async () => discussionId),
    streamUrl: vi.fn(async () => "wss://environment.test/ws/discussion"),
    end: vi.fn(async () => undefined),
  };
  let socketCreated!: () => void;
  const created = new Promise<void>((resolve) => {
    socketCreated = resolve;
  });
  const call = openDiscussion({
    threadId,
    environment,
    audio,
    micMode,
    endOfSpeechMs: 300,
    createSocket: () => {
      socketCreated();
      return socket as unknown as WebSocket;
    },
  });
  await created;
  expect(environment.streamUrl).toHaveBeenCalledWith(discussionId);
  socket.open();
  expect(call.getState().status).toBe("live");
  return { call, socket, audio, frame, environment };
}

it("sends a line's edges from the endpointer on open mic, with the onset audio", async () => {
  const { call, socket, frame } = await connect();
  frame(0);
  frame(0.2);
  expect(socket.frames()).toEqual([]);
  frame(0.2);
  expect(socket.frames()).toEqual(["speech_start", "audio", "audio"]);
  expect(call.getState().talking).toBe(true);
  frame(0);
  frame(0);
  frame(0);
  frame(0);
  expect(socket.frames()).toEqual([
    "speech_start",
    "audio",
    "audio",
    "audio",
    "audio",
    "audio",
    "audio",
    "speech_end",
  ]);
  expect(call.getState().talking).toBe(false);
  frame(0);
  expect(socket.sent).toHaveLength(8);
});

it("sends edges on press and release in push to talk, and no audio while released", async () => {
  const { socket, frame, call } = await connect("push");
  frame(0.5);
  frame(0.5);
  expect(socket.frames()).toEqual([]);
  call.press();
  frame(0);
  frame(0.5);
  call.release();
  frame(0.5);
  expect(socket.frames()).toEqual(["speech_start", "audio", "audio", "speech_end"]);
});

it("plays agent audio, flushes it on cut, and skips frames it does not know", async () => {
  const { call, socket, audio } = await connect();
  socket.receive(new Int16Array([1, 2, 3]).buffer);
  expect(audio.play).toHaveBeenCalledWith(new Int16Array([1, 2, 3]));
  socket.receive(JSON.stringify({ type: "phase", phase: "speaking" }));
  socket.receive(JSON.stringify({ type: "voice_stats", jitterMs: 4 }));
  socket.receive(JSON.stringify({ type: "phase", phase: "dreaming" }));
  socket.receive("not json");
  expect(call.getState()).toMatchObject({ status: "live", phase: "speaking" });
  socket.receive(JSON.stringify({ type: "cut" }));
  expect(audio.flush).toHaveBeenCalledOnce();
  socket.receive(JSON.stringify({ type: "caption", speaker: "user", text: "hi", final: false }));
  expect(call.getState().caption).toEqual({ speaker: "user", text: "hi", final: false });
  socket.receive(JSON.stringify({ type: "ended", reason: "thread_closed" }));
  expect(call.getState()).toMatchObject({ status: "ended", endReason: "thread_closed" });
  expect(audio.close).toHaveBeenCalledOnce();
});

it("ends the call for every device through the end command", async () => {
  const { call, environment, audio } = await connect();
  await call.end();
  expect(environment.end).toHaveBeenCalledWith({
    threadId,
    discussionId,
    reason: "ended_by_user",
  });
  expect(call.getState().status).toBe("ended");
  expect(audio.close).toHaveBeenCalledOnce();
});
