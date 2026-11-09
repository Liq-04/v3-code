import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  DiscussionId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type ThreadDiscussion,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

import {
  closeLiveDiscussion,
  decideDiscussionCommand,
  DISCUSSION_FAILURE,
  type DiscussionCommand,
  type DiscussionTurnItem,
  discussionTurnItemId,
} from "./DiscussionDecider.ts";

const threadId = ThreadId.make("thread:discussion");
const discussionId = DiscussionId.make("discussion:one");
const otherDiscussionId = DiscussionId.make("discussion:two");
const now = DateTime.makeUnsafe("2026-11-09T10:00:00.000Z");
const later = DateTime.makeUnsafe("2026-11-09T10:05:00.000Z");
const instanceId = ProviderInstanceId.make("codex");

const thread = {
  id: threadId,
  projectId: ProjectId.make("project:discussion"),
  providerInstanceId: instanceId,
  archivedAt: null,
  deletedAt: null,
  updatedAt: now,
} as OrchestrationV2AppThread;

const live: OrchestrationV2AppThread = {
  ...thread,
  discussion: { id: discussionId, startedAt: DateTime.formatIso(now), heldBy: "desktop" },
};

const run = (ordinal: number, status: OrchestrationV2Run["status"] = "completed") =>
  ({ id: RunId.make(`run:${ordinal}`), ordinal, status }) as OrchestrationV2Run;

