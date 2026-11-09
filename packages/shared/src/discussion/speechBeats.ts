import type { MessageId, RunId } from "@t3tools/contracts";

const CODE_BEAT = "the code is in the thread";
const FENCE = "```";
const CLAUSE_CUT_AFTER_MS = 1_200;
const CLAUSE_CUT_MIN_CHARS = 40;
const SENTENCE_CLOSERS = new Set(['"', "'", "”", "’", ")", "]", "*", "_"]);

interface MessageSpeech {
  readonly text: string;
  /** Text before this index is spoken or skipped. */
  readonly consumed: number;
  readonly inFence: boolean;
  /** When the unspoken text, which has no sentence end yet, started waiting. */
  readonly waitingSince: number | null;
  readonly lastBeatWasCode: boolean;
}

export interface SpeechBeats {
  readonly messages: ReadonlyMap<MessageId, MessageSpeech>;
  /** Runs already writing when the call started. Their text predates every line until the first. */
  readonly heldRuns: ReadonlySet<RunId>;
}

export const emptySpeechBeats: SpeechBeats = { messages: new Map(), heldRuns: new Set() };

/** A call started while these runs were active: nothing they wrote before the first line is spoken. */
export function startSpeechBeats(heldRuns: Iterable<RunId>): SpeechBeats {
  return { messages: new Map(), heldRuns: new Set(heldRuns) };
}

export type SpeechBeatsInput =
  | {
      readonly type: "text";
      readonly messageId: MessageId;
      readonly runId?: RunId | null;
      /** The message's whole text so far. */
      readonly text: string;
      readonly complete: boolean;
      readonly at: number;
    }
  /** The user sent a line: everything written so far is never spoken. */
  | { readonly type: "line" }
  | { readonly type: "tick"; readonly at: number };

export interface SpeechBeatsStep {
  readonly state: SpeechBeats;
  readonly beats: ReadonlyArray<string>;
}

/**
 * Turns the agent's cumulative text snapshots into short spoken beats. Time comes in with each
 * input. Only text written after the user's latest line is spoken (the watermark).
 */
export function stepSpeechBeats(state: SpeechBeats, input: SpeechBeatsInput): SpeechBeatsStep {
  switch (input.type) {
    case "line": {
      const messages = new Map<MessageId, MessageSpeech>();
      for (const [messageId, message] of state.messages) {
        messages.set(messageId, {
          ...message,
          consumed: Math.max(message.consumed, message.text.length - partialFenceLength(message)),
          waitingSince: null,
          lastBeatWasCode: false,
        });
      }
      return { state: { messages, heldRuns: new Set() }, beats: [] };
    }
    case "tick": {
      const messages = new Map(state.messages);
      const beats: Array<string> = [];
      for (const [messageId, message] of state.messages) {
        const settled = settle(message, input.at);
        messages.set(messageId, settled.message);
        beats.push(...settled.beats);
      }
      return { state: { messages, heldRuns: state.heldRuns }, beats };
    }
    case "text": {
      const previous = state.messages.get(input.messageId);
      const base: MessageSpeech = {
        text: input.text,
        consumed: Math.min(previous?.consumed ?? 0, input.text.length),
        inFence: previous?.inFence ?? false,
        waitingSince: previous?.waitingSince ?? null,
        lastBeatWasCode: previous?.lastBeatWasCode ?? false,
      };
      const drained = drain(base, input.complete);
      if (input.runId != null && state.heldRuns.has(input.runId)) {
        const held = drained.message;
        const consumed = Math.max(held.consumed, held.text.length - partialFenceLength(held));
        const messages = new Map(state.messages).set(input.messageId, {
          ...held,
          consumed,
          waitingSince: null,
        });
        return { state: { messages, heldRuns: state.heldRuns }, beats: [] };
      }
      const settled = input.complete
        ? { message: { ...drained.message, waitingSince: null }, beats: [] }
        : settle(drained.message, input.at);
      const messages = new Map(state.messages).set(input.messageId, settled.message);
      return {
        state: { messages, heldRuns: state.heldRuns },
        beats: [...drained.beats, ...settled.beats],
      };
    }
  }
}

