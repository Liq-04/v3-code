import { useAtomValue } from "@effect/atom-react";
import type { ResolvedKeybindingsConfig, ScopedThreadRef } from "@t3tools/contracts";
import { PhoneIcon } from "lucide-react";

import { startDiscussionCall, useDiscussionHeldHere } from "../../discussion/activeDiscussion";
import { shortcutLabelForCommand } from "../../keybindings";
import { useQuietThreadProjection } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Starts a voice discussion; hidden while the thread is on a call, which the strip or header ends. */
export function ComposerDiscussionButton({
  threadRef,
  disabled,
  keybindings,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly disabled: boolean;
  readonly keybindings: ResolvedKeybindingsConfig;
}) {
  const onCall = useQuietThreadProjection(threadRef)?.projection.thread.discussion != null;
  const heldHere = useDiscussionHeldHere(threadRef);
  const allowed = useAtomValue(
    serverEnvironment.startDiscussion.permissionAtom(threadRef.environmentId),
  );
  if (onCall || heldHere || !allowed) return null;
  const shortcut = shortcutLabelForCommand(keybindings, "composer.discussion", {
    context: { terminalFocus: false },
  });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Start discussion"
            disabled={disabled}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              const { error } = startDiscussionCall(threadRef);
              if (error) toastManager.add({ type: "error", title: error });
            }}
            className="shrink-0"
          >
            <PhoneIcon />
          </Button>
        }
      />
      <TooltipPopup side="top">
        Start discussion
        {shortcut ? ` (${shortcut})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}
