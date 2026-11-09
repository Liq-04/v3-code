import type { DiscussionMicMode } from "@t3tools/contracts";

const ONSET_MS = 100;
/** Over the agent's voice, onset needs longer and louder speech so echo does not cut it off. */
const ONSET_OVER_AGENT_MS = 250;
const DEFAULT_THRESHOLD = 0.02;
const DEFAULT_THRESHOLD_OVER_AGENT = 0.06;

export interface EndpointerConfig {
  readonly mode: DiscussionMicMode;
  readonly endOfSpeechMs: number;
  /** Frame RMS level, 0 to 1, that counts as speech. */
  readonly threshold?: number;
  readonly thresholdOverAgent?: number;
}

export type EndpointerState =
  | { readonly speaking: false; readonly aboveSince: number | null }
  | { readonly speaking: true; readonly belowSince: number | null };

export const initialEndpointer: EndpointerState = { speaking: false, aboveSince: null };

export type EndpointerInput =
  | {
      readonly type: "level";
      readonly level: number;
      readonly at: number;
      readonly agentSpeaking: boolean;
    }
  | { readonly type: "press"; readonly at: number }
  | { readonly type: "release"; readonly at: number };

/** `at` is when speech began or last sounded, so a caller can keep pre-roll and trim silence. */
export type EndpointerEdge = { readonly edge: "start" | "end"; readonly at: number };

export interface EndpointerStep {
  readonly state: EndpointerState;
  readonly edge: EndpointerEdge | null;
}

/** Open mic reads level frames; push to talk reads the press and release edges. */
export function stepEndpointer(
  state: EndpointerState,
  input: EndpointerInput,
  config: EndpointerConfig,
): EndpointerStep {
  if (config.mode === "push") {
    if (input.type === "press" && !state.speaking) {
      return { state: { speaking: true, belowSince: null }, edge: { edge: "start", at: input.at } };
    }
    if (input.type === "release" && state.speaking) {
      return { state: initialEndpointer, edge: { edge: "end", at: input.at } };
    }
    return { state, edge: null };
  }
  if (input.type !== "level") return { state, edge: null };

  const threshold = input.agentSpeaking
    ? (config.thresholdOverAgent ?? DEFAULT_THRESHOLD_OVER_AGENT)
    : (config.threshold ?? DEFAULT_THRESHOLD);
  const above = input.level >= threshold;
  if (state.speaking) {
    if (above) return { state: { speaking: true, belowSince: null }, edge: null };
    const belowSince = state.belowSince ?? input.at;
    return input.at - belowSince >= config.endOfSpeechMs
      ? { state: initialEndpointer, edge: { edge: "end", at: belowSince } }
      : { state: { speaking: true, belowSince }, edge: null };
  }
  if (!above) return { state: initialEndpointer, edge: null };
  const aboveSince = state.aboveSince ?? input.at;
  const onsetMs = input.agentSpeaking ? ONSET_OVER_AGENT_MS : ONSET_MS;
  return input.at - aboveSince >= onsetMs
    ? { state: { speaking: true, belowSince: null }, edge: { edge: "start", at: aboveSince } }
    : { state: { speaking: false, aboveSince }, edge: null };
}
