import { useAtomValue } from "@effect/atom-react";
import { callWorkRunHeader } from "@t3tools/client-runtime/discussion";
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
import {
  discussionTranscript,
  discussionTranscriptEntries,
} from "@t3tools/shared/discussion/transcript";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { Atom } from "effect/reactivity";
import { useMemo, useState, type ReactNode } from "react";
import { Pressable, View, type ColorValue } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import type { ThreadFeedActivity } from "../../lib/threadActivity";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { ThreadDisclosureChevron } from "./thread-work-log";
import { useVisibleSecondClock } from "./use-visible-second-clock";

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

/** The feed's work-row disclosure state and rendering, lent to a card that shows tool work. */
export interface DiscussionWork {
  readonly isExpanded: (key: string) => boolean;
  readonly toggle: (key: string) => void;
  readonly render: (activities: ReadonlyArray<ThreadFeedActivity>, anchorKey: string) => ReactNode;
}

/** A run of the agent's tool work, collapsed like the feed's "Worked for" row. */
function CallWorkRun(props: {
  readonly activities: ReadonlyArray<ThreadFeedActivity>;
  readonly work: DiscussionWork;
  readonly iconColor: ColorValue;
}) {
  const { activities, work } = props;
  const key = `discussion-work:${activities[0]!.id}`;
  const header = callWorkRunHeader(activities.map((activity) => activity.workEntry));
  const now = useVisibleSecondClock(header.live);
  const expanded = work.isExpanded(key);
  const label = header.live
    ? `Working for ${formatDuration(Math.max(0, now - Date.parse(header.startedAt)))}`
    : header.duration === null
      ? "Worked"
      : `Worked for ${header.duration}`;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        hitSlop={4}
        className="min-h-9 flex-row items-center gap-1.5"
        onPress={() => work.toggle(key)}
      >
        <ThreadDisclosureChevron
          expanded={expanded}
          collapsedDirection="right"
          size={11}
          tintColor={props.iconColor}
        />
        <Text className="shrink-0 text-xs tabular-nums text-foreground-muted">{label}</Text>
        {header.summary === null ? null : (
          <Text numberOfLines={1} className="min-w-0 shrink text-xs text-foreground-muted/70">
            · {header.summary}
          </Text>
        )}
      </Pressable>
      {expanded
        ? work.render(
            activities.map((activity) => ({ ...activity, groupedToolDetail: true })),
            key,
          )
        : null}
    </View>
  );
}

/** A voice discussion in the feed: its lines and tool work while live, then the summary and the transcript. */
export function DiscussionCard(props: {
  readonly environmentId: EnvironmentId;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly callWork: ReadonlyArray<ThreadFeedActivity>;
  readonly work: DiscussionWork;
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
  const entries = discussionTranscriptEntries(lines, props.callWork);
  const live = item.discussionStatus === "live";
  const transcript = (
    <View className="gap-2">
      {entries.map((entry) =>
        entry.kind === "work" ? (
          <CallWorkRun
            key={entry.id}
            activities={entry.entries}
            work={props.work}
            iconColor={props.iconColor}
          />
        ) : (
          <View key={entry.line.messageId} className="gap-0.5">
            <Text className="text-xs font-medium text-foreground-muted">
              {entry.line.speaker === "user" ? "You" : "Agent"}
            </Text>
            <Text selectable className="text-sm text-foreground">
              {entry.line.text}
            </Text>
          </View>
        ),
      )}
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
