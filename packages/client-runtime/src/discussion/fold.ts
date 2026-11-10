import type { DiscussionId, OrchestrationV2TurnItem, RunId } from "@t3tools/contracts";
import { htmlRenderFromToolItem, mcpAppFromToolItem } from "@t3tools/shared/toolOutput";
import * as DateTime from "effect/DateTime";

const itemAt = (item: OrchestrationV2TurnItem) =>
  DateTime.toEpochMillis(item.startedAt ?? item.updatedAt);

/** Tool work a call card shows. Requests, plans, and other event items stay in the timeline. */
function isCallToolWork(item: OrchestrationV2TurnItem): boolean {
  switch (item.type) {
    case "reasoning":
    case "command_execution":
    case "file_change":
    case "file_search":
    case "web_search":
      return true;
    case "dynamic_tool":
      return (
        (item.status !== "completed" || htmlRenderFromToolItem(item) === undefined) &&
        mcpAppFromToolItem(item) === undefined
      );
    default:
      return false;
  }
}

export interface DiscussionFold {
  /** The spoken lines and the agent's replies, by message id. */
  readonly messageIds: ReadonlySet<string>;
  /** The agent's tool work, by turn item id, with the call whose card shows it. */
  readonly toolItems: ReadonlyMap<string, DiscussionId>;
}

/**
 * What a discussion card shows as its transcript, so the timeline leaves it out: the spoken lines,
 * and the agent's replies and tool work in their runs from the first line on. The messages follow
 * the same rule as `discussionTranscript`, over turn items.
 */
export function discussionFold(
  items: ReadonlyArray<{ readonly item: OrchestrationV2TurnItem }>,
): DiscussionFold {
  const firstLineInRun = new Map<
    RunId,
    { readonly at: number; readonly discussionId: DiscussionId }
  >();
  const messageIds = new Set<string>();
  const toolItems = new Map<string, DiscussionId>();
  for (const { item } of items) {
    if (item.type !== "user_message" || item.context?.discussion === undefined) continue;
    messageIds.add(item.messageId);
    if (item.runId === null) continue;
    const at = itemAt(item);
    const first = firstLineInRun.get(item.runId);
    if (first === undefined || at < first.at) {
      firstLineInRun.set(item.runId, { at, discussionId: item.context.discussion.discussionId });
    }
  }
  if (firstLineInRun.size === 0) return { messageIds, toolItems };
  for (const { item } of items) {
    if (item.runId === null) continue;
    const first = firstLineInRun.get(item.runId);
    if (first === undefined || itemAt(item) < first.at) continue;
    if (item.type === "assistant_message") messageIds.add(item.messageId);
    else if (isCallToolWork(item)) toolItems.set(item.id, first.discussionId);
  }
  return { messageIds, toolItems };
}
