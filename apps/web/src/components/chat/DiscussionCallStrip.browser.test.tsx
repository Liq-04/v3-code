import { openDiscussion, type DuplexAudio } from "@t3tools/client-runtime/discussion";
import { DiscussionId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { DiscussionCallBanner } from "./DiscussionCallStrip";

class FakeSocket extends EventTarget {
  readyState = 0;
  binaryType = "blob";
  send() {}
  close() {
    this.readyState = 3;
  }
  receive(frame: object) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }
}

it("shows the call's phase and caption from server frames, and End hangs up", async () => {
  const socket = new FakeSocket();
  const audio: DuplexAudio = {
    start: async () => undefined,
    play: () => undefined,
    flush: () => undefined,
    isPlaying: () => false,
    close: () => undefined,
  };
  const discussionId = DiscussionId.make("discussion-1");
  const end = vi.fn(async () => undefined);
  let socketCreated!: () => void;
  const created = new Promise<void>((resolve) => {
    socketCreated = resolve;
  });
  const call = openDiscussion({
    threadId: ThreadId.make("thread-1"),
    environment: {
      start: async () => discussionId,
      streamUrl: async () => "wss://environment.test/ws/discussion",
      end,
    },
    audio,
    micMode: "open",
    endOfSpeechMs: 600,
    createSocket: () => {
      socketCreated();
      return socket as unknown as WebSocket;
    },
  });
  await using screen = await render(<DiscussionCallBanner call={call} onDismiss={vi.fn()} />);
  await expect.element(screen.getByRole("status")).toHaveTextContent("Connecting…");
  await created;
  await act(() => {
    socket.readyState = 1;
    socket.dispatchEvent(new Event("open"));
  });
  await expect.element(screen.getByRole("status")).toHaveTextContent("Listening");

  await act(() => {
    socket.receive({ type: "phase", phase: "speaking" });
    socket.receive({
      type: "caption",
      speaker: "agent",
      text: "Running the tests now.",
      final: true,
    });
  });
  await expect.element(screen.getByRole("status")).toHaveTextContent("Speaking");
  await expect.element(screen.getByText("Running the tests now.")).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "End" }));
  expect(end).toHaveBeenCalledWith({
    threadId: ThreadId.make("thread-1"),
    discussionId,
    reason: "ended_by_user",
  });
});
