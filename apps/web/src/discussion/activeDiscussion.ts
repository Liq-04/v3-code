import {
  type DiscussionCall,
  type DiscussionEnvironment,
  getEnvironmentDiscussionStreamUrl,
  openDiscussion,
} from "@t3tools/client-runtime/discussion";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  type AtomCommand,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { DiscussionId, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { toastManager } from "../components/ui/toast";
import { getClientSettings } from "../hooks/useSettings";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { runEnvironmentSpeech } from "../speech/runEnvironmentSpeech";
import { readPreparedConnection } from "../state/session";
import { serverEnvironment } from "../state/server";
import { environmentThreadDetails, threadEnvironment } from "../state/threads";
import { createBrowserDuplexAudio } from "./browserDuplexAudio";

/** The call this device holds the audio for. A device holds at most one: it has one microphone. */
export interface ActiveDiscussion {
  readonly threadRef: ScopedThreadRef;
  readonly threadKey: string;
  readonly call: DiscussionCall;
}

export const activeDiscussionAtom = Atom.make<ActiveDiscussion | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("discussion:active"),
);

async function runOrThrow<W, A, E>(command: AtomCommand<W, A, E>, input: W, label: string) {
  const result = await runAtomCommand(appAtomRegistry, command, input, {
    label,
    reportFailure: false,
  });
  if (result._tag === "Success") return result.value;
  if (isAtomCommandInterrupted(result)) throw new Error("The request was cancelled.");
  const error = squashAtomCommandFailure(result);
  throw error instanceof Error ? error : new Error(`Could not ${label}.`);
}

function discussionEnvironment(environmentId: EnvironmentId): DiscussionEnvironment {
  return {
    start: async (threadId) =>
      (
        await runOrThrow(
          serverEnvironment.startDiscussion,
          { environmentId, input: { threadId } },
          "start discussion",
        )
      ).discussionId,
    streamUrl: (discussionId) => {
      const prepared = readPreparedConnection(environmentId);
      if (prepared === null) return Promise.reject(new Error("The environment is not connected."));
      return runEnvironmentSpeech(getEnvironmentDiscussionStreamUrl(prepared, discussionId));
    },
    end: async (input) => {
      await runOrThrow(threadEnvironment.endDiscussion, { environmentId, input }, "end discussion");
    },
  };
}

const isLive = (active: ActiveDiscussion | null) => {
  const status = active?.call.getState().status;
  return status === "starting" || status === "live";
};

/** Whether this device holds a live call for `threadRef`. */
export const discussionHeldHereAtom = Atom.family((threadKey: string) =>
  Atom.make((get) => {
    const active = get(activeDiscussionAtom);
    if (active?.threadKey !== threadKey) return false;
    const status = get(active.call.state).status;
    return status === "starting" || status === "live";
  }).pipe(Atom.withLabel(`discussion:held:${threadKey}`)),
);

/** The thread's live call, from its marker, and whether this device holds the audio. */
export const threadCallAtom = Atom.family((threadKey: string) =>
  Atom.make((get) => {
    const ref = parseScopedThreadKey(threadKey);
    const thread = ref === null ? null : get(environmentThreadDetails.quietThreadAtom(ref));
    return {
      discussionId: thread?.projection.thread.discussion?.id ?? null,
      heldHere: get(discussionHeldHereAtom(threadKey)),
    };
  }).pipe(Atom.withLabel(`discussion:thread-call:${threadKey}`)),
);

export function useDiscussionHeldHere(threadRef: ScopedThreadRef): boolean {
  return useAtomValue(discussionHeldHereAtom(scopedThreadKey(threadRef)));
}

/**
 * Starts a call on `threadRef`, holding its audio here. Call it from the click or key press itself:
 * the browser only lets audio play from a user gesture.
 */
export function startDiscussionCall(threadRef: ScopedThreadRef): { readonly error: string | null } {
  const current = appAtomRegistry.get(activeDiscussionAtom);
  if (isLive(current))
    return {
      error:
        current?.threadKey === scopedThreadKey(threadRef)
          ? null
          : "You are already on a call in another thread. End it first.",
    };
  const settings = getClientSettings();
  const call = openDiscussion({
    threadId: threadRef.threadId,
    environment: discussionEnvironment(threadRef.environmentId),
    audio: createBrowserDuplexAudio({ microphoneId: settings.voiceMicrophone }),
    micMode: settings.discussionMicMode,
    endOfSpeechMs: settings.discussionEndOfSpeechMs,
  });
  const active = { threadRef, threadKey: scopedThreadKey(threadRef), call };
  // A call that ended cleanly leaves; a failed one stays so its strip can say why.
  const stop = call.subscribe(() => {
    if (call.getState().status === "starting" || call.getState().status === "live") return;
    stop();
    if (call.getState().status === "ended" && appAtomRegistry.get(activeDiscussionAtom) === active)
      appAtomRegistry.set(activeDiscussionAtom, null);
  });
  appAtomRegistry.set(activeDiscussionAtom, active);
  return { error: null };
}

export function dismissDiscussionCall(call: DiscussionCall): void {
  if (appAtomRegistry.get(activeDiscussionAtom)?.call === call)
    appAtomRegistry.set(activeDiscussionAtom, null);
}

/**
 * Hangs up the call on `threadRef` from this device, whichever device holds its audio. The held
 * call, when it is this one, stops at once.
 */
export async function endDiscussionCall(
  threadRef: ScopedThreadRef,
  discussionId: DiscussionId | null,
): Promise<void> {
  const active = appAtomRegistry.get(activeDiscussionAtom);
  if (active?.threadKey === scopedThreadKey(threadRef)) {
    await active.call.end();
    if (discussionId === null || discussionId === active.call.getState().discussionId) return;
  }
  if (discussionId === null) return;
  await discussionEnvironment(threadRef.environmentId).end({
    threadId: threadRef.threadId,
    discussionId,
    reason: "ended_by_user",
  });
}

/**
 * The keybinding and palette action: ends the call the thread is on, from any device, or starts
 * one held here. `discussionId` is the thread's live marker.
 */
export function toggleDiscussionCall(
  threadRef: ScopedThreadRef,
  discussionId: DiscussionId | null,
): void {
  if (
    discussionId !== null ||
    appAtomRegistry.get(discussionHeldHereAtom(scopedThreadKey(threadRef)))
  ) {
    void endDiscussionCall(threadRef, discussionId).catch((error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not end the call",
        description: error instanceof Error ? error.message : "Try again.",
      }),
    );
    return;
  }
  const { error } = startDiscussionCall(threadRef);
  if (error) toastManager.add({ type: "error", title: error });
}
