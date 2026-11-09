import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { PointerEvent } from "react";
import { create } from "zustand";

interface CodeMapFocusState {
  selected: { readonly threadKey: string; readonly path: string } | null;
  hoveredPath: string | null;
}

export const useCodeMapFocusStore = create<CodeMapFocusState>(() => ({
  selected: null,
  hoveredPath: null,
}));

export function selectCodeMapPath(threadRef: ScopedThreadRef, path: string) {
  useCodeMapFocusStore.setState({ selected: { threadKey: scopedThreadKey(threadRef), path } });
}

export function useSelectedCodeMapPath(threadRef: ScopedThreadRef): string | null {
  const key = scopedThreadKey(threadRef);
  return useCodeMapFocusStore((state) =>
    state.selected?.threadKey === key ? state.selected.path : null,
  );
}

export function hoverCodeMapPath(path: string | null) {
  if (useCodeMapFocusStore.getState().hoveredPath !== path) {
    useCodeMapFocusStore.setState({ hoveredPath: path });
  }
}

/** Spread on a container of `data-map-path` rows so hovering one costs no row a render. */
export const codeMapHoverHandlers = {
  onPointerOver: (event: PointerEvent<HTMLElement>) => {
    const row = (event.target as Element).closest<HTMLElement>("[data-map-path]");
    hoverCodeMapPath(row?.dataset.mapPath ?? null);
  },
  onPointerLeave: () => hoverCodeMapPath(null),
};
