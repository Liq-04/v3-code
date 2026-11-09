import * as Schema from "effect/Schema";

import { DiscussionId, IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A discussion is a voice call with a thread's own agent. Orchestration holds only the thread's
 * "on a call" marker and the timeline item; everything audio-timed lives in the server's memory.
 */
export const DiscussionEndReason = Schema.Literals([
  "ended_by_user",
  "client_lost",
  "thread_closed",
  "server_restart",
]);
export type DiscussionEndReason = typeof DiscussionEndReason.Type;

/** The live-call marker on `AppThread.discussion`. One per thread; null or absent means no call. */
export const ThreadDiscussion = Schema.Struct({
  id: DiscussionId,
  startedAt: IsoDateTime,
  /** The device holding the call's audio, as its client label reads. */
  heldBy: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
});
export type ThreadDiscussion = typeof ThreadDiscussion.Type;

/**
 * Marks a user message as a line spoken in a discussion. The message `text` is the framed prompt
 * the agent reads; `spoken` is what the user said. Only the server sets it.
 */
export const DiscussionMessageAttribution = Schema.Struct({
  discussionId: DiscussionId,
  spoken: Schema.String.check(Schema.isMaxLength(20_000)),
});
export type DiscussionMessageAttribution = typeof DiscussionMessageAttribution.Type;

/** Discussion attribution comes only from the server's own sends; a client cannot claim it. */
export function withoutDiscussionAttribution<
  C extends { readonly context?: { readonly discussion?: unknown } | undefined },
>(command: C): C {
  if (command.context?.discussion === undefined) return command;
  const { discussion: _discussion, ...context } = command.context;
  return { ...command, context };
}

/** `lost`: the server restarted mid-call, so no summary is written. */
export const DiscussionItemStatus = Schema.Literals(["live", "ended", "lost"]);
export type DiscussionItemStatus = typeof DiscussionItemStatus.Type;

export const DiscussionCallPhase = Schema.Literals([
  "listening",
  "hearing",
  "thinking",
  "waiting",
  "speaking",
]);
export type DiscussionCallPhase = typeof DiscussionCallPhase.Type;

export const DiscussionMicMode = Schema.Literals(["open", "push"]);
export type DiscussionMicMode = typeof DiscussionMicMode.Type;

export const DiscussionEndOfSpeechMs = Schema.Int.check(
  Schema.isBetween({ minimum: 300, maximum: 1500 }),
);
export type DiscussionEndOfSpeechMs = typeof DiscussionEndOfSpeechMs.Type;
export const DEFAULT_DISCUSSION_END_OF_SPEECH_MS: DiscussionEndOfSpeechMs = 600;

/**
 * Duplex media socket for one call, opened with `?discussionId=` and a media ticket. Binary frames
 * are audio, Int16 mono: 16 kHz up and 24 kHz down. Text frames are the JSON frames below.
 * @public
 */
export const DISCUSSION_STREAM_PATH = "/ws/discussion";

export const DiscussionClientFrame = Schema.Union([
  Schema.Struct({ type: Schema.Literal("speech_start") }),
  Schema.Struct({ type: Schema.Literal("speech_end") }),
  Schema.Struct({ type: Schema.Literal("mute"), muted: Schema.Boolean }),
]);
export type DiscussionClientFrame = typeof DiscussionClientFrame.Type;

export const DiscussionSpeaker = Schema.Literals(["user", "agent"]);
export type DiscussionSpeaker = typeof DiscussionSpeaker.Type;

export const DiscussionServerFrame = Schema.Union([
  Schema.Struct({ type: Schema.Literal("phase"), phase: DiscussionCallPhase }),
  Schema.Struct({
    type: Schema.Literal("caption"),
    speaker: DiscussionSpeaker,
    text: Schema.String,
    final: Schema.Boolean,
  }),
  /** Flush queued playback: the user cut in. */
  Schema.Struct({ type: Schema.Literal("cut") }),
  Schema.Struct({ type: Schema.Literal("ended"), reason: DiscussionEndReason }),
]);
export type DiscussionServerFrame = typeof DiscussionServerFrame.Type;

export const DiscussionStartInput = Schema.Struct({ threadId: ThreadId });
export type DiscussionStartInput = typeof DiscussionStartInput.Type;

export const DiscussionStartResult = Schema.Struct({ discussionId: DiscussionId });
export type DiscussionStartResult = typeof DiscussionStartResult.Type;

const DISCUSSION_START_MESSAGES = {
  already_live: "This thread is already on a call. End it there first.",
  thread_unavailable: "This thread cannot start a discussion.",
  voice_not_configured: "Add an ElevenLabs API key in Settings → Voice to start a discussion.",
  unavailable: "Discussions are not available on this environment.",
} as const;

export class DiscussionStartError extends Schema.TaggedError<DiscussionStartError>()(
  "DiscussionStartError",
  {
    reason: Schema.Literals([
      "already_live",
      "thread_unavailable",
      "voice_not_configured",
      "unavailable",
    ]),
  },
) {
  override get message(): string {
    return DISCUSSION_START_MESSAGES[this.reason];
  }
}
