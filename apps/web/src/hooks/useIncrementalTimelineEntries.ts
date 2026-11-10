import { discussionFold } from "@t3tools/client-runtime/discussion";
import { useState } from "react";
import {
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  type TimelineEntriesInput,
  type TimelineEntriesProjection,
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

/** A discussion's lines show inside its item, so the timeline leaves them out. */
function withoutDiscussionLines(
  input: TimelineEntriesInput,
  entries: TimelineEntriesProjection["entries"],
): TimelineEntriesProjection["entries"] {
  const folded = discussionFold(input.visibleTurnItems).messageIds;
  if (folded.size === 0) return entries;
  return entries.filter((entry) => entry.kind !== "message" || !folded.has(entry.id));
}

export function useIncrementalTimelineEntries(
  threadKey: string | null,
  input: TimelineEntriesInput,
): TimelineEntriesProjection["entries"] {
  const [state, setState] = useState(() => {
    const projection = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
    return { threadKey, projection, visible: withoutDiscussionLines(input, projection.entries) };
  });
  if (state.threadKey === threadKey && sameInput(state.projection.input, input)) {
    return state.visible;
  }
  const projection = deriveTimelineEntriesFromVisibleTurnItemsWithState(
    input,
    state.threadKey === threadKey ? state.projection : null,
  );
  const visible = withoutDiscussionLines(input, projection.entries);
  setState({ threadKey, projection, visible });
  return visible;
}
