import {
  CommandId,
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  type DiscussionCallPhase,
  DiscussionClientFrame,
  type DiscussionEndReason,
  DiscussionId,
  DiscussionServerFrame,
  DiscussionStartError,
  type DiscussionStartResult,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type ProjectId,
  type RunId,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  callPhase,
  type CallRun,
  type CallVoice,
  resumesCutReply,
} from "@t3tools/shared/discussion/callPhase";
import {
  startSpeechBeats,
  type SpeechBeats,
  stepSpeechBeats,
} from "@t3tools/shared/discussion/speechBeats";
import {
  startStatusTimer,
  type StatusTimer,
  type StatusToolCall,
  stepStatusTimer,
} from "@t3tools/shared/discussion/statusLine";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";

import { base64UrlEncode } from "../auth/utils.ts";
import { DISCUSSION_FAILURE } from "../orchestration-v2/DiscussionDecider.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";
import * as LiveAssistantTextHub from "../orchestration-v2/LiveAssistantTextHub.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SpeechService from "../speech/SpeechService.ts";
import * as ElevenLabsSynth from "./ElevenLabsSynth.ts";

/**
 * The one owner of live calls. Orchestration holds the thread's "on a call" marker and the
 * timeline item; everything audio-timed lives here, in memory, and dies with the call.
 */

/** A socket gone this long ends the call. */
const CLIENT_LOST_AFTER = "30 seconds";
/** Audio kept before the client reports speech, so the first syllable is not lost. */
const PRE_ROLL_BYTES = 16_000 * 2 * 0.3;
const STATUS_TICK = "1 second";
const APPROVAL_LINE = "I need your approval to continue.";

/**
 * Model-facing framing for a spoken line. The agent answers in short spoken sentences and names
 * what it is about to do before a tool call, so the call is not silent while it works.
 */
export const frameSpokenLine = (spoken: string) =>
  `Spoken in a voice discussion. Answer in short spoken sentences, no markdown or code. Before you use a tool, say in one short sentence what you are about to do.\n\n${spoken}`;

export class DiscussionEndError extends Schema.TaggedError<DiscussionEndError>()(
  "DiscussionEndError",
  { threadId: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not end the discussion.";
  }
}

export interface DiscussionSnapshot {
  readonly discussionId: DiscussionId;
  readonly phase: DiscussionCallPhase;
  readonly attached: boolean;
}

export class DiscussionService extends Context.Service<
  DiscussionService,
  {
    readonly start: (input: {
      readonly threadId: ThreadId;
      /** The device holding the call's audio, as its client label reads. */
      readonly heldBy: string;
    }) => Effect.Effect<DiscussionStartResult, DiscussionStartError>;
    /** Idempotent: a call already over is a no-op. Never waits on the provider. */
    readonly end: (input: {
      readonly threadId: ThreadId;
      readonly discussionId?: DiscussionId;
      readonly reason: DiscussionEndReason;
    }) => Effect.Effect<"ended" | "not_live", DiscussionEndError>;
    /** Serves one media socket until it closes or the call ends. A second socket replaces the first. */
    readonly attach: (discussionId: DiscussionId, socket: Socket.Socket) => Effect.Effect<void>;
    readonly snapshot: (threadId: ThreadId) => Effect.Effect<DiscussionSnapshot | null>;
  }
>()("t3/discussion/DiscussionService") {}

interface SynthPlayback {
  readonly session: ElevenLabsSynth.SynthSession;
  readonly scope: Scope.Closeable;
  /** Opened for a status line only; agent text cuts it. */
  statusOnly: boolean;
  /** Beats sent so far; a connected but silent session is not "speaking". */
  said: number;
}

