import {
  type DiscussionCallPhase,
  type DiscussionClientFrame,
  type DiscussionEndReason,
  type DiscussionId,
  type DiscussionMicMode,
  DiscussionServerFrame,
  type DiscussionSpeaker,
  type ThreadId,
} from "@t3tools/contracts";
import {
  type EndpointerInput,
  type EndpointerState,
  initialEndpointer,
  stepEndpointer,
} from "@t3tools/shared/discussion/endpointer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

/** Capture frames are 100 ms of 16 kHz mono Int16; the endpointer's clock counts them. */
const DISCUSSION_FRAME_MS = 100;
/** Frames kept before onset, so the first syllable of a line reaches the server. */
const PRE_ROLL_FRAMES = 3;
const SOCKET_OPEN = 1;

// A newer server may add frames; anything this client does not know is skipped.
const decodeServerFrame = Schema.decodeUnknownOption(Schema.fromJsonString(DiscussionServerFrame));

/** The call's audio, supplied per platform. Playback is 24 kHz mono Int16. */
export interface DuplexAudio {
  start(handlers: {
    /** 100 ms of 16 kHz mono Int16 PCM and its RMS level, 0 to 1. */
    readonly onFrame: (pcm: Int16Array<ArrayBuffer>, level: number) => void;
    readonly onPlaybackLevel: (level: number) => void;
    readonly onError: (message: string) => void;
  }): Promise<void>;
  /** Queues audio behind what is already playing, without gaps. */
  play(pcm: Int16Array<ArrayBuffer>): void;
  /** Drops queued and playing audio at once. */
  flush(): void;
  isPlaying(): boolean;
  close(): void;
}

/** How a call reaches its environment; rejections carry the message to show. */
export interface DiscussionEnvironment {
  start(threadId: ThreadId): Promise<DiscussionId>;
  streamUrl(discussionId: DiscussionId): Promise<string>;
  end(input: {
    readonly threadId: ThreadId;
    readonly discussionId: DiscussionId;
    readonly reason: DiscussionEndReason;
  }): Promise<void>;
}

export type DiscussionCallStatus = "starting" | "live" | "ended" | "failed";

export interface DiscussionCaption {
  readonly speaker: DiscussionSpeaker;
  readonly text: string;
  readonly final: boolean;
}

export interface DiscussionCallState {
  readonly status: DiscussionCallStatus;
  readonly discussionId: DiscussionId | null;
  readonly phase: DiscussionCallPhase;
  readonly caption: DiscussionCaption | null;
  readonly muted: boolean;
  readonly micMode: DiscussionMicMode;
  /** A line is open: speech heard on open mic, or the talk key held in push to talk. */
  readonly talking: boolean;
  readonly error: string | null;
  readonly endReason: DiscussionEndReason | null;
}

export interface DiscussionLevels {
  readonly mic: number;
  readonly agent: number;
}

