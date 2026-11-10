import {
  DiscussionId,
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import { discussionFold } from "./fold.ts";

const discussionId = DiscussionId.make("discussion-1");
const base = (id: string, runId: string | null, second: number) => {
  const at = DateTime.makeUnsafe(`2026-11-09T00:00:${String(second).padStart(2, "0")}.000Z`);
  return {
    id: TurnItemId.make(id),
    threadId: ThreadId.make("thread-1"),
    runId: runId === null ? null : RunId.make(runId),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: second,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
};
const user = (id: string, runId: string, second: number, spoken?: string) =>
  ({
    ...base(id, runId, second),
    type: "user_message",
    messageId: MessageId.make(id),
    inputIntent: "turn_start",
    text: spoken === undefined ? "typed" : `Spoken in a voice discussion: ${spoken}`,
    attachments: [],
    createdBy: "user",
    creationSource: "web",
    ...(spoken === undefined
      ? {}
      : { context: { version: 1, records: [], discussion: { discussionId, spoken } } }),
  }) satisfies OrchestrationV2TurnItem;
const assistant = (id: string, runId: string, second: number) =>
  ({
    ...base(id, runId, second),
    type: "assistant_message",
    messageId: MessageId.make(id),
    text: "reply",
    streaming: false,
  }) satisfies OrchestrationV2TurnItem;

const tool = (id: string, runId: string, second: number) =>
  ({
    ...base(id, runId, second),
    type: "command_execution",
    command: "ls",
  }) as unknown as OrchestrationV2TurnItem;

it("folds spoken lines and the replies and tool work after them in their runs, nothing else", () => {
  const items = [
    user("typed-1", "run-1", 0),
    assistant("before-line", "run-1", 1),
    tool("tool-before-line", "run-1", 1),
    user("spoken-1", "run-1", 2, "check the tests"),
    assistant("after-line", "run-1", 3),
    tool("tool-after-line", "run-1", 3),
    user("typed-2", "run-2", 4),
    assistant("typed-reply", "run-2", 5),
    tool("typed-tool", "run-2", 5),
  ].map((item) => ({ item }));
  const fold = discussionFold(items);
  expect([...fold.messageIds].toSorted()).toEqual(["after-line", "spoken-1"]);
  expect([...fold.toolItems]).toEqual([["tool-after-line", discussionId]]);
});