interface LiveCall {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly discussionId: DiscussionId;
  readonly scope: Scope.Closeable;
  readonly ended: Deferred.Deferred<DiscussionEndReason>;
  endReason: DiscussionEndReason | null;
  writer: Socket.Writer | null;
  socketScope: Scope.Closeable | null;
  lostTimer: Fiber.Fiber<void> | null;
  voice: CallVoice;
  muted: boolean;
  activeRuns: Set<RunId>;
  pendingRequests: Set<RuntimeRequestId>;
  lastPhase: DiscussionCallPhase | null;
  beats: SpeechBeats;
  /** Beats written while the user talks: spoken after a false barge-in, dropped after a line. */
  pendingBeats: Array<string>;
  cut: boolean;
  status: StatusTimer;
  latestTool: StatusToolCall | null;
  synth: SynthPlayback | null;
  line: { readonly scope: Scope.Closeable; readonly stream: SpeechService.SpeechStream } | null;
  preRoll: Array<Uint8Array>;
  preRollBytes: number;
  lineCount: number;
}

const decodeClientFrame = Schema.decodeUnknownEffect(Schema.fromJsonString(DiscussionClientFrame));
const encodeServerFrame = Schema.encodeSync(Schema.fromJsonString(DiscussionServerFrame));

const ACTIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

const isDispatchFailure = Schema.is(OrchestratorDispatchError);

/** 16 kHz Int16 from the client to the Float32 frames the speech service expects. */
function int16ToFloat32Bytes(bytes: Uint8Array): Uint8Array {
  const aligned = bytes.byteOffset % 2 === 0 && bytes.byteLength % 2 === 0 ? bytes : bytes.slice();
  const samples = new Int16Array(
    aligned.buffer,
    aligned.byteOffset,
    Math.floor(aligned.byteLength / 2),
  );
  const out = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index++) out[index] = samples[index]! / 32_768;
  return new Uint8Array(out.buffer);
}

const callRun = (call: Pick<LiveCall, "activeRuns" | "pendingRequests">): CallRun =>
  call.pendingRequests.size > 0 ? "needsApproval" : call.activeRuns.size > 0 ? "running" : "idle";

const freshBeats = (call: Pick<LiveCall, "synth">) =>
  call.synth !== null && !call.synth.statusOnly && call.synth.said > 0;

