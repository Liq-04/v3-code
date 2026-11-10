import { RegistryContext } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  deriveCodeMap,
  type CodeMapChange,
  type CodeMapThreadInput,
} from "@t3tools/client-runtime/state/code-map";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ProjectCodeMapSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom, AtomRegistry } from "effect/reactivity";
import { Profiler } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, fakeTimers, render, type Screen } from "../../../test/render";
import type { CodeMapView } from "~/state/codeMap";

const state = vi.hoisted(() => ({ view: null as unknown as Atom.Writable<CodeMapView> }));

vi.mock("~/state/codeMap", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    codeMapViewAtom: () => state.view,
    codeMapSnapshotAtom: () => state.view,
    codeMapBasesAtom: Atom.make({}),
  };
});
vi.mock("~/state/entities", () => ({
  useThreadShell: () => ({ projectId: "project" }),
  useProject: () => null,
}));

import { CodeMapPanel } from "./CodeMapPanel";
import { codeMapHoverHandlers, selectCodeMapPath, useCodeMapFocusStore } from "./codeMapFocusStore";
import { buildWorld, rectOf } from "./mapWorld";
import { selectActiveRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";

const PROJECT = "/work/app";
const PROJECT_ID = ProjectId.make("project");
const CHAT_VIEW = "apps/web/ChatView.tsx";
const INDEX_CSS = "apps/web/index.css";
const ORCH = "packages/contracts/orchestrationV2.ts";
const GIT = "packages/contracts/git.ts";
const ref = scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("a"));

const snapshot: ProjectCodeMapSnapshot = {
  treeSha: "8e1581ad8f00",
  baseRef: "main",
  defaultBaseRef: "main",
  checkouts: [PROJECT],
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
  opts: { running?: boolean; finished?: boolean; active?: string | null; subagentOf?: string },
): CodeMapThreadInput {
  const root = `/wt/${opts.subagentOf ?? id}`;
  return {
    id: ThreadId.make(id),
    projectId: PROJECT_ID,
    worktreePath: root,
    archivedAt: null,
    deletedAt: null,
    lineage: {
      parentThreadId: opts.subagentOf ? ThreadId.make(opts.subagentOf) : null,
      relationshipToParent: opts.subagentOf ? "subagent" : null,
      rootThreadId: ThreadId.make(opts.subagentOf ?? id),
    },
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default",
    settledOverride: null,
    snoozedUntil: null,
    snoozedAt: null,
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
      activeRunId: opts.running ? RunId.make(`run:${id}`) : null,
      status: opts.running ? "running" : "idle",
      pendingRuntimeRequest: null,
      activeFile: opts.active
        ? {
            path: `${root}/${opts.active}`,
            op: "edit",
            at: DateTime.makeUnsafe("2026-06-01T00:00:00.000Z"),
          }
        : undefined,
    },
  };
}

const change = (path: string): CodeMapChange => ({ path, insertions: 4, deletions: 1 });

function view(
  threads: CodeMapThreadInput[],
  changes: Record<string, CodeMapChange[]>,
  reads: Record<string, string[]> = {},
): CodeMapView {
  const model = deriveCodeMap({
    snapshot,
    threads,
    changesByRoot: new Map(
      Object.entries(changes).map(([root, files]) => [root, { checkout: root, files }]),
    ),
    projectRoots: new Map([[PROJECT_ID, PROJECT]]),
    now: "2026-06-01T12:00:00.000Z",
    backfilledReads: new Map(
      Object.entries(reads).map(([id, paths]) => [ThreadId.make(id), paths]),
    ),
    observedReads: new Map(),
  });
  return {
    status: "ready",
    treeSha: snapshot.treeSha,
    baseKey: "repo",
    baseRef: snapshot.baseRef,
    defaultBaseRef: snapshot.defaultBaseRef,
    chosenBaseRef: null,
    files: snapshot.files,
    threadTitles: new Map([
      [ThreadId.make("a"), "Code map"],
      [ThreadId.make("b"), "Checkpoint diff stalls"],
    ]),
    threadProjectNames: new Map([[ThreadId.make("b"), "T3 Code"]]),
    model,
  };
}

