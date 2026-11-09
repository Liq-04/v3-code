import {
  ProjectIconColor,
  ProviderInstanceId,
  ThreadId,
  type ProjectCodeMapSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveCodeMap,
  deriveCodeMapOverlaps,
  threadColor,
  threadOverlaps,
  type CodeMapChange,
  type CodeMapThreadInput,
} from "./codeMap.ts";

const PROJECT = "/work/app";
const ORCH = "packages/contracts/src/orchestrationV2.ts";

const snapshot: ProjectCodeMapSnapshot = {
  treeSha: "tree",
  baseRef: "main",
  files: {
    paths: [ORCH, "packages/contracts/src/git.ts", "apps/web/src/App.tsx", "README.md"],
    lines: [4000, 800, 300, 40],
    vendored: [false, false, false, false],
  },
  folders: [
    { path: "apps", fileCount: 1, lines: 300 },
    { path: "apps/web", fileCount: 1, lines: 300 },
    { path: "apps/web/src", fileCount: 1, lines: 300 },
    { path: "node_modules", fileCount: 900, lines: 90000 },
    { path: "node_modules/left-pad", fileCount: 900, lines: 90000 },
    { path: "packages", fileCount: 2, lines: 4800 },
    { path: "packages/contracts", fileCount: 2, lines: 4800 },
    { path: "packages/contracts/src", fileCount: 2, lines: 4800 },
  ],
  filesTotal: 904,
};

function thread(
  id: string,
  opts: {
    worktree?: string;
    running?: boolean;
    finished?: boolean;
    archived?: boolean;
    active?: { path: string; op: "read" | "edit" };
  } = {},
): CodeMapThreadInput {
  const status = opts.running ? "running" : opts.finished ? "completed" : undefined;
  return {
    id: ThreadId.make(id),
    worktreePath: opts.worktree ?? null,
    archivedAt: opts.archived ? "2026-06-01T00:00:00.000Z" : null,
    deletedAt: null,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default",
    latestRun: null,
    runtime: status
      ? {
          status,
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: null,
          lastError: null,
          updatedAt: "2026-06-01T00:00:00.000Z",
        }
      : null,
    source: {
      activeFile: opts.active && {
        ...opts.active,
        at: DateTime.makeUnsafe("2026-06-01T00:00:00.000Z"),
      },
    },
  };
}

const change = (path: string, insertions = 3, deletions = 1): CodeMapChange => ({
  path,
  insertions,
  deletions,
});

function derive(threads: CodeMapThreadInput[], changes: Record<string, CodeMapChange[]>) {
  return deriveCodeMap({
    snapshot,
    threads,
    changesByRoot: new Map(Object.entries(changes)),
    projectRoot: PROJECT,
  });
}

const ids = (...names: string[]) => names.map((name) => ThreadId.make(name));

describe("deriveCodeMap", () => {
  it("marks one thread's changed file with its counts and gives a running thread a sprite", () => {
    const model = derive(
      [thread("a", { worktree: "/wt/a", running: true, active: { path: ORCH, op: "edit" } })],
      { "/wt/a": [change(ORCH, 5, 2)] },
    );
    expect(model.threads).toEqual([
      { threadId: "a", root: "/wt/a", running: true, finished: false },
    ]);
    expect(model.marks).toEqual([
      {
        path: ORCH,
        lines: 4000,
        isNew: false,
        sets: [{ root: "/wt/a", threadIds: ids("a"), insertions: 5, deletions: 2 }],
      },
    ]);
    expect(model.overlaps).toEqual([]);
    expect(model.sprites).toEqual([{ threadId: "a", path: ORCH, op: "edit" }]);
  });

  it("lists every snapshot folder with its listed files, and root files under the empty path", () => {
    const model = derive([], {});
    expect(model.folders.find((f) => f.path === "packages/contracts/src")).toMatchObject({
      fileCount: 2,
      files: [
        { path: ORCH, lines: 4000 },
        { path: "packages/contracts/src/git.ts", lines: 800 },
      ],
    });
    expect(model.folders.find((f) => f.path === "node_modules")?.files).toEqual([]);
    expect(model.folders[0]).toMatchObject({
      path: "",
      fileCount: 1,
      files: [{ path: "README.md" }],
    });
  });

  it("reports one overlap with both thread ids when two worktrees change the same file", () => {
    const model = derive(
      [thread("a", { worktree: "/wt/a", running: true }), thread("b", { worktree: "/wt/b" })],
      { "/wt/a": [change(ORCH), change("apps/web/src/App.tsx")], "/wt/b": [change(ORCH)] },
    );
    expect(model.overlaps).toEqual([{ path: ORCH, threadIds: ids("a", "b") }]);
    expect(model.marks.find((m) => m.path === ORCH)?.sets).toHaveLength(2);
    expect(threadOverlaps(model, ThreadId.make("a"))).toEqual([ORCH]);
    expect(threadOverlaps(model, ThreadId.make("c"))).toEqual([]);
  });

  it("shares one mark set between threads in the project folder and does not call it an overlap", () => {
    const model = derive([thread("a", { running: true }), thread("b", { finished: true })], {
      [PROJECT]: [change(ORCH)],
    });
    expect(model.marks).toHaveLength(1);
    expect(model.marks[0]!.sets).toEqual([
      { root: PROJECT, threadIds: ids("a", "b"), insertions: 3, deletions: 1 },
    ]);
    expect(model.overlaps).toEqual([]);
  });

  it("matches roots that differ only by trailing slashes", () => {
    const model = derive([thread("a", { worktree: "/wt/a/" }), thread("b")], {
      "/wt/a": [change(ORCH)],
      [`${PROJECT}/`]: [change("README.md")],
    });
    expect(model.marks.map((m) => m.path)).toEqual([ORCH, "README.md"]);
    expect(model.threads.map((t) => t.root)).toEqual(["/wt/a", PROJECT]);
  });

  it("marks a path absent from the snapshot as new when its folder is not folded", () => {
    const model = derive([thread("a", { worktree: "/wt/a" })], {
      "/wt/a": [
        change("packages/contracts/src/codeMap.ts"),
        change("docs/new.md"),
        change("NEW.md"),
      ],
    });
    expect(model.marks.map((m) => [m.path, m.lines, m.isNew])).toEqual([
      ["packages/contracts/src/codeMap.ts", null, true],
      ["docs/new.md", null, true],
      ["NEW.md", null, true],
    ]);
  });

  it("does not mark a path inside a folded vendored folder as new", () => {
    const model = derive([thread("a", { worktree: "/wt/a" })], {
      "/wt/a": [
        change("node_modules/left-pad/index.js"),
        change("node_modules/left-pad/deep/x.js"),
      ],
    });
    expect(model.marks.map((m) => m.isNew)).toEqual([false, false]);
  });

  it("keeps a finished thread's marks and gives it no sprite", () => {
    const model = derive([thread("a", { worktree: "/wt/a", finished: true })], {
      "/wt/a": [change(ORCH)],
    });
    expect(model.threads).toEqual([
      { threadId: "a", root: "/wt/a", running: false, finished: true },
    ]);
    expect(model.marks).toHaveLength(1);
    expect(model.sprites).toEqual([]);
  });

  it("gives a running thread whose activeFile is absent a sprite with no new position", () => {
    const model = derive([thread("a", { worktree: "/wt/a", running: true })], {});
    expect(model.sprites).toEqual([{ threadId: "a", path: null, op: null }]);
  });

  it("skips archived threads and idle threads whose root has no changes", () => {
    const model = derive(
      [
        thread("a", { worktree: "/wt/a", archived: true, running: true }),
        thread("b", { worktree: "/wt/b" }),
      ],
      { "/wt/a": [change(ORCH)] },
    );
    expect(model.threads).toEqual([]);
    expect(model.marks).toEqual([]);
  });
});

