import {
  isOrchestrationV2WorkActive,
  type MessageId,
  type OrchestrationV2TurnItem,
  type RunId,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import type { StatusToolCall } from "@t3tools/shared/discussion/statusLine";
import { classifyToolActivity, collectToolFilePaths } from "@t3tools/shared/toolActivity";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

/**
 * Raw adapter snapshots, copied before the streaming filter cuts and throttles them, for the
 * server's own live readers such as a discussion's voice. Nothing crosses the wire and nothing is
 * kept when no one listens. Snapshots are cumulative, so a slow reader may miss some and lose
 * nothing.
 */

/** Snapshots a reader may fall behind by before the oldest are dropped. */
const MAX_QUEUED_FRAMES = 256;

export type LiveAssistantFrame =
  | {
      readonly kind: "text";
      readonly threadId: ThreadId;
      readonly runId: RunId | null;
      readonly messageId: MessageId;
      /** The message's whole text so far. */
      readonly text: string;
      readonly complete: boolean;
    }
  | {
      readonly kind: "tool";
      readonly threadId: ThreadId;
      readonly runId: RunId | null;
      readonly itemId: TurnItemId;
      readonly call: StatusToolCall;
    };

export interface LiveAssistantTextHubShape {
  readonly observe: (item: OrchestrationV2TurnItem) => Effect.Effect<void>;
  readonly subscribe: (threadId: ThreadId) => Stream.Stream<LiveAssistantFrame>;
}

export class LiveAssistantTextHub extends Context.Service<
  LiveAssistantTextHub,
  LiveAssistantTextHubShape
>()("t3/orchestration-v2/LiveAssistantTextHub") {}

function commandLine(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const command = (input as { readonly command?: unknown }).command;
  if (typeof command === "string") return command;
  return Array.isArray(command)
    ? command.filter((part) => typeof part === "string").join(" ")
    : undefined;
}

/** The newest tool call as a status line sees it, or null for items that are not tool work. */
export function statusToolCall(item: OrchestrationV2TurnItem): StatusToolCall | null {
  switch (item.type) {
    case "command_execution":
      return { action: "command", targets: [item.input] };
    case "file_change":
      return { action: "file_change", targets: [item.fileName] };
    case "file_search":
    case "web_search":
      return { action: "search", targets: [] };
    case "dynamic_tool": {
      const action = classifyToolActivity({
        itemType: "dynamic_tool_call",
        title: item.title ?? undefined,
        data: { toolName: item.toolName, rawInput: item.input },
      });
      const command = commandLine(item.input);
      return {
        action,
        targets:
          action === "command" && command !== undefined
            ? [command]
            : collectToolFilePaths(item.input),
      };
    }
    default:
      return null;
  }
}

function frameOf(item: OrchestrationV2TurnItem): LiveAssistantFrame | null {
  if (item.type === "assistant_message") {
    return {
      kind: "text",
      threadId: item.threadId,
      runId: item.runId,
      messageId: item.messageId,
      text: item.text,
      complete: !item.streaming,
    };
  }
  if (!isOrchestrationV2WorkActive(item.status)) return null;
  const call = statusToolCall(item);
  return call === null
    ? null
    : { kind: "tool", threadId: item.threadId, runId: item.runId, itemId: item.id, call };
}

const make = Effect.sync(() => {
  const subscribers = new Map<ThreadId, Set<Queue.Queue<LiveAssistantFrame>>>();

  const observe: LiveAssistantTextHubShape["observe"] = (item) =>
    Effect.suspend(() => {
      const listeners = subscribers.get(item.threadId);
      if (listeners === undefined) return Effect.void;
      const frame = frameOf(item);
      if (frame === null) return Effect.void;
      return Effect.forEach(listeners, (queue) => Queue.offer(queue, frame), { discard: true });
    });

  const subscribe: LiveAssistantTextHubShape["subscribe"] = (threadId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const queue = yield* Queue.sliding<LiveAssistantFrame>(MAX_QUEUED_FRAMES);
        const listeners = subscribers.get(threadId) ?? new Set();
        listeners.add(queue);
        subscribers.set(threadId, listeners);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            listeners.delete(queue);
            if (listeners.size === 0 && subscribers.get(threadId) === listeners) {
              subscribers.delete(threadId);
            }
          }),
        );
        return Stream.fromQueue(queue);
      }),
    );

  return LiveAssistantTextHub.of({ observe, subscribe });
});

export const layer: Layer.Layer<LiveAssistantTextHub> = Layer.effect(LiveAssistantTextHub, make);
