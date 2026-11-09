import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  ScopedThreadRef,
  ThreadDiscussion,
} from "@t3tools/contracts";
import { discussionTranscript } from "@t3tools/shared/discussion/transcript";
import { Atom } from "effect/reactivity";
import { useMemo, useState } from "react";
import { Pressable, View, type ColorValue } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

const NO_DISCUSSION_ATOM = Atom.make<ThreadDiscussion | null>(null);

function discussionAtom(ref: ScopedThreadRef) {
  let previous: ThreadDiscussion | null = null;
  return Atom.make((get) => {
    const next =
      get(environmentThreadDetails.threadAtom(ref))?.projection.thread.discussion ?? null;
    // The thread record is replaced on unrelated updates; only the marker matters here.
    if (next?.id !== previous?.id) previous = next;
    return previous;
  });
}

function alertOnFailure(result: AtomCommandResult<unknown, unknown>) {
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    Dialog.alert("Could not end the call", error instanceof Error ? error.message : "Try again.");
  }
}

/**
 * "On a call" above the composer, with End. Mobile does not hold call audio yet, so this hangs up a
 * call another device holds.
 */
export function ThreadDiscussionBar(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly canOperateThread: boolean;
}) {
  const { threadRef } = props;
  const markerAtom = useMemo(
    () => (threadRef === null ? NO_DISCUSSION_ATOM : discussionAtom(threadRef)),
    [threadRef],
  );
  const discussion = useAtomValue(markerAtom);
  const endDiscussion = useAtomCommand(threadEnvironment.endDiscussion, "end discussion");
  const [busy, setBusy] = useState(false);
  if (threadRef === null || discussion === null) return null;
  const end = () => {
    if (busy) return;
    setBusy(true);
    void endDiscussion({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, discussionId: discussion.id },
    }).then((result) => {
      setBusy(false);
      alertOnFailure(result);
    });
  };
  return (
    <View className="flex-row items-center gap-2 px-4 pb-2">
      <SymbolView
        name="bubble.left.and.bubble.right"
        size={12}
        tintColorClassName="accent-foreground-muted"
      />
      <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
        On a call · audio on {discussion.heldBy}
      </Text>
      <Button label="End" tone="text" disabled={busy || !props.canOperateThread} onPress={end} />
    </View>
  );
}

/** A voice discussion in the feed: its lines while live, then the summary and the transcript. */
export function DiscussionCard(props: {
  readonly environmentId: EnvironmentId;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly iconColor: ColorValue;
}) {
  const { item } = props.projectedItem;
  const ref = scopeThreadRef(props.environmentId, item.threadId);
  const messages = useAtomValue(
    environmentThreadDetails.threadAtom(ref),
    (thread) => thread?.projection.messages,
  );
  const [open, setOpen] = useState(false);
  if (item.type !== "discussion") return null;
  const lines = messages ? discussionTranscript(messages, item.discussionId) : [];
  const live = item.discussionStatus === "live";
  const transcript = (
    <View className="gap-2">
      {lines.map((line) => (
        <View key={line.messageId} className="gap-0.5">
          <Text className="text-xs font-medium text-foreground-muted">
            {line.speaker === "user" ? "You" : "Agent"}
          </Text>
          <Text selectable className="text-sm text-foreground">
            {line.text}
          </Text>
        </View>
      ))}
    </View>
  );
  return (
    <View className="mb-3 gap-2 rounded-xl border border-border px-3 py-2.5">
      <View className="flex-row items-center gap-1.5">
        <SymbolView
          name="bubble.left.and.bubble.right"
          size={12}
          tintColor={props.iconColor}
          type="monochrome"
        />
        <Text className="text-xs font-medium text-foreground-muted">
          {live ? "Discussion · live" : "Discussion"}
        </Text>
      </View>
      {live ? (
        transcript
      ) : (
        <>
          <Text selectable className="text-sm text-foreground">
            {item.discussionStatus === "lost"
              ? "The call ended when the server restarted, so it has no summary."
              : (item.summary ?? "No summary yet.")}
          </Text>
          {lines.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: open }}
              onPress={() => setOpen((value) => !value)}
            >
              <Text className="text-xs text-foreground-muted">
                {open ? "Hide transcript" : `Transcript · ${lines.length} lines`}
              </Text>
            </Pressable>
          ) : null}
          {open ? transcript : null}
        </>
      )}
    </View>
  );
}
