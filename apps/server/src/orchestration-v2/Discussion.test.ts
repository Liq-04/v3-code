import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DiscussionId,
  type DiscussionEndReason,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for discussions"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "discussion" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const threadId = ThreadId.make("thread:discussion");
const discussionId = DiscussionId.make("discussion:one");

const setup = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-discussion-thread"),
    threadId,
    projectId: ProjectId.make("project:discussion"),
    title: "Talk it through",
    modelSelection: { instanceId, model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("first-message"),
    threadId,
    messageId: MessageId.make("first-message"),
    text: "Hello",
    attachments: [],
    dispatchMode: { type: "defer_start" },
    createdBy: "user",
    creationSource: "web",
  });
  return orchestrator;
});

const start = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  id: string,
  discussion = discussionId,
) =>
  orchestrator.dispatch({
    type: "thread.discussion.start",
    commandId: CommandId.make(id),
    threadId,
    discussionId: discussion,
    heldBy: "desktop",
  });

const end = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  id: string,
  reason: DiscussionEndReason = "ended_by_user",
) =>
  orchestrator.dispatch({
    type: "thread.discussion.end",
    commandId: CommandId.make(id),
    threadId,
    discussionId,
    reason,
  });

const discussionItem = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const { turnItems } = yield* projections.getThreadRecords(threadId, ["turnItems"], {
    turnItemTypes: ["discussion"],
  });
  const item = turnItems.find((candidate) => candidate.type === "discussion");
  return item?.type === "discussion" ? item : undefined;
});

const summaryEffects = (commandId: string) =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    return (yield* outbox.listByCommandId(CommandId.make(commandId))).filter(
      (effect) => effect.request.type === "discussion-summary.generate",
    );
  });

it.effect("starts one call, ends it idempotently and enqueues the summary once", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;

    yield* start(orchestrator, "start-1");
    const started = yield* projections.getThreadProjection(threadId);
    assert.deepInclude(started.thread.discussion, { id: discussionId, heldBy: "desktop" });
    const liveItem = yield* discussionItem;
    assert.equal(liveItem?.discussionStatus, "live");
    // The live item follows the newest run's items so it lands at the end of the timeline.
    assert.equal(liveItem?.runId, started.runs[0]?.id);
    assert.equal((yield* projections.getThreadShell(threadId))?.discussion?.id, discussionId);

    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(start(orchestrator, "start-2", DiscussionId.make("discussion:two"))),
      ),
    );

    yield* end(orchestrator, "end-1");
    assert.isNull((yield* projections.getThread(threadId)).discussion);
    assert.isNull((yield* projections.getThreadShell(threadId))?.discussion);
    assert.equal((yield* discussionItem)?.discussionStatus, "ended");
    const ended = yield* summaryEffects("end-1");
    assert.lengthOf(ended, 1);
    assert.deepInclude(ended[0]?.request, { act: true });

    // End from a second device after the call is over: accepted, nothing changes.
    yield* end(orchestrator, "end-2");
    assert.lengthOf(yield* summaryEffects("end-2"), 0);

    yield* orchestrator.dispatch({
      type: "thread.discussion.summary.record",
      commandId: CommandId.make("record-1"),
      threadId,
      discussionId,
      summary: "They agreed to split the PR.",
    });
    yield* orchestrator.dispatch({
      type: "thread.discussion.summary.record",
      commandId: CommandId.make("record-2"),
      threadId,
      discussionId,
      summary: "A second writer.",
    });
    assert.equal((yield* discussionItem)?.summary, "They agreed to split the PR.");

    // The thread is free for a new call once the old one ended.
    yield* start(orchestrator, "start-3", DiscussionId.make("discussion:two"));
    assert.equal((yield* projections.getThread(threadId)).discussion?.id, "discussion:two");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a server restart ends the call as lost without a summary", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    yield* start(orchestrator, "start-lost");
    yield* end(orchestrator, "end-lost", "server_restart");
    assert.equal((yield* discussionItem)?.discussionStatus, "lost");
    assert.lengthOf(yield* summaryEffects("end-lost"), 0);
    yield* orchestrator.dispatch({
      type: "thread.discussion.summary.record",
      commandId: CommandId.make("record-lost"),
      threadId,
      discussionId,
      summary: "Never shown.",
    });
    assert.isNull((yield* discussionItem)?.summary);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("archiving a thread hangs up its call and still summarizes it", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* start(orchestrator, "start-archive");
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive"),
      threadId,
    });
    assert.isNull((yield* projections.getThread(threadId)).discussion);
    assert.equal((yield* discussionItem)?.discussionStatus, "ended");
    const archived = yield* summaryEffects("archive");
    assert.lengthOf(archived, 1);
    // Archiving is not the user hanging up, so the agent gets no turn to act.
    assert.deepInclude(archived[0]?.request, { act: false });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("deleting a thread ends its call with nothing to summarize into", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* start(orchestrator, "start-delete");
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete"),
      threadId,
    });
    assert.isNull((yield* projections.getThread(threadId)).discussion);
    assert.equal((yield* discussionItem)?.discussionStatus, "ended");
    assert.lengthOf(yield* summaryEffects("delete"), 0);
  }).pipe(Effect.provide(layerTest)),
);
