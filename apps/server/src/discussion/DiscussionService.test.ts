import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  type DiscussionClientFrame,
  DiscussionServerFrame,
  MessageId,
  NodeId,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  type ThreadId,
  ThreadId as ThreadIdSchema,
  TurnItemId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as LiveAssistantTextHub from "../orchestration-v2/LiveAssistantTextHub.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SpeechService from "../speech/SpeechService.ts";
import * as DiscussionService from "./DiscussionService.ts";
import * as ElevenLabsSynth from "./ElevenLabsSynth.ts";

const projectId = ProjectId.make("project:discussion-service");
const threadId: ThreadId = ThreadIdSchema.make("thread:discussion-service");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;
const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in discussion tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const decodeServerFrame = Schema.decodeUnknownSync(Schema.fromJsonString(DiscussionServerFrame));
const encodeClientFrame = (frame: DiscussionClientFrame) => JSON.stringify(frame);

interface FakeSynthSession {
  readonly said: Array<string>;
  finished: boolean;
  closed: boolean;
}

/** The synthesizer and the client's socket, scripted and observed through queues, never timers. */
const makeFakes = Effect.gen(function* () {
  const sessions: Array<FakeSynthSession> = [];
  const opened = yield* Queue.unbounded<FakeSynthSession>();
  const said = yield* Queue.unbounded<string>();
  const layerSynth = Layer.succeed(
    ElevenLabsSynth.DiscussionSynth,
    ElevenLabsSynth.DiscussionSynth.of({
      open: () =>
        Effect.gen(function* () {
          const audio = yield* Queue.unbounded<Uint8Array, Cause.Done>();
          const session: FakeSynthSession = { said: [], finished: false, closed: false };
          sessions.push(session);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              session.closed = true;
            }).pipe(Effect.andThen(Queue.end(audio))),
          );
          yield* Queue.offer(opened, session);
          return {
            say: (text) =>
              Effect.sync(() => {
                session.said.push(text);
              }).pipe(Effect.andThen(Queue.offer(said, text))),
            finish: Effect.sync(() => {
              session.finished = true;
            }).pipe(Effect.andThen(Queue.end(audio)), Effect.asVoid),
            audio: Stream.fromQueue(audio),
          } satisfies ElevenLabsSynth.SynthSession;
        }),
    }),
  );

  const transcript = yield* Ref.make("");
  const fed: Array<Uint8Array> = [];
  const layerSpeech = Layer.mock(SpeechService.SpeechService)({
    startStream: () =>
      Effect.succeed({
        feed: (pcm) =>
          Effect.sync(() => {
            fed.push(pcm);
            return { revision: fed.length, text: { committed: "", tentative: "…" } };
          }),
        finish: Ref.get(transcript),
      } satisfies SpeechService.SpeechStream),
  });

  return { sessions, opened, said, layerSynth, transcript, fed, layerSpeech };
});

const makeSocket = Effect.gen(function* () {
  const inbound = yield* Queue.unbounded<string | Uint8Array, Cause.Done>();
  const outbound = yield* Queue.unbounded<string | Uint8Array | Socket.CloseEvent>();
  const closeError = new Socket.SocketError({
    reason: new Socket.SocketCloseError({ code: 1000 }),
  });
  // Like a real upgrade: the handshake completes, and writes go out, only once reading starts.
  const reading = yield* Deferred.make<void>();
  const socket = Socket.make({
    reader: Deferred.succeed(reading, undefined).pipe(
      Effect.as({
        pull: Queue.take(inbound).pipe(
          Effect.map((frame) => [frame] as const),
          Effect.mapError(() => closeError),
        ),
        upgrade: () => Effect.fail(closeError),
      }),
    ),
    writer: Effect.succeed({
      write: (chunk) =>
        Deferred.await(reading).pipe(Effect.andThen(Queue.offer(outbound, chunk)), Effect.asVoid),
      writeAll: (chunks) =>
        Deferred.await(reading).pipe(
          Effect.andThen(Queue.offerAll(outbound, chunks)),
          Effect.asVoid,
        ),
    }),
  });
  const nextFrame = Queue.take(outbound).pipe(
    Effect.flatMap((chunk) =>
      typeof chunk === "string"
        ? Effect.succeed(decodeServerFrame(chunk))
        : Effect.die(`expected a JSON frame, got ${chunk.constructor.name}`),
    ),
  );
  const send = (frame: DiscussionClientFrame) => Queue.offer(inbound, encodeClientFrame(frame));
  const sendAudio = (pcm: Uint8Array) => Queue.offer(inbound, pcm);
  const hangUp = Queue.end(inbound);
  return { socket, outbound, nextFrame, send, sendAudio, hangUp };
});