export interface DiscussionCall {
  readonly threadId: ThreadId;
  /** Changes at call rate (phase, caption, mute), never at audio rate. */
  readonly state: Atom.Atom<DiscussionCallState>;
  getState(): DiscussionCallState;
  subscribe(listener: () => void): () => void;
  /** Levels arrive about ten times a second; draw them outside React. */
  subscribeLevels(listener: (levels: DiscussionLevels) => void): () => void;
  setMuted(muted: boolean): void;
  setMicMode(mode: DiscussionMicMode): void;
  /** Push to talk: the talk key or button went down or up. */
  press(): void;
  release(): void;
  /** Hangs up for every device; resolves once the environment accepted it. */
  end(): Promise<void>;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function openDiscussion(input: {
  readonly threadId: ThreadId;
  readonly environment: DiscussionEnvironment;
  readonly audio: DuplexAudio;
  readonly micMode: DiscussionMicMode;
  readonly endOfSpeechMs: number;
  readonly createSocket?: (url: string) => WebSocket;
}): DiscussionCall {
  const { audio, environment, threadId } = input;
  let state: DiscussionCallState = {
    status: "starting",
    discussionId: null,
    phase: "listening",
    caption: null,
    muted: false,
    micMode: input.micMode,
    talking: false,
    error: null,
    endReason: null,
  };
  const listeners = new Set<() => void>();
  const levelListeners = new Set<(levels: DiscussionLevels) => void>();
  let levels: DiscussionLevels = { mic: 0, agent: 0 };
  let socket: WebSocket | null = null;
  let endpointer: EndpointerState = initialEndpointer;
  let frameIndex = 0;
  let preRoll: Array<{ readonly at: number; readonly pcm: Int16Array<ArrayBuffer> }> = [];
  let closed = false;
  let ending: Promise<void> | null = null;

  const update = (patch: Partial<DiscussionCallState>) => {
    state = { ...state, ...patch };
    // A snapshot: the state atom resubscribes while it rebuilds inside this loop.
    for (const listener of Array.from(listeners)) listener();
  };
  const publishLevels = (patch: Partial<DiscussionLevels>) => {
    levels = { ...levels, ...patch };
    for (const listener of Array.from(levelListeners)) listener(levels);
  };
  const send = (frame: DiscussionClientFrame | Int16Array<ArrayBuffer>) => {
    if (socket === null || socket.readyState !== SOCKET_OPEN) return;
    socket.send(frame instanceof Int16Array ? frame : JSON.stringify(frame));
  };
  const teardown = (patch: Partial<DiscussionCallState>) => {
    if (closed) return;
    closed = true;
    audio.close();
    socket?.close();
    socket = null;
    publishLevels({ mic: 0, agent: 0 });
    update({ ...patch, talking: false });
  };
  const fail = (message: string) => teardown({ status: "failed", error: message });

  const step = (endpointerInput: EndpointerInput) => {
    const next = stepEndpointer(endpointer, endpointerInput, {
      mode: state.micMode,
      endOfSpeechMs: input.endOfSpeechMs,
    });
    endpointer = next.state;
    if (next.edge === null) return;
    if (next.edge.edge === "start") {
      send({ type: "speech_start" });
      const onsetAt = next.edge.at;
      for (const frame of preRoll) if (frame.at >= onsetAt) send(frame.pcm);
      preRoll = [];
      update({ talking: true });
    } else {
      send({ type: "speech_end" });
      update({ talking: false });
    }
  };
  /** Closes an open line without waiting for silence, as mute and a mode switch do. */
  const closeLine = () => {
    if (endpointer.speaking) send({ type: "speech_end" });
    endpointer = initialEndpointer;
    preRoll = [];
  };

  const onFrame = (pcm: Int16Array<ArrayBuffer>, level: number) => {
    const at = frameIndex * DISCUSSION_FRAME_MS;
    frameIndex += 1;
    if (state.status !== "live" || state.muted) return;
    publishLevels({ mic: level });
    if (state.micMode === "push") {
      if (endpointer.speaking) send(pcm);
      return;
    }
    if (endpointer.speaking) send(pcm);
    else {
      preRoll.push({ at, pcm });
      if (preRoll.length > PRE_ROLL_FRAMES) preRoll.shift();
    }
    step({
      type: "level",
      level,
      at,
      agentSpeaking: state.phase === "speaking" || audio.isPlaying(),
    });
  };

  const onMessage = (event: MessageEvent) => {
    if (closed) return;
    const data: unknown = event.data;
    if (data instanceof ArrayBuffer) {
      audio.play(new Int16Array(data, 0, data.byteLength >> 1));
      return;
    }
    if (typeof data !== "string") return;
    const frame = decodeServerFrame(data);
    if (Option.isNone(frame)) return;
    switch (frame.value.type) {
      case "phase":
        update({ phase: frame.value.phase });
        return;
      case "caption":
        update({
          caption: {
            speaker: frame.value.speaker,
            text: frame.value.text,
            final: frame.value.final,
          },
        });
        return;
      case "cut":
        audio.flush();
        publishLevels({ agent: 0 });
        return;
      case "ended":
        teardown({ status: "ended", endReason: frame.value.reason });
        return;
    }
  };

  const connect = async () => {
    try {
      await audio.start({
        onFrame,
        onPlaybackLevel: (level) => publishLevels({ agent: level }),
        onError: fail,
      });
    } catch (error) {
      fail(errorMessage(error, "Could not open the microphone."));
      return;
    }
    if (closed) return;
    let discussionId: DiscussionId;
    try {
      discussionId = await environment.start(threadId);
    } catch (error) {
      fail(errorMessage(error, "Could not start the discussion."));
      return;
    }
    // Hung up, or the microphone failed, while the environment was starting the call.
    const abandon = () =>
      environment
        .end({ threadId, discussionId, reason: ending ? "ended_by_user" : "client_lost" })
        .catch(() => undefined);
    if (closed) return void abandon();
    update({ discussionId });
    let url: string;
    try {
      url = await environment.streamUrl(discussionId);
    } catch (error) {
      fail(errorMessage(error, "Could not connect the call."));
      return void abandon();
    }
    if (closed) return void abandon();
    const next = (input.createSocket ?? ((target) => new WebSocket(target)))(url);
    next.binaryType = "arraybuffer";
    socket = next;
    next.addEventListener("open", () => {
      if (closed) return;
      update({ status: "live" });
      if (state.muted) send({ type: "mute", muted: true });
    });
    next.addEventListener("message", onMessage);
    // The environment ends a call whose socket stays gone, so a drop is not hung up here.
    next.addEventListener("close", () => fail("The call connection closed."));
    next.addEventListener("error", () => fail("The call connection failed."));
  };
  void connect();

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  const stateAtom = Atom.make((get) => {
    get.addFinalizer(subscribe(() => get.refreshSelf()));
    return state;
  }).pipe(Atom.withLabel(`discussion:${threadId}`));

  return {
    threadId,
    state: stateAtom,
    getState: () => state,
    subscribe,
    subscribeLevels: (listener) => {
      levelListeners.add(listener);
      return () => void levelListeners.delete(listener);
    },
    setMuted: (muted) => {
      if (closed || muted === state.muted) return;
      if (muted) closeLine();
      send({ type: "mute", muted });
      if (muted) publishLevels({ mic: 0 });
      update({ muted, talking: false });
    },
    setMicMode: (mode) => {
      if (closed || mode === state.micMode) return;
      closeLine();
      update({ micMode: mode, talking: false });
    },
    press: () => {
      if (state.status !== "live" || state.muted || state.micMode !== "push") return;
      step({ type: "press", at: frameIndex * DISCUSSION_FRAME_MS });
    },
    release: () => {
      if (state.status !== "live" || state.micMode !== "push") return;
      step({ type: "release", at: frameIndex * DISCUSSION_FRAME_MS });
    },
    end: () => {
      if (ending) return ending;
      const discussionId = state.discussionId;
      teardown({ status: "ended", endReason: "ended_by_user" });
      // Before the environment answered, the start continuation hangs up once it has an id.
      ending =
        discussionId === null
          ? Promise.resolve()
          : environment.end({ threadId, discussionId, reason: "ended_by_user" });
      return ending;
    },
  };
}
