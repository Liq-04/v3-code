import { discussionFold } from "@t3tools/client-runtime/discussion";
import type { DiscussionId } from "@t3tools/contracts";
import { useState } from "react";
import {
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  type TimelineEntriesInput,
  type TimelineEntriesProjection,
  type WorkLogEntry,
} from "../session-logic";

function sameInput(left: TimelineEntriesInput, right: TimelineEntriesInput): boolean {
  return (
    left.visibleTurnItems === right.visibleTurnItems &&
    left.optimisticMessages === right.optimisticMessages &&
    left.anchoredMessages === right.anchoredMessages &&
    left.attachmentUrlById === right.attachmentUrlById &&
    left.attempts === right.attempts &&
    left.nodes === right.nodes &&
    left.plans === right.plans
  );
}

type TimelineEntries = TimelineEntriesProjection["entries"];

function sameEntries(
  left: ReadonlyArray<WorkLogEntry> | undefined,
  right: ReadonlyArray<WorkLogEntry>,
): boolean {
  return left?.length === right.length && left.every((entry, index) => entry === right[index]);
}

/**
 * A discussion's lines and tool work show inside its card, so the timeline leaves them out and
 * hands the work to the card. A card whose work did not change keeps its previous entry.
 */
function withoutDiscussionFolds(
  input: TimelineEntriesInput,
  entries: TimelineEntries,
  previous: TimelineEntries,
): TimelineEntries {
  const fold = discussionFold(input.visibleTurnItems);
  if (fold.messageIds.size === 0 && fold.toolItems.size === 0) return entries;
  const workByDiscussion = new Map<DiscussionId, WorkLogEntry[]>();
  const visible: TimelineEntries = [];
  for (const entry of entries) {
    if (entry.kind === "message" && fold.messageIds.has(entry.id)) continue;
    const discussionId = entry.kind === "work" ? fold.toolItems.get(entry.id) : undefined;
    if (entry.kind !== "work" || discussionId === undefined) {
      visible.push(entry);
      continue;
    }
    const work = workByDiscussion.get(discussionId);
    if (work === undefined) workByDiscussion.set(discussionId, [entry.entry]);
    else work.push(entry.entry);
  }
  if (workByDiscussion.size === 0) return visible;
  const previousById = new Map(previous.map((entry) => [entry.id, entry]));
  return visible.map((entry) => {
    const item = entry.kind === "event" ? entry.projectedItem.item : undefined;
    const callWork =
      item?.type === "discussion" ? workByDiscussion.get(item.discussionId) : undefined;
    if (entry.kind !== "event" || callWork === undefined) return entry;
    const before = previousById.get(entry.id);
    return before?.kind === "event" &&
      before.projectedItem === entry.projectedItem &&
      sameEntries(before.callWork, callWork)
      ? before
      : { ...entry, callWork };
  });
}

export function useIncrementalTimelineEntries(
  threadKey: string | null,
  input: TimelineEntriesInput,
): TimelineEntries {
  const [state, setState] = useState(() => {
    const projection = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
    return {
      threadKey,
      projection,
      visible: withoutDiscussionFolds(input, projection.entries, []),
    };
  });
  if (state.threadKey === threadKey && sameInput(state.projection.input, input)) {
    return state.visible;
  }
  const projection = deriveTimelineEntriesFromVisibleTurnItemsWithState(
    input,
    state.threadKey === threadKey ? state.projection : null,
  );
  const visible = withoutDiscussionFolds(input, projection.entries, state.visible);
  setState({ threadKey, projection, visible });
  return visible;
}