type Fakes = Effect.Success<typeof makeFakes>;
type Client = Effect.Success<typeof makeSocket>;

function makeLayer(fakes: Fakes, voiceKey = "elevenlabs-key") {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "discussion-service" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerServerSettings = ServerSettings.layerTest({
    voiceSynthesis: { elevenlabs: voiceKey, voiceId: "" },
  });
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  );
  const layerProjections = ProjectionStore.layer.pipe(Layer.provide(layerDatabase));
  const layerDiscussion = DiscussionService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerThreadManagement,
        layerOrchestrator,
        layerProjections,
        fakes.layerSpeech,
        fakes.layerSynth,
        LiveAssistantTextHub.layer,
        layerServerSettings,
        NodeCrypto.layer,
      ),
    ),
  );
  return Layer.mergeAll(
    layerDiscussion,
    layerThreadManagement,
    layerOrchestrator,
    layerProjections,
    LiveAssistantTextHub.layer,
    IdAllocator.layer,
    NodeServices.layer,
  );
}

const createThread = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  yield* threads.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create"),
    threadId,
    projectId,
    title: "Talk it through",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return threads;
});

const assistantItem = (
  runId: RunId,
  text: string,
  complete: boolean,
  messageId = MessageId.make("message:reply"),
): OrchestrationV2TurnItem => ({
  id: TurnItemId.make(`turn-item:${messageId}`),
  threadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: complete ? "completed" : "running",
  title: null,
  startedAt: DateTime.makeUnsafe(0),
  completedAt: null,
  updatedAt: DateTime.makeUnsafe(0),
  type: "assistant_message",
  messageId,
  text,
  streaming: !complete,
});

/** A call with its socket attached, past the opening phase frame. */
const startCall = Effect.gen(function* () {
  const discussions = yield* DiscussionService.DiscussionService;
  const { discussionId } = yield* discussions.start({ threadId, heldBy: "desktop" });
  const client = yield* makeSocket;
  yield* discussions.attach(discussionId, client.socket).pipe(Effect.forkScoped);
  assert.deepEqual(yield* client.nextFrame, { type: "phase", phase: "listening" });
  return { discussions, discussionId, client };
});

const speakLine = (client: Client, fakes: Fakes, text: string) =>
  Effect.gen(function* () {
    yield* Ref.set(fakes.transcript, text);
    yield* client.send({ type: "speech_start" });
    assert.deepEqual(yield* client.nextFrame, { type: "phase", phase: "hearing" });
    yield* client.sendAudio(new Uint8Array(new Int16Array([16_384, -16_384]).buffer));
    yield* client.send({ type: "speech_end" });
    assert.deepEqual(yield* client.nextFrame, {
      type: "caption",
      speaker: "user",
      text: "…",
      final: false,
    });
    assert.deepEqual(yield* client.nextFrame, {
      type: "caption",
      speaker: "user",
      text,
      final: true,
    });
    assert.deepEqual(yield* client.nextFrame, { type: "phase", phase: "thinking" });
  });

