import { useAtomValue } from "@effect/atom-react";
import { callWorkRunHeader } from "@t3tools/client-runtime/discussion";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, OrchestrationV2TurnItem } from "@t3tools/contracts";
import {
  discussionTranscript,
  discussionTranscriptEntries,
  type DiscussionTranscriptEntry,
} from "@t3tools/shared/discussion/transcript";
import * as DateTime from "effect/DateTime";
import { AudioLinesIcon, ChevronRightIcon } from "lucide-react";
import { use, useState } from "react";

import { cn } from "~/lib/utils";
import type { WorkLogEntry } from "../../session-logic";
import { environmentThreadDetails } from "../../state/threads";
import ChatMarkdown from "../ChatMarkdown";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { TimelineRowCtx } from "./timelineRowContext";
import { WorkGroupSection, WorkingTimer } from "./TimelineWorkGroupRows";

type DiscussionItem = Extract<OrchestrationV2TurnItem, { readonly type: "discussion" }>;

const NO_MESSAGES: never[] = [];
const NO_WORK: never[] = [];

function durationLabel(item: DiscussionItem): string | null {
  if (item.startedAt === null || item.completedAt === null) return null;
  const minutes = Math.round(
    (DateTime.toEpochMillis(item.completedAt) - DateTime.toEpochMillis(item.startedAt)) / 60_000,
  );
  return minutes < 1 ? "under a minute" : `${minutes} min`;
}

/** A run of the agent's tool work, collapsed like the timeline's "Worked for" row. */
function CallWorkRun({
  rowId,
  entries,
}: {
  readonly rowId: string;
  readonly entries: WorkLogEntry[];
}) {
  const ctx = use(TimelineRowCtx);
  const groupId = `discussion-work:${entries[0]!.id}`;
  const [expanded, setExpanded] = useState(() =>
    ctx.workGroupViewState.expandedEntries.has(groupId),
  );
  const header = callWorkRunHeader(entries);
  const toggleExpanded = (open: boolean) => {
    ctx.onToggleWorkEntry(rowId, expanded);
    if (open) ctx.workGroupViewState.expandedEntries.add(groupId);
    else ctx.workGroupViewState.expandedEntries.delete(groupId);
    setExpanded(open);
  };
  return (
    <Collapsible open={expanded} onOpenChange={toggleExpanded}>
      <CollapsibleTrigger className="group flex min-w-0 items-center gap-1 text-xs text-muted-foreground tabular-nums hover:text-foreground">
        <ChevronRightIcon
          aria-hidden
          className="size-3 shrink-0 transition-transform group-data-panel-open:rotate-90"
        />
        <span className="shrink-0">
          {header.live ? (
            <>
              Working for <WorkingTimer createdAt={header.startedAt} />
            </>
          ) : header.duration === null ? (
            "Worked"
          ) : (
            `Worked for ${header.duration}`
          )}
        </span>
        {header.summary === null ? null : (
          <span className="min-w-0 truncate text-muted-foreground/70">· {header.summary}</span>
        )}
      </CollapsibleTrigger>
      {/* Virtualized rows must settle before disclosure scroll anchoring resumes. */}
      <CollapsiblePanel animate={false}>
        {expanded ? (
          <div className="pt-1">
            <WorkGroupSection anchorKey={groupId} groupedEntries={entries} isExpandedToolGroup />
          </div>
        ) : null}
      </CollapsiblePanel>
    </Collapsible>
  );
}

function TranscriptEntries({
  rowId,
  entries,
  cwd,
  threadRef,
}: {
  readonly rowId: string;
  readonly entries: ReadonlyArray<DiscussionTranscriptEntry<WorkLogEntry>>;
  readonly cwd: string | undefined;
  readonly threadRef: ReturnType<typeof scopeThreadRef>;
}) {
  return (
    <ol className="grid gap-2">
      {entries.map((entry) =>
        entry.kind === "work" ? (
          <li key={entry.id}>
            <CallWorkRun rowId={rowId} entries={entry.entries} />
          </li>
        ) : (
          <li key={entry.line.messageId} className="grid gap-0.5">
            <span
              className={cn(
                "text-xs font-medium",
                entry.line.speaker === "user" ? "text-muted-foreground" : "text-warning",
              )}
            >
              {entry.line.speaker === "user" ? "You" : "Agent"}
            </span>
            {entry.line.speaker === "user" ? (
              <span className="whitespace-pre-wrap wrap-anywhere text-sm">{entry.line.text}</span>
            ) : (
              <ChatMarkdown text={entry.line.text} cwd={cwd} threadRef={threadRef} />
            )}
          </li>
        ),
      )}
    </ol>
  );
}

/**
 * A voice discussion in the timeline. While live it shows the call's lines; once over, the summary
 * with the transcript behind a disclosure. The lines are the thread's own messages and the tool work
 * comes from the timeline entries, which the timeline leaves out (`discussionFold`).
 */
export function DiscussionTimelineRow({
  environmentId,
  rowId,
  item,
  callWork = NO_WORK,
  cwd,
}: {
  readonly environmentId: EnvironmentId;
  readonly rowId: string;
  readonly item: DiscussionItem;
  readonly callWork?: ReadonlyArray<WorkLogEntry> | undefined;
  readonly cwd: string | undefined;
}) {
  const threadRef = scopeThreadRef(environmentId, item.threadId);
  const messages = useAtomValue(
    environmentThreadDetails.threadAtom(threadRef),
    (thread) => thread?.projection.messages ?? NO_MESSAGES,
  );
  const entries = discussionTranscriptEntries(
    discussionTranscript(messages, item.discussionId),
    callWork,
  );
  const lineCount = entries.filter((entry) => entry.kind === "line").length;

  if (item.discussionStatus === "live") {
    return (
      <section
        aria-label="Live discussion"
        data-v2-item-type="discussion"
        className="my-2 grid gap-2 border-s-2 border-warning ps-4"
      >
        <span className="flex items-center gap-1.5 text-xs font-medium text-warning">
          <AudioLinesIcon aria-hidden className="size-3.5" />
          Discussion · live
        </span>
        {lineCount > 0 ? (
          <TranscriptEntries rowId={rowId} entries={entries} cwd={cwd} threadRef={threadRef} />
        ) : (
          <span className="text-sm text-muted-foreground">Talk to start.</span>
        )}
      </section>
    );
  }

  const duration = durationLabel(item);
  return (
    <section
      aria-label="Discussion"
      data-v2-item-type="discussion"
      className="my-2 grid gap-2 rounded-xl border bg-card px-4 py-3"
    >
      <span className="flex items-center gap-1.5 text-xs font-medium text-warning">
        <AudioLinesIcon aria-hidden className="size-3.5" />
        {duration === null ? "Discussion" : `Discussion · ${duration}`}
      </span>
      {item.discussionStatus === "lost" ? (
        <p className="text-sm text-muted-foreground">
          The call ended when the server restarted, so it has no summary.
        </p>
      ) : item.summary ? (
        <ChatMarkdown text={item.summary} cwd={cwd} threadRef={threadRef} />
      ) : (
        <p className="text-sm text-muted-foreground">
          {item.status === "failed" ? "No summary was written." : "Writing the summary…"}
        </p>
      )}
      {lineCount > 0 ? (
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronRightIcon
              aria-hidden
              className="size-3 transition-transform group-data-panel-open:rotate-90"
            />
            Transcript · {lineCount} {lineCount === 1 ? "line" : "lines"}
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="pt-2">
              <TranscriptEntries rowId={rowId} entries={entries} cwd={cwd} threadRef={threadRef} />
            </div>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </section>
  );
}
