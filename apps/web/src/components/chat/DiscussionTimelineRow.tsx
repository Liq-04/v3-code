import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, OrchestrationV2TurnItem } from "@t3tools/contracts";
import {
  type DiscussionTranscriptLine,
  discussionTranscript,
} from "@t3tools/shared/discussion/transcript";
import * as DateTime from "effect/DateTime";
import { AudioLinesIcon, ChevronRightIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { environmentThreadDetails } from "../../state/threads";
import ChatMarkdown from "../ChatMarkdown";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";

type DiscussionItem = Extract<OrchestrationV2TurnItem, { readonly type: "discussion" }>;

const NO_MESSAGES: never[] = [];

function durationLabel(item: DiscussionItem): string | null {
  if (item.startedAt === null || item.completedAt === null) return null;
  const minutes = Math.round(
    (DateTime.toEpochMillis(item.completedAt) - DateTime.toEpochMillis(item.startedAt)) / 60_000,
  );
  return minutes < 1 ? "under a minute" : `${minutes} min`;
}

function TranscriptLines({
  lines,
  cwd,
  threadRef,
}: {
  readonly lines: ReadonlyArray<DiscussionTranscriptLine>;
  readonly cwd: string | undefined;
  readonly threadRef: ReturnType<typeof scopeThreadRef>;
}) {
  return (
    <ol className="grid gap-2">
      {lines.map((line) => (
        <li key={line.messageId} className="grid gap-0.5">
          <span
            className={cn(
              "text-xs font-medium",
              line.speaker === "user" ? "text-muted-foreground" : "text-warning",
            )}
          >
            {line.speaker === "user" ? "You" : "Agent"}
          </span>
          {line.speaker === "user" ? (
            <span className="whitespace-pre-wrap wrap-anywhere text-sm">{line.text}</span>
          ) : (
            <ChatMarkdown text={line.text} cwd={cwd} threadRef={threadRef} />
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * A voice discussion in the timeline. While live it shows the call's lines; once over, the summary
 * with the transcript behind a disclosure. The lines are the thread's own messages, which the
 * timeline leaves out (`discussionFold`).
 */
export function DiscussionTimelineRow({
  environmentId,
  item,
  cwd,
}: {
  readonly environmentId: EnvironmentId;
  readonly item: DiscussionItem;
  readonly cwd: string | undefined;
}) {
  const threadRef = scopeThreadRef(environmentId, item.threadId);
  const messages = useAtomValue(
    environmentThreadDetails.threadAtom(threadRef),
    (thread) => thread?.projection.messages ?? NO_MESSAGES,
  );
  const lines = discussionTranscript(messages, item.discussionId);

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
        {lines.length > 0 ? (
          <TranscriptLines lines={lines} cwd={cwd} threadRef={threadRef} />
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
      {lines.length > 0 ? (
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronRightIcon
              aria-hidden
              className="size-3 transition-transform group-data-panel-open:rotate-90"
            />
            Transcript · {lines.length} {lines.length === 1 ? "line" : "lines"}
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="pt-2">
              <TranscriptLines lines={lines} cwd={cwd} threadRef={threadRef} />
            </div>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </section>
  );
}
