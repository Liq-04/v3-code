import type { OrchestrationV2TurnItem, RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const itemAt = (item: OrchestrationV2TurnItem) =>
  DateTime.toEpochMillis(item.startedAt ?? item.updatedAt);

/**
 * The messages a discussion item shows as its transcript, so the timeline leaves them out: the
 * spoken lines, and the agent's replies in their runs from the first line on. The same rule as
 * `discussionTranscript`, over turn items.
 */
export function discussionLineMessageIds(
  items: ReadonlyArray<{ readonly item: OrchestrationV2TurnItem }>,
): ReadonlySet<string> {
  const firstLineInRun = new Map<RunId, number>();
  const ids = new Set<string>();
  for (const { item } of items) {
    if (item.type !== "user_message" || item.context?.discussion === undefined) continue;
    ids.add(item.messageId);
    if (item.runId === null) continue;
    const at = itemAt(item);
    firstLineInRun.set(item.runId, Math.min(at, firstLineInRun.get(item.runId) ?? at));
  }
  if (firstLineInRun.size === 0) return ids;
  for (const { item } of items) {
    if (item.type !== "assistant_message" || item.runId === null) continue;
    const firstLine = firstLineInRun.get(item.runId);
    if (firstLine !== undefined && itemAt(item) >= firstLine) ids.add(item.messageId);
  }
  return ids;
}
