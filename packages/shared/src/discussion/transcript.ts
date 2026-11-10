import type {
  DiscussionId,
  DiscussionSpeaker,
  MessageId,
  OrchestrationV2ConversationMessage,
  RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface DiscussionTranscriptLine {
  readonly messageId: MessageId;
  readonly speaker: DiscussionSpeaker;
  readonly text: string;
  readonly at: DateTime.Utc;
}

/**
 * The transcript is derived from durable messages, never copied: the user's spoken lines, and the
 * agent's replies in the runs those lines went to, from the first line in each run on.
 */
export function discussionTranscript(
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  discussionId: DiscussionId,
): ReadonlyArray<DiscussionTranscriptLine> {
  const firstLineInRun = new Map<RunId, number>();
  for (const message of messages) {
    if (message.role !== "user" || message.context?.discussion?.discussionId !== discussionId)
      continue;
    if (message.runId === null) continue;
    const at = DateTime.toEpochMillis(message.createdAt);
    firstLineInRun.set(message.runId, Math.min(at, firstLineInRun.get(message.runId) ?? at));
  }

  const lines: Array<DiscussionTranscriptLine> = [];
  for (const message of messages) {
    const spoken =
      message.role === "user" && message.context?.discussion?.discussionId === discussionId
        ? message.context.discussion.spoken
        : null;
    const firstLine = message.runId === null ? undefined : firstLineInRun.get(message.runId);
    const reply =
      message.role === "assistant" &&
      firstLine !== undefined &&
      DateTime.toEpochMillis(message.createdAt) >= firstLine;
    const text = (spoken ?? (reply ? message.text : "")).trim();
    if (text === "") continue;
    lines.push({
      messageId: message.id,
      speaker: spoken === null ? "agent" : "user",
      text,
      at: message.createdAt,
    });
  }
  return lines.sort(
    (left, right) => DateTime.toEpochMillis(left.at) - DateTime.toEpochMillis(right.at),
  );
}

export type DiscussionTranscriptEntry<Work> =
  | { readonly kind: "line"; readonly line: DiscussionTranscriptLine }
  | { readonly kind: "work"; readonly id: string; readonly entries: ReadonlyArray<Work> };

/**
 * The transcript with the agent's tool work between its lines, in time order. Consecutive work
 * entries between two lines are one run, and a line comes before work that starts at the same time.
 */
export function discussionTranscriptEntries<
  Work extends { readonly id: string; readonly createdAt: string },
>(
  lines: ReadonlyArray<DiscussionTranscriptLine>,
  work: ReadonlyArray<Work>,
): ReadonlyArray<DiscussionTranscriptEntry<Work>> {
  const sortedWork = work
    .map((entry) => ({ entry, at: Date.parse(entry.createdAt) }))
    .sort((left, right) => left.at - right.at);
  const entries: Array<DiscussionTranscriptEntry<Work>> = [];
  let open: Array<Work> | null = null;
  let next = 0;
  const flushWorkBefore = (at: number) => {
    while (next < sortedWork.length && sortedWork[next]!.at < at) {
      if (open === null) {
        open = [];
        entries.push({ kind: "work", id: sortedWork[next]!.entry.id, entries: open });
      }
      open.push(sortedWork[next]!.entry);
      next += 1;
    }
  };
  for (const line of lines) {
    flushWorkBefore(DateTime.toEpochMillis(line.at));
    open = null;
    entries.push({ kind: "line", line });
  }
  flushWorkBefore(Infinity);
  return entries;
}
