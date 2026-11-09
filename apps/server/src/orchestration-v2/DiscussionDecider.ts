import {
  type DiscussionEndReason,
  type DiscussionId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2TurnItem,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

export type DiscussionCommand = Extract<
  OrchestrationV2ServerCommand,
  {
    readonly type:
      | "thread.discussion.start"
      | "thread.discussion.end"
      | "thread.discussion.summary.record";
  }
>;

export type DiscussionTurnItem = Extract<OrchestrationV2TurnItem, { readonly type: "discussion" }>;

export const DISCUSSION_FAILURE = {
  alreadyLive: "This thread is already on a call.",
  archived: "Archived threads cannot start a discussion.",
  unknown: "This thread has no such discussion.",
} as const;

export interface DiscussionDecision {
  readonly thread: OrchestrationV2AppThread;
  /** The timeline item to write, when it changed. */
  readonly item: DiscussionTurnItem | null;
  /**
   * The call ended and gets a summary. `act` when the user hung up: the agent then carries out
   * what the call agreed on.
   */
  readonly afterCall: { readonly act: boolean } | null;
}

export function discussionTurnItemId(discussionId: DiscussionId): TurnItemId {
  return TurnItemId.make(`turn-item:discussion:${discussionId}`);
}

const isDiscussionItem = (item: OrchestrationV2TurnItem): item is DiscussionTurnItem =>
  item.type === "discussion";

function findItem(items: ReadonlyArray<OrchestrationV2TurnItem>, discussionId: DiscussionId) {
  return items.find(
    (item): item is DiscussionTurnItem =>
      isDiscussionItem(item) && item.discussionId === discussionId,
  );
}

/**
 * Ends a call: clears the marker and settles its item. Nothing to do when the call is already
 * over, so End from a second device, MCP, archive and delete are all idempotent. A server restart
 * ends the call as `lost`, with no summary.
 */
function endDiscussion(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly discussionId: DiscussionId;
  readonly reason: DiscussionEndReason;
  readonly now: DateTime.Utc;
}): DiscussionDecision | null {
  const { thread, discussionId, reason, now } = input;
  const live = thread.discussion ?? null;
  const clearsMarker = live !== null && live.id === discussionId;
  const item = findItem(input.items, discussionId);
  const endsItem = item !== undefined && item.discussionStatus === "live";
  if (!clearsMarker && !endsItem) return null;
  const lost = reason === "server_restart";
  return {
    thread: clearsMarker ? { ...thread, discussion: null, updatedAt: now } : thread,
    item: endsItem
      ? {
          ...item,
          status: "completed",
          discussionStatus: lost ? "lost" : "ended",
          completedAt: now,
          updatedAt: now,
        }
      : null,
    afterCall: endsItem && !lost ? { act: reason === "ended_by_user" } : null,
  };
}

/** Ends whatever call the thread holds, for archive and delete. */
export function closeLiveDiscussion(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly now: DateTime.Utc;
}): DiscussionDecision | null {
  const live = input.thread.discussion ?? null;
  return live === null
    ? null
    : endDiscussion({ ...input, discussionId: live.id, reason: "thread_closed" });
}

/**
 * Applies a discussion command. The orchestrator runs commands one at a time, so the marker check
 * here is what keeps a thread on one call. The live item sits after the newest run's items; the
 * position store gives it its ordinal.
 */
export function decideDiscussionCommand(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly command: DiscussionCommand;
  readonly now: DateTime.Utc;
}): Result.Result<DiscussionDecision, string> {
  const { thread, command, now } = input;
  switch (command.type) {
    case "thread.discussion.start": {
      if (thread.archivedAt !== null) return Result.fail(DISCUSSION_FAILURE.archived);
      if (thread.discussion) return Result.fail(DISCUSSION_FAILURE.alreadyLive);
      const latestRun = input.runs
        .filter((run) => run.status !== "rolled_back")
        .toSorted((left, right) => right.ordinal - left.ordinal)[0];
      return Result.succeed({
        thread: {
          ...thread,
          discussion: {
            id: command.discussionId,
            startedAt: DateTime.formatIso(now),
            heldBy: command.heldBy,
          },
          updatedAt: now,
        },
        item: {
          id: discussionTurnItemId(command.discussionId),
          threadId: thread.id,
          runId: latestRun?.id ?? null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          status: "idle",
          title: "Voice discussion",
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "discussion",
          discussionId: command.discussionId,
          discussionStatus: "live",
          summary: null,
        },
        afterCall: null,
      });
    }
    case "thread.discussion.end": {
      const decision = endDiscussion({
        thread,
        items: input.items,
        discussionId: command.discussionId,
        reason: command.reason,
        now,
      });
      return Result.succeed(decision ?? { thread, item: null, afterCall: null });
    }
    case "thread.discussion.summary.record": {
      const item = findItem(input.items, command.discussionId);
      if (item === undefined) return Result.fail(DISCUSSION_FAILURE.unknown);
      // A live call has no summary yet, a lost one never gets one, and a recorded one is final.
      if (item.discussionStatus !== "ended" || item.summary !== null || item.status === "failed") {
        return Result.succeed({ thread, item: null, afterCall: null });
      }
      return Result.succeed({
        thread,
        item: {
          ...item,
          summary: command.summary,
          // `failed` tells clients the summary will not come; `completed` with no summary is pending.
          status: command.summary === null ? "failed" : item.status,
          updatedAt: now,
        },
        afterCall: null,
      });
    }
  }
}