const isThreadPayload = (payload: unknown): payload is OrchestrationV2AppThread =>
  typeof payload === "object" &&
  payload !== null &&
  "archivedAt" in payload &&
  "lineage" in payload;

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const eventSink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const speech = yield* SpeechService.SpeechService;
  const synth = yield* ElevenLabsSynth.DiscussionSynth;
  const liveText = yield* LiveAssistantTextHub.LiveAssistantTextHub;
  const settings = yield* ServerSettings.ServerSettingsService;
  const random = yield* SecureRandom.SecureRandom;
  const calls = yield* Ref.make<ReadonlyMap<ThreadId, LiveCall>>(new Map());
  const serviceScope = yield* Effect.scope;

  const findCall = (discussionId: DiscussionId) =>
    Ref.get(calls).pipe(
      Effect.map(
        (map) => [...map.values()].find((call) => call.discussionId === discussionId) ?? null,
      ),
    );

  // Frames and audio go to whichever socket holds the call; a closed socket drops them.
  const send = (call: LiveCall, frame: DiscussionServerFrame) =>
    call.writer === null
      ? Effect.void
      : call.writer.write(encodeServerFrame(frame)).pipe(Effect.ignore);
  const sendAudio = (call: LiveCall, pcm: Uint8Array) =>
    call.writer === null ? Effect.void : call.writer.write(pcm).pipe(Effect.ignore);

  const publishPhase = (call: LiveCall) =>
    Effect.suspend(() => {
      const phase = callPhase({
        voice: call.voice,
        run: callRun(call),
        freshBeats: freshBeats(call),
      });
      if (phase === call.lastPhase) return Effect.void;
      call.lastPhase = phase;
      return send(call, { type: "phase", phase });
    });

  const cutSynth = (call: LiveCall, options: { readonly notify: boolean }) =>
    Effect.suspend(() => {
      const playback = call.synth;
      if (playback === null) return Effect.void;
      call.synth = null;
      return Scope.close(playback.scope, Exit.void).pipe(
        Effect.andThen(options.notify ? send(call, { type: "cut" }) : Effect.void),
      );
    });

  /** The open synth session, or a new one; `null` when the synthesizer is unavailable. */
  const ensureSynth = Effect.fn("DiscussionService.ensureSynth")(function* (
    call: LiveCall,
    statusOnly: boolean,
  ) {
    if (call.synth !== null) {
      if (!statusOnly) call.synth.statusOnly = false;
      return call.synth;
    }
    const scope = yield* Scope.fork(call.scope);
    const opened = yield* synth.open().pipe(Scope.provide(scope), Effect.exit);
    if (Exit.isFailure(opened)) {
      yield* Effect.logWarning("Discussion voice synthesis unavailable", {
        discussionId: call.discussionId,
        cause: opened.cause,
      });
      yield* Scope.close(scope, Exit.void);
      return null;
    }
    const playback: SynthPlayback = { session: opened.value, scope, statusOnly, said: 0 };
    call.synth = playback;
    yield* opened.value.audio.pipe(
      Stream.runForEach((pcm) => sendAudio(call, pcm)),
      Effect.catchCause((cause) =>
        Effect.logWarning("Discussion voice playback ended early", {
          discussionId: call.discussionId,
          cause,
        }),
      ),
      Effect.ensuring(
        Effect.suspend(() => {
          if (call.synth !== playback) return Effect.void;
          call.synth = null;
          return publishPhase(call);
        }),
      ),
      Effect.forkIn(scope),
    );
    return playback;
  });

  const speak = Effect.fn("DiscussionService.speak")(function* (
    call: LiveCall,
    text: string,
    statusOnly = false,
  ) {
    const playback = yield* ensureSynth(call, statusOnly);
    if (playback === null) return;
    yield* playback.session.say(text).pipe(Effect.ignore);
    playback.said += 1;
    yield* publishPhase(call);
    yield* send(call, { type: "caption", speaker: "agent", text, final: false });
  });

  const finishReply = (call: LiveCall) =>
    call.synth === null || call.synth.statusOnly
      ? Effect.void
      : call.synth.session.finish.pipe(Effect.ignore);

  const onAssistantText = Effect.fn("DiscussionService.onAssistantText")(function* (
    call: LiveCall,
    frame: Extract<LiveAssistantTextHub.LiveAssistantFrame, { readonly kind: "text" }>,
  ) {
    const at = yield* Clock.currentTimeMillis;
    const stepped = stepSpeechBeats(call.beats, {
      type: "text",
      messageId: frame.messageId,
      runId: frame.runId,
      text: frame.text,
      complete: frame.complete,
      at,
    });
    call.beats = stepped.state;
    const status = stepStatusTimer(call.status, { type: "agentText", at });
    call.status = status.state;
    // Agent text outranks a status line that is still playing.
    if (status.drop && call.synth?.statusOnly) yield* cutSynth(call, { notify: true });
    for (const beat of stepped.beats) {
      if (call.voice === "hearing") call.pendingBeats.push(beat);
      else yield* speak(call, beat);
    }
    if (frame.complete && call.voice !== "hearing") yield* finishReply(call);
  });

  const onTick = Effect.fn("DiscussionService.onTick")(function* (call: LiveCall) {
    const at = yield* Clock.currentTimeMillis;
    const stepped = stepSpeechBeats(call.beats, { type: "tick", at });
    call.beats = stepped.state;
    for (const beat of stepped.beats) {
      if (call.voice === "hearing") call.pendingBeats.push(beat);
      else yield* speak(call, beat);
    }
    const status = stepStatusTimer(call.status, {
      type: "tick",
      at,
      run: callRun(call),
      call: call.latestTool,
    });
    call.status = status.state;
    if (status.say !== null && call.voice !== "hearing" && call.synth === null) {
      yield* speak(call, status.say, true);
    }
  });

  const onThreadEvent = Effect.fn("DiscussionService.onThreadEvent")(function* (
    call: LiveCall,
    event: OrchestrationV2DomainEvent,
  ) {
    const before = callRun(call);
    switch (event.type) {
      case "run.created":
      case "run.updated":
        if (ACTIVE_RUN_STATUSES.has(event.payload.status)) call.activeRuns.add(event.payload.id);
        else call.activeRuns.delete(event.payload.id);
        break;
      case "runtime-request.updated":
        if (event.payload.status === "pending") call.pendingRequests.add(event.payload.id);
        else call.pendingRequests.delete(event.payload.id);
        break;
      default:
        if (isThreadPayload(event.payload) && event.payload.discussion?.id !== call.discussionId) {
          const closed = event.payload.archivedAt !== null || event.payload.deletedAt !== null;
          yield* Deferred.succeed(
            call.ended,
            call.endReason ?? (closed ? "thread_closed" : "ended_by_user"),
          );
        }
        return;
    }
    const after = callRun(call);
    if (after === before) return;
    if (after === "needsApproval") {
      yield* cutSynth(call, { notify: true });
      yield* speak(call, APPROVAL_LINE);
    }
    if (after === "idle") yield* finishReply(call);
    yield* publishPhase(call);
  });

  const sendLine = Effect.fn("DiscussionService.sendLine")(function* (
    call: LiveCall,
    spoken: string,
  ) {
    call.lineCount += 1;
    const messageId = MessageId.make(`message:discussion:${call.discussionId}:${call.lineCount}`);
    yield* send(call, { type: "caption", speaker: "user", text: spoken, final: true });
    const sent = yield* threads
      .sendToThread({
        projectId: call.projectId,
        commandId: CommandId.make(`command:discussion:${call.discussionId}:${call.lineCount}`),
        threadId: call.threadId,
        messageId,
        text: frameSpokenLine(spoken),
        attachments: [],
        context: {
          version: 1,
          records: [],
          discussion: { discussionId: call.discussionId, spoken },
        },
        mode: "auto",
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.exit);
    if (Exit.isFailure(sent)) {
      yield* Effect.logWarning("Discussion line was not delivered", {
        discussionId: call.discussionId,
        cause: sent.cause,
      });
      return;
    }
    // The run is known here before its event reaches the watcher, so the phase does not flicker.
    if (ACTIVE_RUN_STATUSES.has(sent.value.run.status)) call.activeRuns.add(sent.value.run.id);
    const at = yield* Clock.currentTimeMillis;
    // The watermark: nothing written before this line is spoken.
    call.beats = stepSpeechBeats(call.beats, { type: "line" }).state;
    call.status = stepStatusTimer(call.status, { type: "line", at }).state;
    call.pendingBeats = [];
    call.cut = false;
    yield* cutSynth(call, { notify: false });
    // Connecting now overlaps the model's first token.
    yield* ensureSynth(call, false);
  });

  const closeLine = (call: LiveCall) =>
    Effect.suspend(() => {
      const line = call.line;
      call.line = null;
      return line === null ? Effect.void : Scope.close(line.scope, Exit.void);
    });

  const onSpeechStart = Effect.fn("DiscussionService.onSpeechStart")(function* (call: LiveCall) {
    if (call.voice === "hearing") return;
    call.voice = "hearing";
    if (call.synth !== null && !call.synth.statusOnly) call.cut = true;
    yield* cutSynth(call, { notify: true });
    yield* publishPhase(call);
    const scope = yield* Scope.fork(call.scope);
    const opened = yield* speech
      .startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)
      .pipe(Scope.provide(scope), Effect.exit);
    if (Exit.isFailure(opened)) {
      yield* Effect.logWarning("Discussion could not open transcription", {
        discussionId: call.discussionId,
        cause: opened.cause,
      });
      yield* Scope.close(scope, Exit.void);
      return;
    }
    call.line = { scope, stream: opened.value };
    for (const chunk of call.preRoll) yield* feedLine(call, chunk);
    call.preRoll = [];
    call.preRollBytes = 0;
  });

  const feedLine = (call: LiveCall, pcm: Uint8Array) =>
    Effect.suspend(() => {
      const line = call.line;
      if (line === null) return Effect.void;
      return line.stream.feed(int16ToFloat32Bytes(pcm)).pipe(
        Effect.flatMap((update) => {
          const text = `${update.text?.committed ?? ""}${update.text?.tentative ?? ""}`.trim();
          return text === ""
            ? Effect.void
            : send(call, { type: "caption", speaker: "user", text, final: false });
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning("Discussion transcription failed", {
            discussionId: call.discussionId,
            cause,
          }).pipe(Effect.andThen(closeLine(call))),
        ),
      );
    });

  const onSpeechEnd = Effect.fn("DiscussionService.onSpeechEnd")(function* (call: LiveCall) {
    if (call.voice !== "hearing") return;
    call.voice = "idle";
    const line = call.line;
    const text =
      line === null ? "" : (yield* line.stream.finish.pipe(Effect.orElseSucceed(() => ""))).trim();
    yield* closeLine(call);
    if (text !== "") {
      yield* sendLine(call, text);
    } else if (resumesCutReply({ cut: call.cut, run: callRun(call) })) {
      // A cough or echo: pick the reply back up where the cut left it.
      for (const beat of call.pendingBeats) yield* speak(call, beat);
      call.pendingBeats = [];
    } else {
      call.pendingBeats = [];
    }
    call.cut = false;
    yield* publishPhase(call);
  });

  const onAudio = (call: LiveCall, pcm: Uint8Array) =>
    Effect.suspend(() => {
      if (call.muted) return Effect.void;
      if (call.line !== null) return feedLine(call, pcm);
      call.preRoll.push(pcm);
      call.preRollBytes += pcm.byteLength;
      while (call.preRollBytes > PRE_ROLL_BYTES && call.preRoll.length > 1) {
        call.preRollBytes -= call.preRoll.shift()!.byteLength;
      }
      return Effect.void;
    });

  const onClientFrame = (call: LiveCall, data: string) =>
    decodeClientFrame(data).pipe(
      Effect.flatMap((frame) => {
        switch (frame.type) {
          case "speech_start":
            return onSpeechStart(call);
          case "speech_end":
            return onSpeechEnd(call);
          case "mute":
            call.muted = frame.muted;
            return Effect.void;
        }
      }),
      Effect.ignore,
    );

  /** A call nobody holds for long ends; the client has 30 s to come back after a drop. */
  const armLostTimer = Effect.fn("DiscussionService.armLostTimer")(function* (call: LiveCall) {
    if (yield* Deferred.isDone(call.ended)) return;
    call.lostTimer = yield* Effect.sleep(CLIENT_LOST_AFTER).pipe(
      Effect.andThen(
        end({ threadId: call.threadId, discussionId: call.discussionId, reason: "client_lost" }),
      ),
      Effect.ignore,
      Effect.forkIn(call.scope),
    );
  });

  const detach = Effect.fn("DiscussionService.detach")(function* (
    call: LiveCall,
    writer: Socket.Writer,
  ) {
    if (call.writer !== writer) return;
    call.writer = null;
    call.socketScope = null;
    call.voice = "idle";
    yield* closeLine(call);
    yield* cutSynth(call, { notify: false });
    yield* armLostTimer(call);
  });

  const finishCall = Effect.fn("DiscussionService.finishCall")(function* (
    call: LiveCall,
    reason: DiscussionEndReason,
  ) {
    yield* Ref.update(calls, (map) => {
      if (map.get(call.threadId) !== call) return map;
      const next = new Map(map);
      next.delete(call.threadId);
      return next;
    });
    yield* send(call, { type: "ended", reason });
    if (call.writer !== null) {
      yield* call.writer.write(new Socket.CloseEvent(1000, "Discussion ended")).pipe(Effect.ignore);
    }
    yield* Scope.close(call.scope, Exit.void);
  });

  const watchThread = (call: LiveCall, afterSequence: number) =>
    eventSink.stream({ threadId: call.threadId, afterSequence }).pipe(
      Stream.runForEach((stored) => onThreadEvent(call, stored.event)),
      Effect.catchCause((cause) =>
        Effect.logWarning("Discussion lost the thread's event stream", {
          discussionId: call.discussionId,
          cause,
        }).pipe(Effect.andThen(Deferred.succeed(call.ended, "ended_by_user"))),
      ),
    );

  const start: DiscussionService["Service"]["start"] = Effect.fn("DiscussionService.start")(
    function* (input) {
      const voice = (yield* settings.getSettings.pipe(
        Effect.mapError(() => new DiscussionStartError({ reason: "unavailable" })),
      )).voiceSynthesis;
      if (voice.elevenlabs === "") {
        return yield* new DiscussionStartError({ reason: "voice_not_configured" });
      }
      const discussionId = DiscussionId.make(
        `discussion:${base64UrlEncode(yield* random.randomBytes(16))}`,
      );
      const projection = yield* threads
        .getThreadRecords(input.threadId, ["runs", "runtimeRequests"])
        .pipe(Effect.mapError(() => new DiscussionStartError({ reason: "thread_unavailable" })));
      if (projection.thread.discussion) {
        return yield* new DiscussionStartError({ reason: "already_live" });
      }
      // Read before the start commits, so no event between the two is missed.
      const afterSequence = yield* eventSink
        .latestSequence({ threadId: input.threadId })
        .pipe(Effect.mapError(() => new DiscussionStartError({ reason: "thread_unavailable" })));
      yield* threads
        .dispatch({
          type: "thread.discussion.start",
          commandId: CommandId.make(`command:discussion:${discussionId}:start`),
          threadId: input.threadId,
          discussionId,
          heldBy: input.heldBy,
        })
        .pipe(
          Effect.mapError((cause) =>
            isDispatchFailure(cause) && cause.cause === DISCUSSION_FAILURE.alreadyLive
              ? new DiscussionStartError({ reason: "already_live" })
              : new DiscussionStartError({ reason: "thread_unavailable" }),
          ),
        );
      const scope = yield* Scope.make();
      const now = yield* Clock.currentTimeMillis;
      const call: LiveCall = {
        threadId: input.threadId,
        projectId: projection.thread.projectId,
        discussionId,
        scope,
        ended: yield* Deferred.make<DiscussionEndReason>(),
        endReason: null,
        writer: null,
        socketScope: null,
        lostTimer: null,
        voice: "idle",
        muted: false,
        activeRuns: new Set(
          projection.runs.filter((run) => ACTIVE_RUN_STATUSES.has(run.status)).map((run) => run.id),
        ),
        pendingRequests: new Set(
          projection.runtimeRequests
            .filter((request: OrchestrationV2RuntimeRequest) => request.status === "pending")
            .map((request) => request.id),
        ),
        lastPhase: null,
        beats: startSpeechBeats(
          projection.runs.filter((run) => ACTIVE_RUN_STATUSES.has(run.status)).map((run) => run.id),
        ),
        pendingBeats: [],
        cut: false,
        status: startStatusTimer(now),
        latestTool: null,
        synth: null,
        line: null,
        preRoll: [],
        preRollBytes: 0,
        lineCount: 0,
      };
      yield* Ref.update(calls, (map) => new Map(map).set(input.threadId, call));
      yield* watchThread(call, afterSequence).pipe(Effect.forkIn(scope));
      yield* liveText.subscribe(input.threadId).pipe(
        Stream.runForEach((frame) =>
          frame.kind === "text"
            ? onAssistantText(call, frame)
            : Effect.sync(() => {
                call.latestTool = frame.call;
              }),
        ),
        Effect.forkIn(scope),
      );
      yield* Effect.forever(Effect.sleep(STATUS_TICK).pipe(Effect.andThen(onTick(call)))).pipe(
        Effect.forkIn(scope),
      );
      // Ending runs outside the call's scope, so closing it cannot interrupt the hang-up itself.
      yield* Deferred.await(call.ended).pipe(
        Effect.flatMap((reason) => finishCall(call, reason)),
        Effect.forkIn(serviceScope),
      );
      yield* armLostTimer(call);
      return { discussionId };
    },
  );

  const end: DiscussionService["Service"]["end"] = Effect.fn("DiscussionService.end")(
    function* (input) {
      const call = (yield* Ref.get(calls)).get(input.threadId) ?? null;
      const discussionId =
        input.discussionId ??
        call?.discussionId ??
        (yield* threads.getThreadRecords(input.threadId, []).pipe(
          Effect.map(({ thread }) => thread.discussion?.id),
          Effect.mapError((cause) => new DiscussionEndError({ threadId: input.threadId, cause })),
        ));
      if (discussionId === undefined) return "not_live";
      if (call !== null && call.discussionId === discussionId) call.endReason = input.reason;
      yield* threads
        .dispatch({
          type: "thread.discussion.end",
          commandId: CommandId.make(`command:discussion:${discussionId}:end:${input.reason}`),
          threadId: input.threadId,
          discussionId,
          reason: input.reason,
        })
        .pipe(
          Effect.mapError((cause) => new DiscussionEndError({ threadId: input.threadId, cause })),
        );
      return "ended";
    },
  );

  const attach: DiscussionService["Service"]["attach"] = Effect.fn("DiscussionService.attach")(
    function* (discussionId, socket) {
      const writer = yield* socket.writer;
      const call = yield* findCall(discussionId);
      if (call === null) {
        // The upgrade completes only once reading starts; a write before that never goes out.
        yield* socket.reader;
        yield* writer
          .write(encodeServerFrame({ type: "ended", reason: "ended_by_user" }))
          .pipe(Effect.andThen(writer.write(new Socket.CloseEvent(1000))), Effect.ignore);
        return;
      }
      // A newer device takes the call over; the old socket is told the call ended for it.
      if (call.socketScope !== null) {
        yield* send(call, { type: "ended", reason: "ended_by_user" });
        yield* Scope.close(call.socketScope, Exit.void);
      }
      if (call.lostTimer !== null) {
        yield* Fiber.interrupt(call.lostTimer);
        call.lostTimer = null;
      }
      const socketScope = yield* Scope.fork(call.scope);
      // Reading starts before the first write, which would otherwise wait on the upgrade forever.
      const reader = yield* socket.reader.pipe(Scope.provide(socketScope), Effect.exit);
      call.writer = writer;
      call.socketScope = socketScope;
      call.lastPhase = null;
      yield* publishPhase(call);
      if (Exit.isSuccess(reader)) {
        yield* Effect.gen(function* () {
          while (true) {
            const frames = yield* reader.value.pull;
            for (const frame of frames) {
              yield* typeof frame === "string" ? onClientFrame(call, frame) : onAudio(call, frame);
            }
          }
        }).pipe(Effect.ignore, Effect.forkIn(socketScope), Effect.flatMap(Fiber.await));
      }
      yield* detach(call, writer);
    },
    Effect.scoped,
  );

  const snapshot: DiscussionService["Service"]["snapshot"] = (threadId) =>
    Ref.get(calls).pipe(
      Effect.map((map) => {
        const call = map.get(threadId);
        return call === undefined
          ? null
          : {
              discussionId: call.discussionId,
              phase: callPhase({
                voice: call.voice,
                run: callRun(call),
                freshBeats: freshBeats(call),
              }),
              attached: call.writer !== null,
            };
      }),
    );

  // Boot: a marker left live by a crash has no call behind it any more. Read now, before any
  // call can start here, and end once the server is active.
  const stale = yield* projections.listLiveDiscussions().pipe(Effect.orElseSucceed(() => []));
  yield* forkParked(
    Effect.forEach(
      stale,
      ({ threadId, discussionId }) =>
        Effect.gen(function* () {
          if ((yield* Ref.get(calls)).get(threadId)?.discussionId === discussionId) return;
          yield* end({ threadId, discussionId, reason: "server_restart" });
        }).pipe(Effect.ignore),
      { discard: true },
    ),
  );

  return DiscussionService.of({ start, end, attach, snapshot });
});

export const layer = Layer.effect(DiscussionService, make);