const twoChanges = {
  "/wt/a": [change(CHAT_VIEW), change(ORCH)],
  "/wt/b": [change(GIT), change(ORCH)],
};

const twoThreads = () =>
  view(
    [
      thread("a", { running: true, active: CHAT_VIEW }),
      thread("b", { running: true, active: GIT }),
    ],
    twoChanges,
  );

function setup(initial: CodeMapView) {
  useRightPanelStore.setState({ byThreadKey: {} });
  useCodeMapFocusStore.setState({ selected: null, hoveredPath: null });
  localStorage.removeItem("t3code:code-map-scope:v1");
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

const canvasOf = (screen: Screen) =>
  screen.container.querySelector<HTMLCanvasElement>('[data-testid="code-map-canvas"]')!;
const cell = (screen: Screen, path: string) =>
  screen.container.querySelector<HTMLElement>(`button[data-path="${path}"]`)!;
const sprite = (screen: Screen, threadId: string) =>
  screen.container.querySelector<HTMLElement>(
    `[data-testid="code-map-sprite"][data-thread-id="${threadId}"]`,
  );

function centreOf(screen: Screen, path: string) {
  const stage = screen.container.querySelector<HTMLElement>('[data-testid="code-map"]')!;
  const world = buildWorld(snapshot.files, [], stage.clientWidth, stage.clientHeight);
  const rect = rectOf(world, path)!;
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, rect };
}

function pixel(canvas: HTMLCanvasElement, x: number, y: number) {
  const dpr = window.devicePixelRatio || 1;
  const data = canvas
    .getContext("2d")!
    .getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
  return `${data[0]},${data[1]},${data[2]}`;
}

it("opens the file under the pointer in this thread's worktree", async () => {
  using context = setup(twoThreads());
  await using screen = await render(context.ui, { container: context.container });
  const { x, y } = centreOf(screen, CHAT_VIEW);
  await userEvent.click(canvasOf(screen), { position: { x, y } });
  expect(
    selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref),
  ).toMatchObject({ kind: "file", relativePath: CHAT_VIEW });
});

it("opens the other thread for a file only it changed", async () => {
  using context = setup(twoThreads());
  await using screen = await render(context.ui, { container: context.container });
  using navigate = vi.spyOn(screen.router!, "navigate").mockResolvedValue(undefined);
  const { x, y } = centreOf(screen, GIT);
  await userEvent.click(canvasOf(screen), { position: { x, y } });
  expect(navigate).toHaveBeenCalledWith(
    expect.objectContaining({ params: expect.objectContaining({ threadId: "b" }) }),
  );
  expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref)).toBeNull();
});

it("fades the other thread until the scope switches to All, and a reopened map keeps All", async () => {
  using context = setup(twoThreads());
  await using screen = await render(context.ui, { container: context.container });
  expect(cell(screen, GIT).dataset.strength).toBe("faint");
  expect(cell(screen, CHAT_VIEW).dataset.strength).toBe("strong");
  expect(cell(screen, ORCH).dataset.marked).toBe("overlap");
  expect(cell(screen, GIT).dataset.marked).toBe("other");
  expect(sprite(screen, "b")!.className).toContain("opacity-50");
  expect(sprite(screen, "b")!.querySelector('[data-testid="code-map-say"]')).toBeNull();
  expect(sprite(screen, "a")!.querySelector('[data-testid="code-map-say"]')).toHaveTextContent(
    "Edit ChatView.tsx",
  );

  await userEvent.click(screen.getByRole("button", { name: "All" }));
  await expect.poll(() => cell(screen, GIT).dataset.strength).toBe("strong");
  expect(sprite(screen, "b")!.className).not.toContain("opacity-50");

  const container = document.createElement("div");
  container.style.cssText = context.container.style.cssText;
  await using reopened = await render(
    <RegistryContext.Provider value={context.registry}>
      <CodeMapPanel threadRef={ref} />
    </RegistryContext.Provider>,
    { container },
  );
  await expect.poll(() => cell(reopened, GIT).dataset.strength).toBe("strong");
});

