import { RegistryContext } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  deriveCodeMap,
  type CodeMapChange,
  type CodeMapThreadInput,
} from "@t3tools/client-runtime/state/code-map";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ProjectCodeMapSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom, AtomRegistry } from "effect/reactivity";
import { Profiler } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import type { CodeMapView } from "~/state/codeMap";

const state = vi.hoisted(() => ({ view: null as unknown as Atom.Writable<CodeMapView> }));

vi.mock("~/state/codeMap", () => ({
  codeMapViewAtom: () => state.view,
  codeMapSnapshotAtom: () => state.view,
}));
vi.mock("~/state/entities", () => ({
  useThreadShell: () => ({ projectId: "project" }),
  useThreadShellsForProjectRefs: () => [
    { id: "a", title: "Code map" },
    { id: "b", title: "Checkpoint diff stalls" },
  ],
}));

import { CodeMapPanel } from "./CodeMapPanel";
import { codeMapHoverHandlers, selectCodeMapPath, useCodeMapFocusStore } from "./codeMapFocusStore";
import { selectActiveRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";

const PROJECT = "/work/app";
const CHAT_VIEW = "apps/web/ChatView.tsx";
const INDEX_CSS = "apps/web/index.css";
const ORCH = "packages/contracts/orchestrationV2.ts";
const GIT = "packages/contracts/git.ts";
const ref = scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("a"));

const snapshot: ProjectCodeMapSnapshot = {
  treeSha: "8e1581ad8f00",
  baseRef: "main",
  files: {
    paths: [CHAT_VIEW, INDEX_CSS, ORCH, GIT],
    lines: [1600, 1300, 4200, 700],
    vendored: [false, false, false, false],
  },
  folders: [
    { path: "apps", fileCount: 2, lines: 2900 },
    { path: "apps/web", fileCount: 2, lines: 2900 },
    { path: "packages", fileCount: 2, lines: 4900 },
    { path: "packages/contracts", fileCount: 2, lines: 4900 },
  ],
  filesTotal: 4,
};

function thread(
  id: string,
  opts: { running?: boolean; finished?: boolean; active?: string | null },
): CodeMapThreadInput {
  return {
    id: ThreadId.make(id),
    worktreePath: `/wt/${id}`,
    archivedAt: null,
    deletedAt: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default",
    latestRun: null,
    runtime: {
      status: opts.running ? "running" : opts.finished ? "completed" : "idle",
      activeRunId: null,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: null,
      lastError: null,
      updatedAt: "2026-06-01T00:00:00.000Z",
    },
    source: {
      activeFile: opts.active
        ? { path: opts.active, op: "edit", at: DateTime.makeUnsafe("2026-06-01T00:00:00.000Z") }
        : undefined,
    },
  };
}

const change = (path: string): CodeMapChange => ({ path, insertions: 4, deletions: 1 });

function view(
  threads: CodeMapThreadInput[],
  changes: Record<string, CodeMapChange[]>,
): CodeMapView {
  const model = deriveCodeMap({
    snapshot,
    threads,
    changesByRoot: new Map(Object.entries(changes)),
    projectRoot: PROJECT,
  });
  return {
    status: "ready",
    treeSha: snapshot.treeSha,
    baseRef: snapshot.baseRef,
    model,
    markedPaths: model.marks.map((mark) => mark.path).sort(),
  };
}

const twoThreads = () =>
  view(
    [
      thread("a", { running: true, active: CHAT_VIEW }),
      thread("b", { running: true, active: GIT }),
    ],
    { "/wt/a": [change(CHAT_VIEW), change(ORCH)], "/wt/b": [change(GIT), change(ORCH)] },
  );

function setup(initial: CodeMapView) {
  useRightPanelStore.setState({ byThreadKey: {} });
  useCodeMapFocusStore.setState({ selected: null, hoveredPath: null });
  state.view = Atom.make(initial);
  const registry = AtomRegistry.make();
  const container = document.createElement("div");
  container.style.cssText = "display:flex;flex-direction:column;width:640px;height:480px";
  const ui = (
    <RegistryContext.Provider value={registry}>
      <CodeMapPanel threadRef={ref} />
    </RegistryContext.Provider>
  );
  return { registry, container, ui, [Symbol.dispose]: () => registry.dispose() };
}

const cell = (screen: { container: HTMLElement }, path: string) =>
  screen.container.querySelector<HTMLElement>(`button[data-path="${path}"]`)!;
const sprite = (screen: { container: HTMLElement }, threadId: string) =>
  screen.container.querySelector<HTMLElement>(
    `[data-testid="code-map-sprite"][data-thread-id="${threadId}"]`,
  );

it("opens a file from its cell in this thread's worktree", async () => {
  using context = setup(twoThreads());
  await using screen = await render(context.ui, { container: context.container });
  await userEvent.click(cell(screen, CHAT_VIEW));
  expect(
    selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref),
  ).toMatchObject({ kind: "file", relativePath: CHAT_VIEW });
});

it("opens the other thread for a file only it changed", async () => {
  using context = setup(twoThreads());
  await using screen = await render(context.ui, { container: context.container });
  using navigate = vi.spyOn(screen.router!, "navigate").mockResolvedValue(undefined);
  await userEvent.click(cell(screen, GIT));
  expect(navigate).toHaveBeenCalledWith(
    expect.objectContaining({ params: expect.objectContaining({ threadId: "b" }) }),
  );
  expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref)).toBeNull();
});