describe("threadColor", () => {
  it("is stable per thread id and always a project icon color", () => {
    const id = ThreadId.make("thread-123");
    expect(threadColor(id)).toBe(threadColor(ThreadId.make("thread-123")));
    expect(threadColor(id)).toBe("rose");
    const colors = new Set<string>();
    for (let i = 0; i < 200; i++) colors.add(threadColor(ThreadId.make(`t-${i}`)));
    for (const color of colors) expect(ProjectIconColor.literals).toContain(color);
    expect(colors.size).toBeGreaterThan(8);
  });
});

describe("deriveCodeMapOverlaps", () => {
  const APP = "apps/web/src/App.tsx";
  const overlaps = (threads: CodeMapThreadInput[], changes: Record<string, CodeMapChange[]>) =>
    deriveCodeMapOverlaps({
      threads,
      changesByRoot: new Map(Object.entries(changes)),
      projectRoot: PROJECT,
    });

  it.each([
    {
      name: "no changes",
      threads: [thread("a", { worktree: "/wt/a", running: true })],
      changes: {},
      expected: [],
    },
    {
      name: "one file shared by two worktrees",
      threads: [
        thread("a", { worktree: "/wt/a", running: true }),
        thread("b", { worktree: "/wt/b" }),
      ],
      changes: { "/wt/a": [change(ORCH), change(APP)], "/wt/b": [change(ORCH)] },
      expected: [{ path: ORCH, threadIds: ids("a", "b") }],
    },
    {
      name: "two shared files",
      threads: [thread("a", { worktree: "/wt/a" }), thread("b", { worktree: "/wt/b" })],
      changes: { "/wt/a": [change(ORCH), change(APP)], "/wt/b": [change(APP), change(ORCH)] },
      expected: [
        { path: ORCH, threadIds: ids("a", "b") },
        { path: APP, threadIds: ids("a", "b") },
      ],
    },
    {
      name: "threads sharing one working tree",
      threads: [thread("a", { running: true }), thread("b", { finished: true })],
      changes: { [PROJECT]: [change(ORCH)] },
      expected: [],
    },
    {
      name: "an archived thread",
      threads: [
        thread("a", { worktree: "/wt/a" }),
        thread("b", { worktree: "/wt/b", archived: true }),
      ],
      changes: { "/wt/a": [change(ORCH)], "/wt/b": [change(ORCH)] },
      expected: [],
    },
  ])("$name", ({ threads, changes, expected }) => {
    expect(overlaps(threads, changes)).toEqual(expected);
  });

  it("agrees with deriveCodeMap", () => {
    const threads = [thread("a", { worktree: "/wt/a" }), thread("b", { worktree: "/wt/b" })];
    const changes = { "/wt/a": [change(ORCH)], "/wt/b": [change(ORCH)] };
    expect(overlaps(threads, changes)).toEqual(derive(threads, changes).overlaps);
  });
});
