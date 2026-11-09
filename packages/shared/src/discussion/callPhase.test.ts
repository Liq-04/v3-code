import { describe, expect, it } from "vite-plus/test";

import {
  callPhase,
  type CallPhaseInputs,
  type CallRun,
  openingPhase,
  resumesCutReply,
} from "./callPhase.ts";

const allInputs: ReadonlyArray<CallPhaseInputs> = (["idle", "hearing"] as const).flatMap((voice) =>
  (["idle", "running", "needsApproval"] as const).flatMap((run) =>
    [false, true].map((freshBeats) => ({ voice, run, freshBeats })),
  ),
);

describe("callPhase", () => {
  it.each([
    ["idle", "idle", false, "listening"],
    ["idle", "idle", true, "speaking"],
    ["idle", "running", false, "thinking"],
    ["idle", "running", true, "speaking"],
    ["idle", "needsApproval", false, "waiting"],
    ["idle", "needsApproval", true, "waiting"],
    ["hearing", "idle", false, "hearing"],
    ["hearing", "idle", true, "hearing"],
    ["hearing", "running", false, "hearing"],
    ["hearing", "running", true, "hearing"],
    ["hearing", "needsApproval", false, "hearing"],
    ["hearing", "needsApproval", true, "hearing"],
  ] as const)("voice %s, run %s, fresh beats %s is %s", (voice, run, freshBeats, phase) => {
    expect(callPhase({ voice, run, freshBeats })).toBe(phase);
  });

  it.each(allInputs)("NoStaleSpeech: speaks only fresh beats (%o)", (inputs) => {
    expect(callPhase(inputs) !== "speaking" || inputs.freshBeats).toBe(true);
  });

  it.each(allInputs)("ApprovalIsShown: a pending approval stays visible (%o)", (inputs) => {
    const shown = ["waiting", "hearing"].includes(callPhase(inputs));
    expect(inputs.run !== "needsApproval" || shown).toBe(true);
  });
});

describe("openingPhase", () => {
  // The checker's first bug: a call started during an approval opened on "listening".
  it.each([
    ["idle", "listening"],
    ["running", "thinking"],
    ["needsApproval", "waiting"],
  ] as const)("a call started while the run is %s opens on %s", (run, phase) => {
    expect(openingPhase(run)).toBe(phase);
  });
});

describe("resumesCutReply", () => {
  const afterNoWords = (cut: boolean, run: CallRun) => {
    const resume = resumesCutReply({ cut, run });
    return { resume, phase: callPhase({ voice: "idle", run, freshBeats: resume }) };
  };

  it.each([
    [true, "running", true, "speaking"],
    // The checker's second bug: the cut reply resumed over a request made while you talked.
    [true, "needsApproval", false, "waiting"],
    [true, "idle", false, "listening"],
    [false, "running", false, "thinking"],
    [false, "needsApproval", false, "waiting"],
    [false, "idle", false, "listening"],
  ] as const)(
    "a noise with cut %s while the run is %s resumes %s, then %s",
    (cut, run, resume, phase) => {
      expect(afterNoWords(cut, run)).toEqual({ resume, phase });
    },
  );
});
