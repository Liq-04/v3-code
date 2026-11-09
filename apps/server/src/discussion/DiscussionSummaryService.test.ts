import { assert, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DiscussionId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  TextGenerationError,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as DiscussionSummaryService from "./DiscussionSummaryService.ts";

const projectId = ProjectId.make("project:discussion-summary");
const threadId = ThreadId.make("thread:discussion-summary");
const discussionId = DiscussionId.make("discussion:summary");
const requestId = CommandId.make("command:end-call");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in summary tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

function makeHarness(
  generateDiscussionSummary: TextGeneration.TextGeneration["Service"]["generateDiscussionSummary"],
) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "discussion-summary" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerServerSettings = ServerSettings.layerTest({});
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  );
  const generate = vi.fn(generateDiscussionSummary);
  const layerSummary = DiscussionSummaryService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerThreadManagement,
        Layer.mock(TextGeneration.TextGeneration)({ generateDiscussionSummary: generate }),
        layerServerSettings,
        NodeServices.layer,
      ),
    ),
  );
  return {
    layer: Layer.mergeAll(layerOrchestrator, layerThreadManagement, layerSummary, layerDatabase),
    generate,
  };
}

/** A thread whose call carried one spoken line, then ended. */
const endedCall = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  yield* threads.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create"),
    threadId,
    projectId,
    title: "Seed title",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* threads.dispatch({
    type: "thread.discussion.start",
    commandId: CommandId.make("start"),
    threadId,
    discussionId,
    heldBy: "desktop",
  });
  yield* threads.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("line"),
    threadId,
    messageId: MessageId.make("line"),
    text: "Spoken in a voice discussion: Should we split the PR?",
    context: {
      version: 1,
      records: [],
      discussion: { discussionId, spoken: "Should we split the PR?" },
    },
    attachments: [],
    dispatchMode: { type: "defer_start" },
    createdBy: "user",
    creationSource: "web",
  });
  yield* threads.dispatch({
    type: "thread.discussion.end",
    commandId: requestId,
    threadId,
    discussionId,
    reason: "ended_by_user",
  });
  return threads;
});

const summaryOf = (threads: ThreadManagement.ThreadManagementService["Service"]) =>
  threads.getThreadRecords(threadId, ["turnItems"], { turnItemTypes: ["discussion"] }).pipe(
    Effect.map(({ turnItems }) => {
      const item = turnItems[0];
      return item?.type === "discussion" ? item.summary : undefined;
    }),
  );

it.effect("summarizes the derived transcript and records it once across replays", () =>
  Effect.gen(function* () {
    const harness = makeHarness((input) =>
      Effect.succeed({
        summary: `They discussed: ${input.transcript.map((line) => line.text).join(" ")}`,
      }),
    );
    yield* Effect.gen(function* () {
      const threads = yield* endedCall;
      const summary = yield* DiscussionSummaryService.DiscussionSummaryService;
      yield* summary.execute({ threadId, discussionId, requestId });
      // The effect worker replays after a process loss.
      yield* summary.execute({ threadId, discussionId, requestId });
      assert.equal(yield* summaryOf(threads), "They discussed: Should we split the PR?");
      assert.equal(harness.generate.mock.calls.length, 1);
      const [input] = harness.generate.mock.calls[0]!;
      assert.deepEqual(input.transcript, [{ speaker: "user", text: "Should we split the PR?" }]);
      assert.notEqual(input.cwd, "/repo");
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("records a null summary when generation fails", () =>
  Effect.gen(function* () {
    const harness = makeHarness(() =>
      Effect.fail(
        new TextGenerationError({ operation: "generateDiscussionSummary", detail: "down" }),
      ),
    );
    yield* Effect.gen(function* () {
      const threads = yield* endedCall;
      const summary = yield* DiscussionSummaryService.DiscussionSummaryService;
      yield* summary.execute({ threadId, discussionId, requestId });
      assert.isNull(yield* summaryOf(threads));
    }).pipe(Effect.provide(harness.layer));
  }),
);