it("fades the other thread until the scope switches to All", async () => {
  using context = setup(twoThreads());
  await using screen = await render(context.ui, { container: context.container });
  expect(cell(screen, GIT).dataset.strength).toBe("faint");
  expect(cell(screen, CHAT_VIEW).dataset.strength).toBe("strong");
  expect(sprite(screen, "b")!.className).toContain("opacity-50");
  expect(sprite(screen, "b")!.querySelector('[data-testid="code-map-say"]')).toBeNull();
  expect(sprite(screen, "a")!.querySelector('[data-testid="code-map-say"]')).toHaveTextContent(
    "Edit ChatView.tsx",
  );

  await userEvent.click(screen.getByRole("button", { name: "All" }));
  await expect.poll(() => cell(screen, GIT).dataset.strength).toBe("strong");
  expect(sprite(screen, "b")!.className).not.toContain("opacity-50");
  expect(sprite(screen, "b")!.querySelector('[data-testid="code-map-say"]')).toHaveTextContent(
    "Edit git.ts",
  );
});

it("stripes a file both threads changed and flags it", async () => {
  using context = setup(twoThreads());
  await using screen = await render(context.ui, { container: context.container });
  const overlap = cell(screen, ORCH);
  expect(overlap.dataset.marked).toBe("overlap");
  expect(overlap.style.background).toContain("repeating-linear-gradient");
  expect(overlap.querySelector('[aria-label="Changed in two threads"]')).not.toBeNull();
  expect(cell(screen, CHAT_VIEW).dataset.marked).toBe("mine");
  expect(cell(screen, GIT).dataset.marked).toBe("other");
});

it("draws a sprite for each running thread and none for a finished one", async () => {
  using context = setup(
    view([thread("a", { running: true, active: CHAT_VIEW }), thread("b", { finished: true })], {
      "/wt/a": [change(CHAT_VIEW)],
      "/wt/b": [change(GIT)],
    }),
  );
  await using screen = await render(context.ui, { container: context.container });
  expect(screen.container.querySelectorAll('[data-testid="code-map-sprite"]')).toHaveLength(1);
  expect(sprite(screen, "a")!.dataset.path).toBe(CHAT_VIEW);
  expect(cell(screen, GIT).dataset.strength).toBe("faint");
});

it("moves the ring and the sprite to the new file, and keeps them when the path goes quiet", async () => {
  using context = setup(twoThreads());
  await using screen = await render(context.ui, { container: context.container });
  const before = sprite(screen, "a")!.style.transform;
  expect(cell(screen, CHAT_VIEW).style.boxShadow).not.toBe("");

  await act(() =>
    context.registry.set(
      state.view,
      view(
        [thread("a", { running: true, active: ORCH }), thread("b", { running: true, active: GIT })],
        { "/wt/a": [change(CHAT_VIEW), change(ORCH)], "/wt/b": [change(GIT), change(ORCH)] },
      ),
    ),
  );
  expect(cell(screen, CHAT_VIEW).style.boxShadow).toBe("");
  expect(cell(screen, ORCH).style.boxShadow).not.toBe("");
  expect(sprite(screen, "a")!.dataset.path).toBe(ORCH);
  const moved = sprite(screen, "a")!.style.transform;
  expect(moved).not.toBe(before);

  await act(() =>
    context.registry.set(
      state.view,
      view(
        [thread("a", { running: true, active: null }), thread("b", { running: true, active: GIT })],
        { "/wt/a": [change(CHAT_VIEW), change(ORCH)], "/wt/b": [change(GIT), change(ORCH)] },
      ),
    ),
  );
  expect(sprite(screen, "a")!.dataset.path).toBe(ORCH);
  expect(sprite(screen, "a")!.style.transform).toBe(moved);
  expect(cell(screen, ORCH).style.boxShadow).not.toBe("");
});

it("outlines the cell of a hovered timeline row without re-rendering the row", async () => {
  using context = setup(twoThreads());
  const rowRenders = vi.fn();
  await using screen = await render(
    <>
      <div {...codeMapHoverHandlers}>
        <Profiler id="row" onRender={rowRenders}>
          <div data-map-path={ORCH}>Edit orchestrationV2.ts</div>
          <div>Plain row</div>
        </Profiler>
      </div>
      {context.ui}
    </>,
    { container: context.container },
  );
  const orchCell = cell(screen, ORCH);
  await expect.element(orchCell).not.toHaveAttribute("data-focus");
  const rendersBefore = rowRenders.mock.calls.length;

  await screen.getByText("Edit orchestrationV2.ts").hover();
  await expect.element(orchCell).toHaveAttribute("data-focus", "hovered");
  await expect.element(orchCell).toHaveStyle({ outlineStyle: "solid" });

  await screen.getByText("Plain row").hover();
  await expect.element(orchCell).not.toHaveAttribute("data-focus");
  expect(rowRenders.mock.calls.length).toBe(rendersBefore);
});

it("outlines the cell chosen from the header pill", async () => {
  using context = setup(twoThreads());
  selectCodeMapPath(ref, ORCH);
  await using screen = await render(context.ui, { container: context.container });
  await expect.element(cell(screen, ORCH)).toHaveAttribute("data-focus", "selected");
  await expect.element(cell(screen, GIT)).not.toHaveAttribute("data-focus");
});