it("paints marked files over the background", async () => {
  using context = setup(twoThreads());
  await using screen = await render(context.ui, { container: context.container });
  const canvas = canvasOf(screen);
  const { x, y } = centreOf(screen, ORCH);
  const background = getComputedStyle(canvas.parentElement!).backgroundColor;
  await vi.waitFor(() => expect(`rgb(${pixel(canvas, x, y)})`).not.toBe(background));

  // A file a running thread only read gets a wash an untouched file does not.
  const threads = [thread("a", { running: true }), thread("b", { running: true })];
  const onlyOrch = { "/wt/a": [change(ORCH)], "/wt/b": [change(ORCH)] };
  const fill = (path: string) => {
    const centre = centreOf(screen, path);
    return pixel(canvas, centre.x, centre.y);
  };
  await act(() => context.registry.set(state.view, view(threads, onlyOrch)));
  await vi.waitFor(() => expect(fill(INDEX_CSS)).toBe(fill(GIT)));
  await act(() =>
    context.registry.set(state.view, view(threads, onlyOrch, { a: [`/wt/a/${INDEX_CSS}`] })),
  );
  await vi.waitFor(() => expect(fill(INDEX_CSS)).not.toBe(fill(GIT)));
});

it("draws a working sprite for a running thread and an idle one for a finished one", async () => {
  using context = setup(
    view([thread("a", { running: true, active: CHAT_VIEW }), thread("b", { finished: true })], {
      "/wt/a": [change(CHAT_VIEW)],
      "/wt/b": [change(GIT)],
    }),
  );
  await using screen = await render(context.ui, { container: context.container });
  expect(screen.container.querySelectorAll('[data-testid="code-map-sprite"]')).toHaveLength(2);
  expect(sprite(screen, "a")!.dataset.path).toBe(CHAT_VIEW);
  expect(sprite(screen, "b")!.dataset.state).toBe("idle");
  expect(sprite(screen, "b")!.dataset.path).toBe(GIT);
  expect(cell(screen, GIT).dataset.strength).toBe("faint");
});

it("shows a stopped thread's card on hover and opens the thread on click", async () => {
  using context = setup(
    view(
      [
        thread("a", { running: true, active: CHAT_VIEW }),
        thread("b", { finished: true, active: GIT }),
      ],
      twoChanges,
    ),
  );
  await using screen = await render(context.ui, { container: context.container });
  using navigate = vi.spyOn(screen.router!, "navigate").mockResolvedValue(undefined);
  const stopped = sprite(screen, "b")!;
  expect(stopped.dataset.state).toBe("idle");
  expect(stopped.querySelector('[data-testid="code-map-say"]')).toBeNull();

  await userEvent.hover(stopped);
  const card = screen.getByRole("tooltip");
  await expect.element(card).toMatchTextContent(/Checkpoint diff stalls.*Idle · last at git\.ts/);
  await userEvent.unhover(stopped);
  await expect.element(card).not.toBeInTheDocument();

  await userEvent.click(stopped);
  expect(navigate).toHaveBeenCalledWith(
    expect.objectContaining({ params: expect.objectContaining({ threadId: "b" }) }),
  );
});

it("walks the sprite to its new file, stops requesting frames, and stays when the path goes quiet", async () => {
  using context = setup(twoThreads());
  await using screen = await render(context.ui, { container: context.container });
  const before = sprite(screen, "a")!.style.transform;
  using _clock = fakeTimers();

  await act(() =>
    context.registry.set(
      state.view,
      view(
        [thread("a", { running: true, active: ORCH }), thread("b", { running: true, active: GIT })],
        twoChanges,
      ),
    ),
  );
  expect(sprite(screen, "a")!.dataset.path).toBe(ORCH);
  expect(sprite(screen, "a")!.dataset.look).toBeDefined();
  vi.advanceTimersByTime(2000);
  expect(sprite(screen, "a")!.dataset.look).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
  const target = centreOf(screen, ORCH).rect;
  const landed = sprite(screen, "a")!.style.transform;
  expect(landed).not.toBe(before);
  const [tx] = landed.match(/-?[\d.]+/g)!.map(Number);
  expect(tx).toBeGreaterThan(target.x);
  expect(tx).toBeLessThan(target.x + target.w);

  await act(() =>
    context.registry.set(
      state.view,
      view(
        [thread("a", { running: true, active: null }), thread("b", { running: true, active: GIT })],
        twoChanges,
      ),
    ),
  );
  expect(sprite(screen, "a")!.dataset.path).toBe(ORCH);
  expect(sprite(screen, "a")!.dataset.look).toBeUndefined();
  vi.advanceTimersByTime(500);
  expect(sprite(screen, "a")!.style.transform).toBe(landed);
  expect(vi.getTimerCount()).toBe(0);
});

