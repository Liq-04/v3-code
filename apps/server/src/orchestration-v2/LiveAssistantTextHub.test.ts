import { assert, it } from "@effect/vitest";
import {
  MessageId,
  type OrchestrationV2TurnItem,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import * as LiveAssistantTextHub from "./LiveAssistantTextHub.ts";

const threadId = ThreadId.make("thread:live-text");
const otherThreadId = ThreadId.make("thread:other");
const runId = RunId.make("run:live-text");
const now = DateTime.makeUnsafe("2026-11-09T10:00:00.000Z");

const base = {
  threadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  title: null,
  startedAt: now,
  completedAt: null,
  updatedAt: now,
} as const;

const assistant = (text: string, streaming: boolean): OrchestrationV2TurnItem => ({
  ...base,
  id: TurnItemId.make("turn-item:assistant"),
  status: streaming ? "running" : "completed",
  type: "assistant_message",
  messageId: MessageId.make("message:assistant"),
  text,
  streaming,
});

const command = (status: OrchestrationV2TurnItem["status"]): OrchestrationV2TurnItem => ({
  ...base,
  id: TurnItemId.make("turn-item:command"),
  status,
  type: "command_execution",
  input: "pnpm test",
});

it.effect("copies assistant snapshots and tool starts to the thread's listeners only", () =>
  Effect.gen(function* () {
    const hub = yield* LiveAssistantTextHub.LiveAssistantTextHub;
    const frames = yield* hub
      .subscribe(threadId)
      .pipe(Stream.take(3), Stream.runCollect, Effect.forkScoped);
    const other = yield* hub
      .subscribe(otherThreadId)
      .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped);
    yield* Effect.yieldNow;

    yield* hub.observe(assistant("Hello", true));
    yield* hub.observe(command("running"));
    // A finished tool is not a start; a non-tool item is not a status.
    yield* hub.observe(command("completed"));
    yield* hub.observe({
      ...base,
      id: TurnItemId.make("turn-item:reasoning"),
      status: "running",
      type: "reasoning",
      text: "thinking",
      streaming: true,
    });
    yield* hub.observe(assistant("Hello there.", false));

    assert.deepEqual(Array.from(yield* Fiber.join(frames)), [
      {
        kind: "text",
        threadId,
        runId,
        messageId: MessageId.make("message:assistant"),
        text: "Hello",
        complete: false,
      },
      {
        kind: "tool",
        threadId,
        runId,
        itemId: TurnItemId.make("turn-item:command"),
        call: { action: "command", targets: ["pnpm test"] },
      },
      {
        kind: "text",
        threadId,
        runId,
        messageId: MessageId.make("message:assistant"),
        text: "Hello there.",
        complete: true,
      },
    ]);
    assert.isUndefined(other.pollUnsafe());
  }).pipe(Effect.provide(LiveAssistantTextHub.layer), Effect.scoped),
);

it("names the tool call for status lines", () => {
  assert.deepEqual(LiveAssistantTextHub.statusToolCall(command("running")), {
    action: "command",
    targets: ["pnpm test"],
  });
  assert.deepEqual(
    LiveAssistantTextHub.statusToolCall({
      ...base,
      id: TurnItemId.make("turn-item:edit"),
      status: "running",
      type: "file_change",
      fileName: "apps/web/src/ChatComposer.tsx",
    }),
    { action: "file_change", targets: ["apps/web/src/ChatComposer.tsx"] },
  );
  assert.deepEqual(
    LiveAssistantTextHub.statusToolCall({
      ...base,
      id: TurnItemId.make("turn-item:read"),
      status: "running",
      type: "dynamic_tool",
      toolName: "Read",
      input: { file_path: "/repo/README.md" },
    }),
    { action: "read", targets: ["/repo/README.md"] },
  );
  assert.deepEqual(
    LiveAssistantTextHub.statusToolCall({
      ...base,
      id: TurnItemId.make("turn-item:bash"),
      status: "running",
      type: "dynamic_tool",
      toolName: "Bash",
      input: { command: "git status" },
    }),
    { action: "command", targets: ["git status"] },
  );
  assert.isNull(LiveAssistantTextHub.statusToolCall(assistant("x", true)));
});
