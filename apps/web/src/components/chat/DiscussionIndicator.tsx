import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";

import { discussionHeldHereAtom, endDiscussionCall } from "../../discussion/activeDiscussion";
import { useQuietThreadProjection } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * "On a call" for every device viewing the thread, from the thread's own marker, with End: a
 * device that does not hold the call's audio can still hang it up.
 */
export function DiscussionIndicator({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const discussion = useQuietThreadProjection(threadRef)?.projection.thread.discussion ?? null;
  const heldHere = useAtomValue(discussionHeldHereAtom(scopedThreadKey(threadRef)));
  const canOperate = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const [ending, setEnding] = useState(false);
  if (discussion === null) return null;
  const end = async () => {
    setEnding(true);
    try {
      await endDiscussionCall(threadRef, discussion.id);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not end the call",
        description: error instanceof Error ? error.message : "Try again.",
      });
    }
    setEnding(false);
  };
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Tooltip>
        <TooltipTrigger render={<Badge variant="success" size="sm" />}>On a call</TooltipTrigger>
        <TooltipPopup side="bottom">
          {heldHere ? "The call's audio is on this device." : `Audio on ${discussion.heldBy}`}
        </TooltipPopup>
      </Tooltip>
      {canOperate ? (
        <Button size="xs" variant="ghost-destructive" disabled={ending} onClick={() => void end()}>
          End
        </Button>
      ) : null}
    </div>
  );
}
