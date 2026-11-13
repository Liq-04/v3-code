import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const persisted = vi.hoisted(() => ({ title: "" }));
const openMenu = vi.hoisted(() => vi.fn());
const overlapState = vi.hoisted(() => ({ atom: null as Atom.Atom<ReadonlyArray<unknown>> | null }));
vi.mock("~/state/codeMap", () => ({
  threadOverlapsAtom: () => (overlapState.atom ??= Atom.make([])),
}));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() =>
    async ({ input }: { input: { title: string } }) => {
      persisted.title = input.title;
      return { _tag: "Success" };
    }) as never,
}));
vi.mock(import("~/hooks/useThreadActionMenu"), () => ({
  useThreadActionMenu: () => ({ openMenu, closeMenu: () => {} }),
}));

import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { render, stubGlobal } from "../../../test/render";
import { selectActiveRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";
import { useCodeMapFocusStore } from "../map/codeMapFocusStore";
import { ChatHeader } from "./ChatHeader";

function header(title: string) {
  return (
    <>
      <ChatHeader
        activeThreadEnvironmentId={EnvironmentId.make("environment")}
        activeThreadId={ThreadId.make("thread")}
        activeThreadTitle={title}
        isServerThread
        activeProject={null}
        parentThreadLink={null}
        onOpenThread={() => {}}
        rightPanelOpen={false}
        onNewThreadInProject={() => {}}
      />
      <div tabIndex={0}>Outside rename</div>
    </>
  );
}

it.each(["blur", "Enter"] as const)(
  "preserves a concurrent title update when an untouched rename ends with %s",
  async (finish) => {
    persisted.title = "New thread";
    await using screen = await render(header(persisted.title));
    await screen.getByRole("button", { name: "Thread actions for New thread" }).dblClick();
    const input = screen.getByRole("textbox", { name: "Thread title" });
    await expect.element(input).toHaveValue("New thread");

    persisted.title = "Fix login redirect";
    await screen.rerender(header(persisted.title));
    if (finish === "Enter") await userEvent.keyboard("{Enter}");
    else await screen.getByText("Outside rename").click();

    await expect.element(input).not.toBeInTheDocument();
    expect(persisted.title).toBe("Fix login redirect");

    await screen.rerender(header(persisted.title));
    await screen.getByRole("button", { name: "Thread actions for Fix login redirect" }).dblClick();
    await screen.getByRole("textbox", { name: "Thread title" }).fill("My edited title");
    persisted.title = "Another concurrent title";
    await screen.rerender(header(persisted.title));
    await userEvent.keyboard("{Enter}");
    await expect
      .element(screen.getByRole("textbox", { name: "Thread title" }))
      .not.toBeInTheDocument();
    expect(persisted.title).toBe("My edited title");
  },
);

it("opens the thread menu on a desktop title click without waiting", async () => {
  openMenu.mockClear();
  using _bridge = stubGlobal("desktopBridge", {});
  await using screen = await render(header("New thread"));
  await screen.getByRole("button", { name: "Thread actions for New thread" }).click();
  expect(openMenu).toHaveBeenCalledOnce();
});

const threadRef = scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("thread"));

function overlapsHeader(overlaps: ReadonlyArray<{ path: string; otherTitles: string[] }>) {
  useRightPanelStore.setState({ byThreadKey: {} });
  useCodeMapFocusStore.setState({ selected: null });
  overlapState.atom = Atom.make(overlaps);
  const registry = AtomRegistry.make();
  return {
    ui: <RegistryContext.Provider value={registry}>{header("Thread")}</RegistryContext.Provider>,
    [Symbol.dispose]: () => registry.dispose(),
  };
}

it("hides the shared-files pill when no file is shared", async () => {
  using context = overlapsHeader([]);
  await using screen = await render(context.ui);
  await expect.element(screen.getByText(/Shares \d+ file/)).not.toBeInTheDocument();
});

it.each([
  {
    label: "Shares 1 file",
    overlaps: [{ path: "src/a.ts", otherTitles: ["Other thread"] }],
  },
  {
    label: "Shares 2 files",
    overlaps: [
      { path: "src/a.ts", otherTitles: ["Other thread"] },
      { path: "src/b.ts", otherTitles: ["Other thread", "Third"] },
    ],
  },
])("shows $label and opens the Map tab on the first shared file", async ({ label, overlaps }) => {
  using context = overlapsHeader(overlaps);
  await using screen = await render(context.ui);
  await screen.getByRole("button", { name: label }).click();
  expect(
    selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
  ).toMatchObject({
    kind: "map",
  });
  expect(useCodeMapFocusStore.getState().selected).toEqual({
    threadKey: "environment:thread",
    path: "src/a.ts",
  });
});

it("opens the Map tab from the pill with Enter", async () => {
  using context = overlapsHeader([{ path: "src/a.ts", otherTitles: ["Other thread"] }]);
  await using screen = await render(context.ui);
  screen.getByRole("button", { name: "Shares 1 file" }).element().focus();
  await userEvent.keyboard("{Enter}");
  expect(
    selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
  ).toMatchObject({
    kind: "map",
  });
});