it.effect(
  "a spoken line reaches the agent framed and attributed, and stale text is never spoken",
  () =>
    Effect.gen(function* () {
      const fakes = yield* makeFakes;
      yield* Effect.gen(function* () {
        const threads = yield* createThread;
        const hub = yield* LiveAssistantTextHub.LiveAssistantTextHub;
        const { discussionId, client } = yield* startCall;

        // The agent is still writing from an earlier turn while the user starts talking.
        yield* client.send({ type: "speech_start" });
        assert.deepEqual(yield* client.nextFrame, { type: "phase", phase: "hearing" });
        yield* hub.observe(
          assistantItem(
            RunId.make("run:old"),
            "Let me look at that. ",
            false,
            MessageId.make("message:old"),
          ),
        );
        yield* client.sendAudio(new Uint8Array(new Int16Array([16_384, -16_384]).buffer));
        yield* Ref.set(fakes.transcript, "Run the tests");
        yield* client.send({ type: "speech_end" });

        assert.deepEqual(yield* client.nextFrame, {
          type: "caption",
          speaker: "user",
          text: "…",
          final: false,
        });
        assert.deepEqual(yield* client.nextFrame, {
          type: "caption",
          speaker: "user",
          text: "Run the tests",
          final: true,
        });
        assert.deepEqual(yield* client.nextFrame, { type: "phase", phase: "thinking" });
        // The synthesizer connects as soon as the line is sent.
        yield* Queue.take(fakes.opened);

        const { messages, runs } = yield* threads.getThreadRecords(threadId, ["messages", "runs"]);
        const line = messages.find((message) => message.role === "user");
        assert.deepEqual(line?.context?.discussion, { discussionId, spoken: "Run the tests" });
        assert.equal(line?.text, DiscussionService.frameSpokenLine("Run the tests"));
        assert.equal(runs.length, 1);
        // Audio reached transcription as 16 kHz Float32, pre-roll included.
        assert.deepEqual(Array.from(new Float32Array(fakes.fed[0]!.buffer)), [0.5, -0.5]);

        const runId = runs[0]!.id;
        yield* hub.observe(assistantItem(runId, "Running the tests now. ", false));
        assert.equal(yield* Queue.take(fakes.said), "Running the tests now.");
        assert.deepEqual(yield* client.nextFrame, { type: "phase", phase: "speaking" });
        assert.deepEqual(yield* client.nextFrame, {
          type: "caption",
          speaker: "agent",
          text: "Running the tests now.",
          final: false,
        });
        assert.deepEqual(
          fakes.sessions.flatMap((session) => session.said),
          ["Running the tests now."],
        );
      }).pipe(Effect.provide(makeLayer(fakes)), Effect.scoped);
    }),
);

it.effect("talking over the agent cuts its voice, and a noise resumes the reply", () =>
  Effect.gen(function* () {
    const fakes = yield* makeFakes;
    yield* Effect.gen(function* () {
      const threads = yield* createThread;
      const hub = yield* LiveAssistantTextHub.LiveAssistantTextHub;
      const { client } = yield* startCall;
      yield* speakLine(client, fakes, "Run the tests");
      const first = yield* Queue.take(fakes.opened);
      const runId = (yield* threads.getThreadRecords(threadId, ["runs"])).runs[0]!.id;
      yield* hub.observe(assistantItem(runId, "Running them. This may take a moment. ", false));
      assert.equal(yield* Queue.take(fakes.said), "Running them.");
      assert.equal(yield* Queue.take(fakes.said), "This may take a moment.");
      yield* client.nextFrame; // phase speaking
      yield* client.nextFrame; // caption
      yield* client.nextFrame; // caption

      yield* client.send({ type: "speech_start" });
      assert.deepEqual(yield* client.nextFrame, { type: "cut" });
      assert.deepEqual(yield* client.nextFrame, { type: "phase", phase: "hearing" });
      assert.isTrue(first.closed);
      // Written while the user talks: held back, then resumed when the "line" was only a cough.
      yield* hub.observe(
        assistantItem(runId, "Running them. This may take a moment. Two suites failed. ", false),
      );
      yield* Ref.set(fakes.transcript, "");
      yield* client.send({ type: "speech_end" });
      assert.equal(yield* Queue.take(fakes.said), "Two suites failed.");
      assert.equal(fakes.sessions.length, 2);
    }).pipe(Effect.provide(makeLayer(fakes)), Effect.scoped);
  }),
);

