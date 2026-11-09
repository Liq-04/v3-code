import { useAtomValue } from "@effect/atom-react";
import type { DiscussionCall, DiscussionCallState } from "@t3tools/client-runtime/discussion";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { AudioLinesIcon, MicIcon, MicOffIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { activeDiscussionAtom, dismissDiscussionCall } from "../../discussion/activeDiscussion";
import { updateClientSettings } from "../../hooks/useSettings";
import { shortcutLabelForCommand } from "../../keybindings";
import { cn } from "../../lib/utils";
import { registerCommands } from "../../shortcuts/dispatcher";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerBanner } from "./ComposerBanner";

const PHASE_LABELS: Record<DiscussionCallState["phase"], string> = {
  listening: "Listening",
  hearing: "You're talking",
  thinking: "Thinking",
  waiting: "Waiting for your approval",
  speaking: "Speaking",
};

const PHASE_DOT: Record<DiscussionCallState["phase"], string> = {
  listening: "text-success",
  hearing: "text-success",
  thinking: "text-warning",
  waiting: "text-warning",
  speaking: "text-info",
};

const MODIFIER_KEYS = new Set(["Meta", "Control", "Shift", "Alt"]);

/** The call strip above the composer, on the device that holds the call's audio. */
export function DiscussionCallStrip({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const active = useAtomValue(activeDiscussionAtom);
  if (active === null || active.threadKey !== scopedThreadKey(threadRef)) return null;
  return (
    <DiscussionCallBanner
      key={active.threadKey}
      call={active.call}
      onDismiss={() => dismissDiscussionCall(active.call)}
    />
  );
}

/** While a push-to-talk call is live, the dictation chord is the talk key, held. */
function useTalkKey(call: DiscussionCall, enabled: boolean) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the window key listeners that hold the talk key
  useEffect(() => {
    if (!enabled) return;
    let held: string | null = null;
    const release = () => {
      if (held === null) return;
      held = null;
      call.release();
    };
    const unregister = registerCommands(
      {
        "composer.dictation": (event) => {
          event.preventDefault();
          if (event.repeat || held !== null) return;
          held = event.code || event.key;
          call.press();
        },
      },
      { capture: true },
    );
    // macOS can drop the letter's keyup while Command is down, so a modifier's keyup ends it too.
    const onKeyUp = (event: KeyboardEvent) => {
      if ((event.code || event.key) === held || MODIFIER_KEYS.has(event.key)) release();
    };
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", release);
    return () => {
      unregister();
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", release);
      release();
    };
  }, [call, enabled]);
}

export function DiscussionCallBanner({
  call,
  onDismiss,
}: {
  readonly call: DiscussionCall;
  readonly onDismiss: () => void;
}) {
  const state = useAtomValue(call.state);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const meterRef = useRef<HTMLSpanElement>(null);
  const live = state.status === "live";
  const push = state.micMode === "push";
  useTalkKey(call, live && push && !state.muted);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- draws audio levels into the meter outside React, about ten times a second
  useEffect(
    () =>
      call.subscribeLevels(({ mic, agent }) => {
        const meter = meterRef.current;
        if (meter) meter.style.scale = `${Math.min(1, Math.max(mic * 4, agent))} 1`;
      }),
    [call],
  );

  if (state.status === "ended") return null;
  if (state.status === "failed") {
    return (
      <ComposerBanner.Attachment>
        <ComposerBanner.Root role="alert" variant="error" density="comfortable">
          <ComposerBanner.Row>
            <ComposerBanner.Icon>
              <AudioLinesIcon />
            </ComposerBanner.Icon>
            <ComposerBanner.Content>
              <span className="min-w-0 truncate font-medium">
                {state.error ?? "The call failed."}
              </span>
            </ComposerBanner.Content>
            <ComposerBanner.Actions>
              <ComposerBanner.Dismiss aria-label="Dismiss call error" onClick={onDismiss} />
            </ComposerBanner.Actions>
          </ComposerBanner.Row>
        </ComposerBanner.Root>
      </ComposerBanner.Attachment>
    );
  }

  const talkKey = shortcutLabelForCommand(keybindings, "composer.dictation", {
    context: { terminalFocus: false },
  });
  const end = async () => {
    try {
      await call.end();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not end the call",
        description: error instanceof Error ? error.message : "Try again.",
      });
    }
  };
  const switchMode = () => {
    const next = push ? "open" : "push";
    call.setMicMode(next);
    void updateClientSettings({ discussionMicMode: next });
  };

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root
        aria-label="Discussion call"
        density="comfortable"
        data-chat-composer-collapsed-controls="true"
      >
        <ComposerBanner.Row>
          <ComposerBanner.Icon>
            <ComposerBanner.Dot
              className={live ? PHASE_DOT[state.phase] : "text-muted-foreground"}
            />
          </ComposerBanner.Icon>
          <ComposerBanner.Content className="whitespace-nowrap">
            <span role="status" className="flex-none font-medium">
              {live ? PHASE_LABELS[state.phase] : "Connecting…"}
            </span>
            {state.caption && state.caption.text ? (
              <>
                <ComposerBanner.Separator />
                <span className="w-0 min-w-0 grow truncate text-muted-foreground">
                  {state.caption.text}
                </span>
              </>
            ) : null}
            <span
              ref={meterRef}
              aria-hidden
              className={cn(
                "ms-1 h-1 w-6 flex-none origin-left scale-x-0 rounded-full bg-current text-muted-foreground",
                state.muted && "invisible",
              )}
            />
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            {push && live ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                aria-pressed={state.talking}
                disabled={state.muted}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  call.press();
                }}
                onPointerUp={() => call.release()}
                onPointerCancel={() => call.release()}
              >
                {talkKey ? `Hold to talk (${talkKey})` : "Hold to talk"}
              </Button>
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost-muted"
                    disabled={!live}
                    onClick={switchMode}
                  >
                    {push ? "Push to talk" : "Open mic"}
                  </Button>
                }
              />
              <TooltipPopup side="top">
                {push ? "Switch to open mic" : "Switch to push to talk"}
              </TooltipPopup>
            </Tooltip>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={state.muted ? "Unmute" : "Mute"}
              aria-pressed={state.muted}
              disabled={!live}
              onClick={() => call.setMuted(!state.muted)}
            >
              {state.muted ? <MicOffIcon /> : <MicIcon />}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="destructive-outline"
              onClick={() => void end()}
            >
              End
            </Button>
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
