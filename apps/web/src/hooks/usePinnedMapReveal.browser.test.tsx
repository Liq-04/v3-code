import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { render } from "../../test/render";
import {
  selectActiveRightPanel,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import { usePinnedMapReveal } from "./usePinnedMapReveal";

const threadRef = (id: string) => scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make(id));
const active = (ref: ScopedThreadRef) =>
  selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, ref);

function Arrival(props: { readonly at: ScopedThreadRef; readonly sheet: boolean }) {
  usePinnedMapReveal(scopedThreadKey(props.at), props.sheet);
  return null;
}

it("reveals the pinned map once on arriving at a thread, and never into a sheet", async () => {
  const [pinned, visited, narrow] = [
    threadRef("pinned"),
    threadRef("visited"),
    threadRef("narrow"),
  ];
  useRightPanelStore.setState({ byThreadKey: {}, mapPinned: false });
  useRightPanelStore.getState().open(pinned, "map");

  // The hook reads no route.
  await using screen = await render(<Arrival at={visited} sheet={false} />, { router: false });
  expect(active(visited)).toBe("map");

  useRightPanelStore.getState().open(visited, "diff");
  await screen.rerender(<Arrival at={visited} sheet />);
  await screen.rerender(<Arrival at={visited} sheet={false} />);
  expect(active(visited)).toBe("diff");

  await screen.rerender(<Arrival at={narrow} sheet />);
  await screen.rerender(<Arrival at={narrow} sheet={false} />);
  expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, narrow)).toEqual({
    isOpen: false,
    activeSurfaceId: null,
    surfaces: [],
  });
  expect(useRightPanelStore.getState().mapPinned).toBe(true);
});
