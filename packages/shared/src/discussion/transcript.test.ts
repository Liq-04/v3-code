import {
  DiscussionId,
  MessageId,
  type OrchestrationV2ConversationMessage,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { discussionTranscript, discussionTranscriptEntries } from "./transcript.ts";

const call = DiscussionId.make("discussion-1");
const otherCall = DiscussionId.make("discussion-2");

const message = (
  id: string,
  role: "user" | "assistant",
  second: number,
  runId: string | null,
  text: string,
  discussion?: { readonly discussionId: DiscussionId; readonly spoken: string },
): OrchestrationV2ConversationMessage => ({
  createdBy: role === "user" ? "user" : "agent",
  creationSource: "web",
  id: MessageId.make(id),
  threadId: ThreadId.make("thread-1"),
  runId: runId === null ? null : RunId.make(runId),
  nodeId: null,
  role,
  text,
  ...(discussion === undefined ? {} : { context: { version: 1, records: [], discussion } }),
  attachments: [],
  streaming: false,
  createdAt: DateTime.makeUnsafe(second * 1_000),
  updatedAt: DateTime.makeUnsafe(second * 1_000),
});

describe("discussionTranscript", () => {
  it("folds the call's spoken lines and the replies in their runs, in time order", () => {
    const messages = [
      // A typed turn before the call, still running when the first line steers into it.
      message("typed", "user", 1, "run-1", "Refactor the parser"),
      message("before-line", "assistant", 2, "run-1", "Starting on the parser."),
      message("line-1", "user", 3, "run-1", "Spoken in a voice discussion: wait", {
        discussionId: call,
        spoken: "Wait, keep the old API.",
      }),
      message("reply-1", "assistant", 4, "run-1", "Keeping the old API."),
      message("empty-reply", "assistant", 5, "run-1", "  "),
      message("typed-during-call", "user", 6, "run-2", "Also fix the lint"),
      message("typed-reply", "assistant", 7, "run-2", "Fixed the lint."),
      message("other-call", "user", 8, "run-3", "framed", {
        discussionId: otherCall,
        spoken: "Hi",
      }),
      message("other-reply", "assistant", 9, "run-3", "Hello."),
      message("reply-2", "assistant", 11, "run-4", "Tests pass."),
      message("line-2", "user", 10, "run-4", "framed", {
        discussionId: call,
        spoken: "Run the tests.",
      }),
    ];

    expect(
      discussionTranscript(messages, call).map(({ messageId, speaker, text }) => [
        messageId,
        speaker,
        text,
      ]),
    ).toEqual([
      ["line-1", "user", "Wait, keep the old API."],
      ["reply-1", "agent", "Keeping the old API."],
      ["line-2", "user", "Run the tests."],
      ["reply-2", "agent", "Tests pass."],
    ]);
  });
});

describe("discussionTranscriptEntries", () => {
  it("puts each run of tool work between the lines it happened between", () => {
    const lines = discussionTranscript(
      [
        message("line-1", "user", 10, "run-1", "framed", { discussionId: call, spoken: "Hi" }),
        message("reply-1", "assistant", 20, "run-1", "Checking."),
        message("reply-2", "assistant", 40, "run-1", "Done."),
      ],
      call,
    );
    const work = (id: string, second: number) => ({
      id,
      createdAt: DateTime.formatIso(DateTime.makeUnsafe(second * 1_000)),
    });
    const entries = discussionTranscriptEntries(lines, [
      work("tool-c", 30),
      work("tool-a", 21),
      work("tool-b", 22),
      work("tool-d", 50),
      work("tool-tie", 10),
    ]);
    expect(
      entries.map((entry) =>
        entry.kind === "line" ? entry.line.messageId : entry.entries.map(({ id }) => id),
      ),
    ).toEqual([
      "line-1",
      ["tool-tie"],
      "reply-1",
      ["tool-a", "tool-b", "tool-c"],
      "reply-2",
      ["tool-d"],
    ]);
  });
});
