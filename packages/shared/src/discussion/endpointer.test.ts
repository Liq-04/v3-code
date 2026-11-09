import { describe, expect, it } from "vite-plus/test";

import {
  type EndpointerConfig,
  type EndpointerEdge,
  type EndpointerInput,
  initialEndpointer,
  stepEndpointer,
} from "./endpointer.ts";

const open: EndpointerConfig = { mode: "open", endOfSpeechMs: 600 };
const push: EndpointerConfig = { mode: "push", endOfSpeechMs: 600 };

/** Level frames every 50 ms from `from`, one per entry. */
const frames = (from: number, levels: ReadonlyArray<number>, agentSpeaking = false) =>
  levels.map((level, index): EndpointerInput => ({
    type: "level",
    level,
    at: from + index * 50,
    agentSpeaking,
  }));

/** Each edge with the time of the input that produced it. */
function edges(inputs: ReadonlyArray<EndpointerInput>, config: EndpointerConfig) {
  let state = initialEndpointer;
  const found: Array<EndpointerEdge & { readonly on: number }> = [];
  for (const input of inputs) {
    const step = stepEndpointer(state, input, config);
    state = step.state;
    if (step.edge !== null) found.push({ ...step.edge, on: input.at });
  }
  return found;
}

describe("stepEndpointer", () => {
  it.each<[string, ReadonlyArray<EndpointerInput>, EndpointerConfig, ReadonlyArray<unknown>]>([
    [
      "starts after 100 ms above the threshold, dated from the first loud frame",
      frames(0, [0.1, 0.1, 0.1]),
      open,
      [{ edge: "start", at: 0, on: 100 }],
    ],
    [
      "ignores a blip shorter than the onset",
      frames(0, [0.1, 0.1, 0, 0.1, 0.1, 0.1]),
      open,
      [{ edge: "start", at: 150, on: 250 }],
    ],
    [
      "ends after the end-of-speech silence, dated from the last loud frame",
      frames(0, [0.1, 0.1, 0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      open,
      [
        { edge: "start", at: 0, on: 100 },
        { edge: "end", at: 150, on: 750 },
      ],
    ],
    [
      "keeps the line open through a pause shorter than the silence",
      frames(0, [0.1, 0.1, 0.1, 0, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      open,
      [
        { edge: "start", at: 0, on: 100 },
        { edge: "end", at: 450, on: 1_050 },
      ],
    ],
    [
      "honors a custom silence",
      frames(0, [0.1, 0.1, 0.1, 0, 0, 0, 0, 0, 0, 0]),
      { ...open, endOfSpeechMs: 300 },
      [
        { edge: "start", at: 0, on: 100 },
        { edge: "end", at: 150, on: 450 },
      ],
    ],
    [
      "needs the raised threshold over the agent's voice",
      frames(0, [0.04, 0.04, 0.04, 0.04, 0.04, 0.04, 0.04], true),
      open,
      [],
    ],
    [
      "needs 250 ms of speech over the agent's voice",
      frames(0, [0.1, 0.1, 0.1, 0.1, 0.1, 0.1], true),
      open,
      [{ edge: "start", at: 0, on: 250 }],
    ],
    [
      "ignores press and release in open mic",
      [
        { type: "press", at: 0 },
        { type: "release", at: 100 },
      ],
      open,
      [],
    ],
    [
      "uses press and release as the edges in push to talk, and ignores levels",
      [
        { type: "release", at: 0 },
        ...frames(0, [0.5, 0.5, 0.5]),
        { type: "press", at: 200 },
        { type: "press", at: 250 },
        ...frames(300, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        { type: "release", at: 1_200 },
      ],
      push,
      [
        { edge: "start", at: 200, on: 200 },
        { edge: "end", at: 1_200, on: 1_200 },
      ],
    ],
  ])("%s", (_name, inputs, config, expected) => {
    expect(edges(inputs, config)).toEqual(expected);
  });
});