function drain(message: MessageSpeech, complete: boolean) {
  const { text } = message;
  let index = message.consumed;
  let inFence = message.inFence;
  let lastBeatWasCode = message.lastBeatWasCode;
  const beats: Array<string> = [];
  const speak = (raw: string) => {
    const beat = spokenText(raw);
    if (beat === null) return;
    beats.push(beat);
    lastBeatWasCode = false;
  };

  while (index < text.length) {
    if (inFence) {
      const close = text.indexOf(FENCE, index);
      if (close === -1) {
        index = complete ? text.length : Math.max(index, text.length - trailingBackticks(text));
        break;
      }
      index = afterLine(text, close + FENCE.length);
      inFence = false;
      continue;
    }
    const fence = text.indexOf(FENCE, index);
    const proseEnd = fence === -1 ? text.length : fence;
    const endConfirmed = complete || fence !== -1;
    for (
      let end = sentenceEnd(text, index, proseEnd, endConfirmed);
      end !== null;
      end = sentenceEnd(text, index, proseEnd, endConfirmed)
    ) {
      speak(text.slice(index, end));
      index = end;
    }
    if (fence === -1) {
      if (complete) {
        speak(text.slice(index));
        index = text.length;
      }
      break;
    }
    speak(text.slice(index, fence));
    if (!lastBeatWasCode) beats.push(CODE_BEAT);
    lastBeatWasCode = true;
    inFence = true;
    index = afterLine(text, fence + FENCE.length);
  }
  const waitingSince = index > message.consumed ? null : message.waitingSince;
  return {
    message: { ...message, consumed: index, inFence, lastBeatWasCode, waitingSince },
    beats,
  };
}

/** After enough waiting, a long run-on is cut at its last clause so speech never stalls. */
function settle(message: MessageSpeech, at: number) {
  const pending = message.inFence ? "" : message.text.slice(message.consumed);
  if (pending.trim() === "") return { message: { ...message, waitingSince: null }, beats: [] };
  const since = message.waitingSince ?? at;
  const cut =
    at - since >= CLAUSE_CUT_AFTER_MS && pending.trim().length >= CLAUSE_CUT_MIN_CHARS
      ? clauseCut(pending)
      : null;
  if (cut === null) return { message: { ...message, waitingSince: since }, beats: [] };
  const beat = spokenText(pending.slice(0, cut));
  return {
    message: {
      ...message,
      consumed: message.consumed + cut,
      waitingSince: at,
      lastBeatWasCode: beat === null && message.lastBeatWasCode,
    },
    beats: beat === null ? [] : [beat],
  };
}

function clauseCut(pending: string): number | null {
  let cut: number | null = null;
  for (const match of pending.matchAll(/[,;:](?=\s)|\s[—–-]\s/g)) {
    cut = match.index + match[0].length;
  }
  if (cut !== null) return cut;
  const space = pending.trimEnd().lastIndexOf(" ");
  return space > 0 ? space : null;
}

/**
 * The end of the first sentence in `text[from, to)`: a newline, or `.`, `!` or `?` (with any
 * closing quote or emphasis) before whitespace. An ellipsis or a list number is not an end.
 */
function sentenceEnd(text: string, from: number, to: number, endConfirmed: boolean) {
  for (let index = from; index < to; index++) {
    const char = text[index];
    if (char === "\n") return index + 1;
    if (char !== "." && char !== "!" && char !== "?") continue;
    if (char === "." && (text[index - 1] === "." || text[index + 1] === ".")) continue;
    if (char === "." && /^\s*\d+$/.test(text.slice(text.lastIndexOf("\n", index - 1) + 1, index)))
      continue;
    let end = index + 1;
    while (end < to && SENTENCE_CLOSERS.has(text[end] ?? "")) end++;
    if (end === to) return endConfirmed ? end : null;
    if (/\s/.test(text[end] ?? "")) return end;
  }
  return null;
}

function afterLine(text: string, from: number) {
  const newline = text.indexOf("\n", from);
  return newline === -1 ? text.length : newline + 1;
}

function trailingBackticks(text: string) {
  let count = 0;
  while (count < FENCE.length - 1 && text[text.length - 1 - count] === "`") count++;
  return count;
}

/** Backticks a later snapshot may complete into a fence stay unconsumed. */
function partialFenceLength(message: MessageSpeech) {
  return message.inFence || message.consumed === message.text.length
    ? 0
    : trailingBackticks(message.text);
}

/** A beat as captioned: audio tags like `[chuckles]` are performed, not shown. */
export function captionText(beat: string): string {
  return beat
    .replace(/\[[^\]\n]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function spokenText(raw: string): string | null {
  const text = raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, "")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])\*([^*\s](?:[^*]*[^*\s])?)\*(?!\w)/g, "$1$2")
    .replace(/(^|\W)_([^_\s](?:[^_]*[^_\s])?)_(?!\w)/g, "$1$2")
    .replace(/`+/g, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /[\p{L}\p{N}]/u.test(text) ? text : null;
}