it("shows a running subagent as a small sprite in its parent's colour and walks it home when it finishes", async () => {
  using context = setup(twoThreads());
  await using screen = await render(context.ui, { container: context.container });
  using _clock = fakeTimers();
  const parent = sprite(screen, "a")!;
  const parentColor = (parent.firstElementChild as HTMLElement).style.background;

  await act(() =>
    context.registry.set(
      state.view,
      view(
        [
          thread("a", { running: true, active: CHAT_VIEW }),
          thread("s", { running: true, active: ORCH, subagentOf: "a" }),
          thread("b", { running: true, active: GIT }),
        ],
        twoChanges,
      ),
    ),
  );
  const sub = sprite(screen, "s")!;
  expect(sub.dataset.kind).toBe("subagent");
  expect((sub.firstElementChild as HTMLElement).style.background).toBe(parentColor);
  expect(sub.className).not.toContain("opacity-50");
  vi.advanceTimersByTime(2000);
  expect(sub.style.transform).not.toBe(parent.style.transform);
  expect(sub.dataset.path).toBe(ORCH);

  await act(() =>
    context.registry.set(
      state.view,
      view(
        [
          thread("a", { running: true, active: CHAT_VIEW }),
          thread("s", { finished: true, subagentOf: "a" }),
          thread("b", { running: true, active: GIT }),
        ],
        twoChanges,
      ),
    ),
  );
  vi.advanceTimersByTime(2000);
  expect(sub.style.transform).toBe(parent.style.transform);
  vi.advanceTimersByTime(400);
  expect(sprite(screen, "s")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it("outlines the hovered file without re-rendering the timeline row", async () => {
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
  const canvas = canvasOf(screen);
  const { rect } = centreOf(screen, ORCH);
  const edge = { x: rect.x + 1.5, y: rect.y + rect.h / 2 };
  await expect.element(cell(screen, ORCH)).not.toHaveAttribute("data-focus");
  const painted = Math.round(canvas.clientWidth * (window.devicePixelRatio || 1));
  await vi.waitFor(() => expect(canvas.width).toBe(painted));
  const plain = pixel(canvas, edge.x, edge.y);
  const rendersBefore = rowRenders.mock.calls.length;

  await screen.getByText("Edit orchestrationV2.ts").hover();
  await expect.element(cell(screen, ORCH)).toHaveAttribute("data-focus", "hovered");
  await vi.waitFor(() => expect(pixel(canvas, edge.x, edge.y)).not.toBe(plain));

  await screen.getByText("Plain row").hover();
  await expect.element(cell(screen, ORCH)).not.toHaveAttribute("data-focus");
  await vi.waitFor(() => expect(pixel(canvas, edge.x, edge.y)).toBe(plain));
  expect(rowRenders.mock.calls.length).toBe(rendersBefore);
});

it("sets the hovered path from the pointer over the map", async () => {
  using context = setup(twoThreads());
  await using screen = await render(context.ui, { container: context.container });
  const { x, y } = centreOf(screen, GIT);
  await userEvent.hover(canvasOf(screen), { position: { x, y } });
  await expect.poll(() => useCodeMapFocusStore.getState().hoveredPath).toBe(GIT);
  await userEvent.unhover(canvasOf(screen));
  await expect.poll(() => useCodeMapFocusStore.getState().hoveredPath).toBeNull();
});

it("outlines the cell chosen from the header pill", async () => {
  using context = setup(twoThreads());
  selectCodeMapPath(ref, ORCH);
  await using screen = await render(context.ui, { container: context.container });
  await expect.element(cell(screen, ORCH)).toHaveAttribute("data-focus", "selected");
  await expect.element(cell(screen, GIT)).not.toHaveAttribute("data-focus");
});