const liveItem: DiscussionTurnItem = {
  id: discussionTurnItemId(discussionId),
  threadId,
  runId: RunId.make("run:2"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "idle",
  title: "Voice discussion",
  startedAt: now,
  completedAt: null,
  updatedAt: now,
  type: "discussion",
  discussionId,
  discussionStatus: "live",
  summary: null,
};
const endedItem: DiscussionTurnItem = {
  ...liveItem,
  status: "completed",
  discussionStatus: "ended",
  completedAt: later,
};

const commandId = CommandId.make("command:discussion");
const start = {
  type: "thread.discussion.start",
  commandId,
  threadId,
  discussionId,
  heldBy: "desktop",
} as const;
const end = (
  reason: "ended_by_user" | "client_lost" | "thread_closed" | "server_restart",
  id = discussionId,
) => ({ type: "thread.discussion.end", commandId, threadId, discussionId: id, reason }) as const;
const record = (summary: string | null, id = discussionId) =>
  ({
    type: "thread.discussion.summary.record",
    commandId,
    threadId,
    discussionId: id,
    summary,
  }) as const;

interface Row {
  readonly name: string;
  readonly thread: OrchestrationV2AppThread;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly items: ReadonlyArray<DiscussionTurnItem>;
  readonly command: DiscussionCommand;
  readonly failure?: string;
  readonly expect?: {
    readonly discussion?: Partial<ThreadDiscussion> | null | undefined;
    readonly item: Partial<DiscussionTurnItem> | null;
    readonly summarize: boolean;
  };
}

describe("decideDiscussionCommand", () => {
  const rows: ReadonlyArray<Row> = [
    {
      name: "start marks the thread and opens a live item after the newest kept run",
      thread,
      runs: [run(1), run(3, "rolled_back"), run(2)],
      items: [],
      command: start,
      expect: {
        discussion: { id: discussionId, startedAt: DateTime.formatIso(later), heldBy: "desktop" },
        item: { runId: RunId.make("run:2"), discussionStatus: "live", summary: null },
        summarize: false,
      },
    },
    {
      name: "start on a thread with no runs opens the item outside any run",
      thread,
      runs: [],
      items: [],
      command: start,
      expect: { discussion: { id: discussionId }, item: { runId: null }, summarize: false },
    },
    {
      name: "start fails while a call is live",
      thread: live,
      runs: [],
      items: [liveItem],
      command: { ...start, discussionId: otherDiscussionId },
      failure: DISCUSSION_FAILURE.alreadyLive,
    },
    {
      name: "start fails on an archived thread",
      thread: { ...thread, archivedAt: now },
      runs: [],
      items: [],
      command: start,
      failure: DISCUSSION_FAILURE.archived,
    },
    {
      name: "end clears the marker, settles the item and asks for a summary",
      thread: live,
      runs: [],
      items: [liveItem],
      command: end("ended_by_user"),
      expect: {
        discussion: null,
        item: { discussionStatus: "ended", status: "completed", completedAt: later },
        summarize: true,
      },
    },
    {
      name: "end after a server restart marks the item lost with no summary",
      thread: live,
      runs: [],
      items: [liveItem],
      command: end("server_restart"),
      expect: { discussion: null, item: { discussionStatus: "lost" }, summarize: false },
    },
    {
      name: "end of a call that is over changes nothing",
      thread,
      runs: [],
      items: [endedItem],
      command: end("ended_by_user"),
      expect: { discussion: undefined, item: null, summarize: false },
    },
    {
      name: "end with another call's id leaves the live call alone",
      thread: live,
      runs: [],
      items: [liveItem],
      command: end("ended_by_user", otherDiscussionId),
      expect: { discussion: live.discussion, item: null, summarize: false },
    },
    {
      name: "summary.record fills an ended item once",
      thread,
      runs: [],
      items: [endedItem],
      command: record("They agreed to split the PR."),
      expect: {
        item: { summary: "They agreed to split the PR.", status: "completed" },
        summarize: false,
      },
    },
    {
      name: "summary.record of a failed summary marks the item failed",
      thread,
      runs: [],
      items: [endedItem],
      command: record(null),
      expect: { item: { summary: null, status: "failed" }, summarize: false },
    },
    {
      name: "summary.record after a failed summary changes nothing",
      thread,
      runs: [],
      items: [{ ...endedItem, status: "failed" }],
      command: record("Late."),
      expect: { item: null, summarize: false },
    },
    {
      name: "summary.record keeps a summary already written",
      thread,
      runs: [],
      items: [{ ...endedItem, summary: "First." }],
      command: record("Second."),
      expect: { item: null, summarize: false },
    },
    {
      name: "summary.record does nothing for a lost call",
      thread,
      runs: [],
      items: [{ ...endedItem, discussionStatus: "lost" }],
      command: record("Late."),
      expect: { item: null, summarize: false },
    },
    {
      name: "summary.record fails for an unknown call",
      thread,
      runs: [],
      items: [],
      command: record(null, otherDiscussionId),
      failure: DISCUSSION_FAILURE.unknown,
    },
  ];
  it.each(rows)("$name", (row) => {
    const decided = decideDiscussionCommand({
      thread: row.thread,
      runs: row.runs,
      items: row.items,
      command: row.command,
      now: later,
    });
    if (row.failure !== undefined) {
      assert.isTrue(Result.isFailure(decided));
      assert.equal(Result.isFailure(decided) && decided.failure, row.failure);
      return;
    }
    assert.isTrue(Result.isSuccess(decided));
    if (!Result.isSuccess(decided) || row.expect === undefined) return;
    const expected = row.expect;
    if ("discussion" in expected) {
      if (expected.discussion === null || expected.discussion === undefined) {
        assert.equal(decided.success.thread.discussion, expected.discussion);
      } else {
        assert.deepInclude(decided.success.thread.discussion ?? {}, expected.discussion);
      }
    }
    if (expected.item === null) assert.isNull(decided.success.item);
    else assert.deepInclude(decided.success.item ?? {}, expected.item);
    assert.equal(decided.success.summarize, expected.summarize);
  });
});

describe("closeLiveDiscussion", () => {
  it("ends the live call as closed by the thread and is a no-op without one", () => {
    const closed = closeLiveDiscussion({ thread: live, items: [liveItem], now: later });
    assert.isNull(closed?.thread.discussion);
    assert.equal(closed?.item?.discussionStatus, "ended");
    assert.isTrue(closed?.summarize);
    assert.isNull(closeLiveDiscussion({ thread, items: [endedItem], now: later }));
  });
});
