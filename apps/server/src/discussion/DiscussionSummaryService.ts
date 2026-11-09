import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { discussionTranscript } from "@t3tools/shared/discussion/transcript";
import {
  CommandId,
  type DiscussionId,
  MessageId,
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
 * Runs once a call ended: when the user hung up, queues the turn that acts on the call, then writes
 * its summary. The transcript is derived from the thread's durable messages, so a replay after a
 * crash sees the same lines; each command's id derives from the effect's, so a replay cannot send
 * or write twice.
 */
export class DiscussionSummaryService extends Context.Service<
  DiscussionSummaryService,
  {
    readonly execute: (input: {
      readonly threadId: ThreadId;
      readonly discussionId: DiscussionId;
      /** The user hung up, so the agent gets a turn to do what the call agreed on. */
      readonly act: boolean;
      readonly requestId: CommandId;
    }) => Effect.Effect<
      void,
      | OrchestratorV2Error
      | ServerSettingsError
      | ThreadManagementService.ThreadManagementProviderInstanceDisabledError
    >;
  }
>()("t3/discussion/DiscussionSummaryService") {}

const HANDOFF_TEXT =
  "I hung up. Now do what we agreed on the call. If I didn't ask for anything, reply in one sentence.";

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
    if (input.act && transcript.length > 0) {
      // Queued, so a reply still running from the call finishes first; the new turn resolves its
      // mode when it starts, after the call's Plan mode has lifted.
      yield* threads
        .sendToThread({
          projectId: projection.thread.projectId,
          commandId: CommandId.make(`${input.requestId}:discussion-handoff`),
          threadId: input.threadId,
          messageId: MessageId.make(`message:discussion:${input.discussionId}:handoff`),
          text: HANDOFF_TEXT,
          attachments: [],
          mode: "queue",
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("Discussion handoff was not delivered", {
                  threadId: input.threadId,
                  discussionId: input.discussionId,
                  cause,
                }),
          ),
        );
    }
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
