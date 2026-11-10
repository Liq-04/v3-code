import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";

import { useRightPanelStore } from "../rightPanelStore";

export function usePinnedMapReveal(threadKey: string | null, sheet: boolean) {
  const reveal = useEffectEvent((ref: ScopedThreadRef) => {
    if (!sheet) useRightPanelStore.getState().revealPinnedMap(ref);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- arriving at a thread opens its right panel on the pinned map in the right panel store
  useEffect(() => {
    const ref = threadKey === null ? null : parseScopedThreadKey(threadKey);
    if (ref) reveal(ref);
  }, [threadKey]);
}
