import type { DiscussionCallPhase } from "@t3tools/contracts";

/** What the client's voice activity detection reports. */
export type CallVoice = "idle" | "hearing";
/** The thread's run as the projection shows it. */
export type CallRun = "idle" | "running" | "needsApproval";

export interface CallPhaseInputs {
  readonly voice: CallVoice;
  readonly run: CallRun;
  /** Beats written after the user's latest line are queued or playing. */
  readonly freshBeats: boolean;
}

/** The phase is derived, never stored, so it cannot drift from its inputs. */
export function callPhase({ voice, run, freshBeats }: CallPhaseInputs): DiscussionCallPhase {
  if (voice === "hearing") return "hearing";
  if (run === "needsApproval") return "waiting";
  if (freshBeats) return "speaking";
  if (run === "running") return "thinking";
  return "listening";
}

/** A new call opens on the run's phase: a pending approval shows at once, not "listening". */
export function openingPhase(run: CallRun): DiscussionCallPhase {
  return callPhase({ voice: "idle", run, freshBeats: false });
}

/**
 * A line with no words after a cut (a cough, echo) resumes the cut reply only while the agent is
 * still working. Once it finished or asked for approval, the call settles instead.
 */
export function resumesCutReply({ cut, run }: { readonly cut: boolean; readonly run: CallRun }) {
  return cut && run === "running";
}