it.effect("a pending approval is spoken once and shown as waiting", () =>
  Effect.gen(function* () {
    const fakes = yield* makeFakes;
    yield* Effect.gen(function* () {
      yield* createThread;
      const eventSink = yield* EventSink.EventSinkV2;
      const ids = yield* IdAllocator.IdAllocatorV2;
      const { client } = yield* startCall;
      const now = yield* DateTime.now;
      const requestId = RuntimeRequestId.make("runtime-request:approve");
      yield* eventSink.write({
        events: [
          {
            id: yield* ids.allocate.event({ threadId }),
            type: "runtime-request.updated",
            threadId,
            nodeId: NodeId.make("node:approve"),
            occurredAt: now,
            payload: {
              id: requestId,
              nodeId: NodeId.make("node:approve"),
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "command",
              status: "pending",
              responseCapability: { type: "message" },
              createdAt: now,
              resolvedAt: null,
            },
          },
        ],
      });
      assert.equal(yield* Queue.take(fakes.said), "I need your approval to continue.");
      assert.deepEqual(yield* client.nextFrame, { type: "phase", phase: "waiting" });
    }).pipe(Effect.provide(makeLayer(fakes)), Effect.scoped);
  }),
);

it.effect("end hangs up from any caller without waiting on the run, and again is a no-op", () =>
  Effect.gen(function* () {
    const fakes = yield* makeFakes;
    yield* Effect.gen(function* () {
      const threads = yield* createThread;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { discussions, client } = yield* startCall;
      yield* speakLine(client, fakes, "Keep going");
      yield* Queue.take(fakes.opened);

      yield* discussions.end({ threadId, reason: "ended_by_user" });
      assert.deepEqual(yield* client.nextFrame, { type: "ended", reason: "ended_by_user" });
      assert.instanceOf(yield* Queue.take(client.outbound), Socket.CloseEvent);
      assert.isNull(yield* discussions.snapshot(threadId));
      assert.isNull((yield* projections.getThread(threadId)).discussion);
      // The agent's run is left alone.
      const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
      assert.notInclude(["completed", "interrupted", "cancelled"], runs[0]!.status);

      yield* discussions.end({ threadId, reason: "ended_by_user" });
      // The thread is free again.
      yield* discussions.start({ threadId, heldBy: "desktop" });
    }).pipe(Effect.provide(makeLayer(fakes)), Effect.scoped);
  }),
);

it.effect("a socket gone for 30 seconds ends the call as lost by the client", () =>
  Effect.gen(function* () {
    const fakes = yield* makeFakes;
    yield* Effect.gen(function* () {
      yield* createThread;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { discussions, client } = yield* startCall;
      yield* client.hangUp;
      yield* TestClock.adjust("29 seconds");
      assert.isNotNull(yield* discussions.snapshot(threadId));
      yield* TestClock.adjust("1 second");
      assert.isNull(yield* discussions.snapshot(threadId));
      assert.isNull((yield* projections.getThread(threadId)).discussion);
    }).pipe(Effect.provide(makeLayer(fakes)), Effect.scoped);
  }),
);

it.effect("starting needs a voice key and a thread not already on a call", () =>
  Effect.gen(function* () {
    const fakes = yield* makeFakes;
    yield* Effect.gen(function* () {
      yield* createThread;
      const discussions = yield* DiscussionService.DiscussionService;
      const missing = yield* Effect.flip(discussions.start({ threadId, heldBy: "desktop" }));
      assert.equal(missing.reason, "voice_not_configured");
    }).pipe(Effect.provide(makeLayer(fakes, "")), Effect.scoped);
    yield* Effect.gen(function* () {
      yield* createThread;
      const discussions = yield* DiscussionService.DiscussionService;
      yield* discussions.start({ threadId, heldBy: "desktop" });
      const live = yield* Effect.flip(discussions.start({ threadId, heldBy: "phone" }));
      assert.equal(live.reason, "already_live");
    }).pipe(Effect.provide(makeLayer(fakes)), Effect.scoped);
  }),
);
