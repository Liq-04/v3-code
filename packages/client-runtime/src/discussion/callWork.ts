import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import * as DateTime from "effect/DateTime";

import { summarizeToolGroup, type WorkLogPresentationEntry } from "../work-log/presentation.ts";

interface CallWorkRunHeader {
  /** A tool is still running, so the row reads "Working for". */
  readonly live: boolean;
  readonly startedAt: string;
  readonly duration: string | null;
  /** "read 1 file, searched once", or null when the run is only thinking. */
  readonly summary: string | null;
}

/** The collapsed row of a run of tool work inside a call's transcript. */
export function callWorkRunHeader(
  entries: ReadonlyArray<WorkLogPresentationEntry>,
): CallWorkRunHeader {
  const startedAt = entries[0]!.createdAt;
  const startMs = Date.parse(startedAt);
  let endMs = startMs;
  for (const entry of entries) {
    const completedAt = entry.structuredPayload?.completedAt;
    endMs = Math.max(
      endMs,
      completedAt ? DateTime.toEpochMillis(completedAt) : Date.parse(entry.createdAt),
    );
  }
  const summary = entries.every((entry) => entry.itemType === "reasoning")
    ? null
    : summarizeToolGroup(entries).summary;
  return {
    live: entries.some((entry) => entry.toolLifecycleStatus === "inProgress"),
    startedAt,
    duration: Number.isFinite(endMs - startMs) ? formatDuration(endMs - startMs) : null,
    summary: summary === null ? null : summary.charAt(0).toLowerCase() + summary.slice(1),
  };
}
