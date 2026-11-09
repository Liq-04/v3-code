import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { discussionTranscript } from "@t3tools/shared/discussion/transcript";
import {
  CommandId,
  type DiscussionId,
  type ServerSettingsError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import type { OrchestratorV2Error } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";

/**
 * Writes a call's summary once it ended. The transcript is derived from the thread's durable
 * messages, so a replay after a crash summarizes the same lines; the record command's id derives
 * from the effect's, so a replay cannot write twice.
 */
export class DiscussionSummaryService extends Context.Service<
  DiscussionSummaryService,
  {
    readonly execute: (input: {
      readonly threadId: ThreadId;
      readonly discussionId: DiscussionId;
      readonly requestId: CommandId;
    }) => Effect.Effect<
      void,
      | OrchestratorV2Error
      | ServerSettingsError
      | ThreadManagementService.ThreadManagementProviderInstanceDisabledError
    >;
  }
>()("t3/discussion/DiscussionSummaryService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const fileSystem = yield* FileSystem.FileSystem;

  const execute: DiscussionSummaryService["Service"]["execute"] = Effect.fn(
    "DiscussionSummaryService.execute",
  )(function* (input) {
    const projection = yield* threads.getThreadRecords(input.threadId, ["messages", "turnItems"], {
      messageRoles: ["user", "assistant"],
      turnItemTypes: ["discussion"],
    });
    const item = projection.turnItems.find(
      (candidate) =>
        candidate.type === "discussion" && candidate.discussionId === input.discussionId,
    );
    if (item?.type !== "discussion" || item.discussionStatus !== "ended" || item.summary !== null) {
      return;
    }
    const transcript = discussionTranscript(
      projection.messages.filter((message) => !message.streaming),
      input.discussionId,
    );
    const summary =
      transcript.length === 0
        ? null
        : yield* Effect.gen(function* () {
            const settings = resolveProjectSettings(
              yield* serverSettings.getSettings,
              projection.thread.projectId,
            ).settings;
            // The summary reads the transcript alone; the provider must not see a checkout.
            const cwd = yield* fileSystem.makeTempDirectoryScoped({
              prefix: "t3-discussion-summary-",
            });
            const generated = yield* textGeneration.generateDiscussionSummary({
              cwd,
              transcript: transcript.map(({ speaker, text }) => ({ speaker, text })),
              modelSelection: settings.textGenerationModelSelection,
            });
            return generated.summary === "" ? null : generated.summary;
          }).pipe(
            Effect.scoped,
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning("Discussion summary generation failed", {
                    threadId: input.threadId,
                    discussionId: input.discussionId,
                    cause,
                  }).pipe(Effect.as(null)),
            ),
          );
    yield* threads.dispatch({
      type: "thread.discussion.summary.record",
      commandId: CommandId.make(`${input.requestId}:discussion-summary`),
      threadId: input.threadId,
      discussionId: input.discussionId,
      summary,
    });
  });

  return DiscussionSummaryService.of({ execute });
});

export const layer = Layer.effect(DiscussionSummaryService, make);
