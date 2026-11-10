import {
  ProjectIconColor,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ProjectCodeMapSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  CODE_MAP_DOCK,
  changesFingerprint,
  checkoutRelativePath,
  deriveCodeMap,
  deriveCodeMapOverlaps,
  observeReadTrails,
  repositoryGroupOf,
  threadColor,
  threadOverlaps,
  type CodeMapChange,
  type CodeMapReadTrail,
  type CodeMapThreadInput,
  type DeriveCodeMapInput,
} from "./codeMap.ts";

const PROJECT = "/work/app";
const PROJECT_ID = ProjectId.make("app");
const OTHER_PROJECT = "/work/app-second-checkout";
const OTHER_PROJECT_ID = ProjectId.make("app-second-checkout");
const DOCS_PROJECT = "/work/app/docs";
const DOCS_PROJECT_ID = ProjectId.make("app-docs");
const PROJECT_ROOTS = new Map([
  [PROJECT_ID, PROJECT],
  [OTHER_PROJECT_ID, OTHER_PROJECT],
  [DOCS_PROJECT_ID, DOCS_PROJECT],
]);
const ORCH = "packages/contracts/src/orchestrationV2.ts";

const snapshot: ProjectCodeMapSnapshot = {
  treeSha: "tree",
  baseRef: "main",
  defaultBaseRef: "main",
  checkouts: [PROJECT, "/wt/a", "/work/app/.worktrees/nested"],
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
    subagentOf?: string;
    root?: string;
    project?: ProjectId;
    run?: string;
    /** A provider-native subagent: no T3 runtime or run, live only through its shell status. */
    native?: boolean;
    settled?: boolean;
    snoozedUntil?: string;
    waiting?: boolean;
    toolRunning?: boolean;
    active?: { path: string; op: "read" | "edit"; at?: string };
  } = {},
): CodeMapThreadInput {
  const status = opts.native
    ? undefined
    : opts.running
      ? "running"
      : opts.finished
        ? "completed"
        : undefined;
  return {
    id: ThreadId.make(id),
    projectId: opts.project ?? PROJECT_ID,
    worktreePath: opts.worktree ?? null,
    archivedAt: opts.archived ? "2026-06-01T00:00:00.000Z" : null,
    deletedAt: null,
    lineage: {
      parentThreadId: opts.subagentOf ? ThreadId.make(opts.subagentOf) : null,
      relationshipToParent: opts.subagentOf ? "subagent" : null,
      rootThreadId: ThreadId.make(opts.root ?? opts.subagentOf ?? id),
    },
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: opts.waiting ?? false,
    interactionMode: "default",
    settledOverride: opts.settled ? "settled" : null,
    snoozedUntil: opts.snoozedUntil ?? null,
    snoozedAt: null,
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
      activeRunId: opts.running && !opts.native ? RunId.make(opts.run ?? `run:${id}`) : null,
      status: opts.running ? "running" : opts.finished ? "completed" : "idle",
      activityRunStatus: null,
      pendingRuntimeRequest: null,
      pendingBackgroundTasks: [],
      ...(opts.toolRunning === undefined ? {} : { toolRunning: opts.toolRunning }),
      activeFile: opts.active && {
        path: opts.active.path,
        op: opts.active.op,
        at: DateTime.makeUnsafe(opts.active.at ?? "2026-06-01T00:00:00.000Z"),
      },
    },
  };
}

const change = (path: string, insertions = 3, deletions = 1): CodeMapChange => ({
  path,
  insertions,
  deletions,
});

/** `checkouts` names the checkout of a root that is not one itself. */
const changesByRoot = (
  changes: Record<string, CodeMapChange[]>,
  checkouts: Record<string, string> = {},
) =>
  new Map(
    Object.entries(changes).map(([root, files]) => [
      root,
      { checkout: checkouts[root] ?? root, files },
    ]),
  );

function derive(
  threads: CodeMapThreadInput[],
  changes: Record<string, CodeMapChange[]>,
  reads: Partial<Pick<DeriveCodeMapInput, "backfilledReads" | "observedReads">> = {},
  checkouts: Record<string, string> = {},
) {
  return deriveCodeMap({
    snapshot,
    threads,
    changesByRoot: changesByRoot(changes, checkouts),
    projectRoots: PROJECT_ROOTS,
    now: "2026-06-01T12:00:00.000Z",
    backfilledReads: new Map(),
    observedReads: new Map(),
    ...reads,
  });
}

const ids = (...names: string[]) => names.map((name) => ThreadId.make(name));

describe("deriveCodeMap", () => {
  it("marks one thread's changed file with its counts and gives a running thread a sprite", () => {
    const model = derive(
      [
        thread("a", {
          worktree: "/wt/a",
          running: true,
          active: { path: `/wt/a/${ORCH}`, op: "edit" },
        }),
      ],
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
    expect(model.sprites).toEqual([
      {
        threadId: "a",
        kind: "agent",
        parentThreadId: null,
        colorThreadId: "a",
        path: ORCH,
        home: { kind: "file", path: ORCH },
        op: "edit",
        state: "working",
      },
    ]);
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

  it("gives two projects inside one checkout a single mark set and no overlap", () => {
    const model = derive(
      [thread("a", { running: true }), thread("b", { project: DOCS_PROJECT_ID, running: true })],
      { [PROJECT]: [change(ORCH)], [DOCS_PROJECT]: [change(ORCH)] },
      {},
      { [DOCS_PROJECT]: PROJECT },
    );
    expect(model.threads.map((t) => t.root)).toEqual([PROJECT, PROJECT]);
    expect(model.marks.map((m) => m.sets)).toEqual([
      [{ root: PROJECT, threadIds: ids("a", "b"), insertions: 3, deletions: 1 }],
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

  it("keeps a finished thread's marks and stands it idle on its change", () => {
    const model = derive([thread("a", { worktree: "/wt/a", finished: true })], {
      "/wt/a": [change(ORCH)],
    });
    expect(model.threads).toEqual([
      { threadId: "a", root: "/wt/a", running: false, finished: true },
    ]);
    expect(model.marks).toHaveLength(1);
    expect(
      model.sprites.map((sprite) => [sprite.threadId, sprite.state, sprite.path, sprite.home]),
    ).toEqual([["a", "idle", null, { kind: "file", path: ORCH }]]);
  });

  it("stands every unsettled thread at its last file and tells working, waiting and idle apart", () => {
    const active = (id: string) => ({ path: `/wt/${id}/${ORCH}`, op: "edit" as const });
    const model = derive(
      [
        thread("idle", { worktree: "/wt/idle", active: active("idle") }),
        thread("asks", { worktree: "/wt/asks", waiting: true, active: active("asks") }),
        thread("done", { worktree: "/wt/done", settled: true, active: active("done") }),
        thread("later", {
          worktree: "/wt/later",
          snoozedUntil: "2026-06-02T00:00:00.000Z",
          active: active("later"),
        }),
        thread("nowhere", { worktree: "/wt/nowhere" }),
      ],
      {},
    );
    expect(model.sprites.map((sprite) => [sprite.threadId, sprite.state, sprite.path])).toEqual([
      ["idle", "idle", ORCH],
      ["asks", "waiting", ORCH],
      // A thread that names no file of the map yet still shows, at the dock.
      ["nowhere", "idle", null],
    ]);
    expect(model.sprites.find((sprite) => sprite.threadId === "nowhere")?.home).toEqual(
      CODE_MAP_DOCK,
    );
    expect(model.threads).toEqual([]);
  });

  it("shows a working thread or subagent with no tool running as thinking and keeps its reads", () => {
    const READ = `/wt/thinks/${ORCH}`;
    const model = derive(
      [
        thread("thinks", { worktree: "/wt/thinks", running: true, toolRunning: false }),
        thread("tools", { worktree: "/wt/tools", running: true, toolRunning: true }),
        // An older server says nothing about tools.
        thread("older", { worktree: "/wt/older", running: true }),
        thread("asks", { worktree: "/wt/asks", running: true, waiting: true, toolRunning: false }),
        thread("stopped", { worktree: "/wt/stopped", toolRunning: false }),
        thread("child", { subagentOf: "thinks", running: true, toolRunning: false }),
      ],
      {},
      { backfilledReads: new Map([[ThreadId.make("thinks"), [READ]]]) },
    );
    expect(model.sprites.map((sprite) => [sprite.threadId, sprite.state])).toEqual([
      ["thinks", "thinking"],
      ["tools", "working"],
      ["older", "working"],
      ["asks", "waiting"],
      ["stopped", "idle"],
      ["child", "thinking"],
    ]);
    expect(model.reads).toEqual([{ path: ORCH, threadIds: ids("thinks") }]);
  });

  it("stands a thread whose last file is outside every checkout on its busiest change", () => {
    const model = derive(
      [
        thread("elsewhere", {
          worktree: "/wt/elsewhere",
          active: { path: "/tmp/scratch/page.html", op: "edit" },
        }),
      ],
      { "/wt/elsewhere": [change(ORCH, 3, 1), change("apps/web/src/App.tsx", 40, 2)] },
    );
    expect(
      model.sprites.map((sprite) => [sprite.threadId, sprite.state, sprite.path, sprite.home]),
    ).toEqual([["elsewhere", "idle", null, { kind: "file", path: "apps/web/src/App.tsx" }]]);
  });

  it("stands a new running thread with no file at the dock", () => {
    const model = derive([thread("a", { worktree: "/wt/a", running: true })], {});
    expect(model.sprites).toEqual([
      {
        threadId: "a",
        kind: "agent",
        parentThreadId: null,
        colorThreadId: "a",
        path: null,
        home: CODE_MAP_DOCK,
        op: null,
        state: "working",
      },
    ]);
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

describe("repository group", () => {
  it("shows threads of every project that is a checkout of the map's repository", () => {
    const identity = (canonicalKey: string) => ({
      canonicalKey,
      locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl: canonicalKey },
    });
    const projects = [
      { id: PROJECT_ID, repositoryIdentity: identity("github.com/acme/app") },
      { id: OTHER_PROJECT_ID, repositoryIdentity: identity("github.com/acme/app") },
      { id: ProjectId.make("unrelated"), repositoryIdentity: identity("github.com/acme/other") },
      { id: ProjectId.make("no-identity"), repositoryIdentity: null },
    ];
    expect(repositoryGroupOf(projects, PROJECT_ID).map((project) => project.id)).toEqual([
      PROJECT_ID,
      OTHER_PROJECT_ID,
    ]);
    expect(
      repositoryGroupOf(projects, ProjectId.make("no-identity")).map((project) => project.id),
    ).toEqual(["no-identity"]);

    const model = derive(
      [
        thread("a", { running: true }),
        thread("b", { project: OTHER_PROJECT_ID, running: true }),
        thread("c", { project: ProjectId.make("unrelated"), running: true }),
      ],
      { [PROJECT]: [change(ORCH)], [OTHER_PROJECT]: [change(ORCH)] },
    );
    expect(model.threads.map((t) => [t.threadId, t.root])).toEqual([
      ["a", PROJECT],
      ["b", OTHER_PROJECT],
    ]);
    expect(model.overlaps).toEqual([{ path: ORCH, threadIds: ids("a", "b") }]);
  });

  it.each([
    { name: "inside the thread's own checkout", path: `/wt/a/${ORCH}`, expected: ORCH },
    { name: "inside another checkout", path: `${PROJECT}/README.md`, expected: "README.md" },
    {
      name: "inside a checkout nested in another",
      path: `${PROJECT}/.worktrees/nested/${ORCH}`,
      expected: ORCH,
    },
    {
      name: "inside a worktree the snapshot has not listed yet",
      path: "/wt/unlisted/README.md",
      expected: "README.md",
    },
    {
      name: "inside a project rooted in a checkout's subfolder",
      path: `${DOCS_PROJECT}/guide.md`,
      expected: "docs/guide.md",
    },
    { name: "outside every checkout", path: "/etc/hosts", expected: null },
    { name: "a checkout root itself", path: "/wt/a", expected: null },
  ])("places a sprite on a path $name", ({ path, expected }) => {
    const model = derive(
      [
        thread("a", { worktree: "/wt/a", running: true, active: { path, op: "read" } }),
        thread("b", { worktree: "/wt/unlisted" }),
      ],
      {},
    );
    expect(model.sprites[0]!.path).toBe(expected);
  });

  it("resolves through the deepest root whatever order the roots come in", () => {
    const roots = ["/repo", "/repo/.worktrees/x", "/repo/.worktrees"];
    for (const order of [roots, roots.toReversed()]) {
      expect(checkoutRelativePath("/repo/.worktrees/x/src/a.ts", order)).toBe("src/a.ts");
    }
  });
});

describe("read trail", () => {
  const A = `/wt/a/${ORCH}`;
  const B = "/wt/a/README.md";
  const C = `${PROJECT}/apps/web/src/App.tsx`;
  const running = (active?: { path: string; op: "read" | "edit"; at?: string }, run = "run:1") =>
    thread("a", { worktree: "/wt/a", running: true, run, ...(active ? { active } : {}) });
  const observe = (shells: ReadonlyArray<CodeMapThreadInput>) => {
    let trails: ReadonlyMap<ThreadId, CodeMapReadTrail> = new Map();
    for (const shell of shells) trails = observeReadTrails(trails, [shell]);
    return trails;
  };

  it("joins the server's backfill with the reads seen since, in the reader's colour", () => {
    const shells = [
      running({ path: A, op: "read", at: "2026-06-01T00:00:01.000Z" }),
      running({ path: B, op: "read", at: "2026-06-01T00:00:02.000Z" }),
      running({ path: "/wt/a/NEW.md", op: "edit", at: "2026-06-01T00:00:03.000Z" }),
      running({ path: "/etc/hosts", op: "read", at: "2026-06-01T00:00:04.000Z" }),
      running({ path: C, op: "read", at: "2026-06-01T00:00:05.000Z" }),
    ];
    const observedReads = observe(shells);
    // The first shell's file predates the observation, so only the backfill can name it.
    expect(observedReads.get(ThreadId.make("a"))?.paths).toEqual([B, "/etc/hosts", C]);

    const model = derive(
      [shells.at(-1)!],
      {},
      {
        backfilledReads: new Map([[ThreadId.make("a"), [A, B]]]),
        observedReads,
      },
    );
    expect(model.reads).toEqual([
      { path: ORCH, threadIds: ids("a") },
      { path: "README.md", threadIds: ids("a") },
      { path: "apps/web/src/App.tsx", threadIds: ids("a") },
    ]);
  });

  it("counts a subagent's reads for its root thread and names a shared file once", () => {
    const model = derive(
      [
        thread("a", { worktree: "/wt/a", running: true }),
        thread("s", { subagentOf: "a", running: true }),
        thread("b", { project: OTHER_PROJECT_ID, running: true }),
      ],
      // A separate clone is a checkout the snapshot cannot list; its changes name it.
      { [OTHER_PROJECT]: [] },
      {
        backfilledReads: new Map([
          [ThreadId.make("a"), [A]],
          [ThreadId.make("s"), [A, B]],
          [ThreadId.make("b"), [`${OTHER_PROJECT}/README.md`]],
        ]),
      },
    );
    expect(model.reads).toEqual([
      { path: ORCH, threadIds: ids("a") },
      { path: "README.md", threadIds: ids("a", "b") },
    ]);
  });

  it("follows a provider-native subagent that has no run of its own", () => {
    const subagent = (active: { path: string; op: "read"; at: string }) =>
      thread("s", { subagentOf: "a", native: true, running: true, active });
    const parent = thread("a", { worktree: "/wt/a", running: true });
    const shells = [
      subagent({ path: A, op: "read", at: "2026-06-01T00:00:01.000Z" }),
      subagent({ path: B, op: "read", at: "2026-06-01T00:00:02.000Z" }),
    ];
    let observedReads: ReadonlyMap<ThreadId, CodeMapReadTrail> = new Map();
    for (const shell of shells) observedReads = observeReadTrails(observedReads, [parent, shell]);

    const model = derive([parent, shells.at(-1)!], {}, { observedReads });
    expect(model.sprites.find((s) => s.threadId === ThreadId.make("s"))).toMatchObject({
      kind: "subagent",
      colorThreadId: "a",
      path: "README.md",
    });
    expect(model.reads).toEqual([{ path: "README.md", threadIds: ids("a") }]);
  });

  it("clears when the thread stops running and starts empty on its next run", () => {
    const first = running({ path: A, op: "read", at: "2026-06-01T00:00:01.000Z" });
    const second = running({ path: B, op: "read", at: "2026-06-01T00:00:02.000Z" });
    const stopped = thread("a", {
      worktree: "/wt/a",
      finished: true,
      active: { path: B, op: "read", at: "2026-06-01T00:00:02.000Z" },
    });
    const trails = observe([first, second]);
    expect(observeReadTrails(trails, [second])).toBe(trails);

    const afterStop = observeReadTrails(trails, [stopped]);
    expect(afterStop.size).toBe(0);
    expect(
      derive(
        [stopped],
        { "/wt/a": [change(ORCH)] },
        {
          backfilledReads: new Map([[ThreadId.make("a"), [A, B]]]),
          observedReads: trails,
        },
      ).reads,
    ).toEqual([]);

    const nextRun = running({ path: B, op: "read", at: "2026-06-01T00:00:02.000Z" }, "run:2");
    expect(observeReadTrails(trails, [nextRun]).get(ThreadId.make("a"))).toMatchObject({
      runId: "run:2",
      paths: [],
    });
    expect(derive([nextRun], {}, { observedReads: trails }).reads).toEqual([]);
  });
});

describe("subagents", () => {
  const sub = (id: string, parent: string, opts: Parameters<typeof thread>[1] = {}) =>
    thread(id, { subagentOf: parent, ...opts });

  it.each([
    {
      name: "a running subagent is a small sprite in the root's colour",
      threads: [
        thread("a", { worktree: "/wt/a", running: true }),
        sub("s", "a", { running: true, active: { path: `${PROJECT}/${ORCH}`, op: "read" } }),
      ],
      expected: [
        {
          threadId: "s",
          kind: "subagent",
          parentThreadId: "a",
          colorThreadId: "a",
          path: ORCH,
          home: null,
          op: "read",
          state: "working",
        },
      ],
    },
    {
      name: "a finished subagent has no sprite",
      threads: [
        thread("a", { worktree: "/wt/a", running: true }),
        sub("s", "a", { finished: true }),
      ],
      expected: [],
    },
    {
      name: "a subagent of a subagent takes the root's colour",
      threads: [
        thread("a", { worktree: "/wt/a", running: true }),
        sub("s", "a", { running: true }),
        sub("t", "s", { running: true, root: "a" }),
      ],
      expected: [
        {
          threadId: "s",
          kind: "subagent",
          parentThreadId: "a",
          colorThreadId: "a",
          path: null,
          home: null,
          op: null,
          state: "working",
        },
        {
          threadId: "t",
          kind: "subagent",
          parentThreadId: "a",
          colorThreadId: "a",
          path: null,
          home: null,
          op: null,
          state: "working",
        },
      ],
    },
    {
      name: "a subagent of an archived root has no sprite",
      threads: [
        thread("a", { worktree: "/wt/a", archived: true }),
        sub("s", "a", { running: true }),
      ],
      expected: [],
    },
    {
      name: "a subagent whose root is not in the list has no sprite",
      threads: [sub("s", "gone", { running: true })],
      expected: [],
    },
  ])("$name", ({ threads, expected }) => {
    expect(derive(threads, {}).sprites.filter((sprite) => sprite.kind === "subagent")).toEqual(
      expected,
    );
  });

  it("adds no thread, mark set, or overlap of its own", () => {
    const threads = [
      thread("a", { worktree: "/wt/a", running: true }),
      sub("s", "a", { running: true, worktree: "/wt/a" }),
    ];
    const model = derive(threads, { "/wt/a": [change(ORCH)] });
    expect(model.threads.map((t) => t.threadId)).toEqual(ids("a"));
    expect(model.marks[0]!.sets).toEqual([
      { root: "/wt/a", threadIds: ids("a"), insertions: 3, deletions: 1 },
    ]);
    expect(model.overlaps).toEqual([]);
    expect(threadOverlaps(model, ThreadId.make("s"))).toEqual([]);
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

describe("changesFingerprint", () => {
  const file = (path: string, insertions = 0, deletions = 0) => ({ path, insertions, deletions });
  const status = (
    files: ReadonlyArray<ReturnType<typeof file>>,
    branch: { insertions: number; deletions: number },
    refName = "feature",
  ): Parameters<typeof changesFingerprint>[0] => ({
    refName,
    workingTree: {
      files,
      insertions: files.reduce((sum, each) => sum + each.insertions, 0),
      deletions: files.reduce((sum, each) => sum + each.deletions, 0),
    },
    branchChanges: { baseRef: "main", ...branch },
  });
  const dirty = status([file("a.ts", 3, 1), file("new/")], { insertions: 13, deletions: 1 });

  it.each([
    {
      name: "more edits to a file that is already dirty",
      next: status([file("a.ts", 9, 4), file("new/")], { insertions: 19, deletions: 4 }),
      rereads: false,
    },
    {
      name: "the same files listed in another order",
      next: status([file("new/"), file("a.ts", 3, 1)], { insertions: 13, deletions: 1 }),
      rereads: false,
    },
    {
      name: "another dirty path",
      next: status([file("a.ts", 3, 1), file("b.ts", 1, 0), file("new/")], {
        insertions: 14,
        deletions: 1,
      }),
      rereads: true,
    },
    {
      name: "another file inside a folder that is already untracked",
      next: status([file("a.ts", 3, 1), file("new/")], { insertions: 20, deletions: 1 }),
      rereads: true,
    },
    {
      name: "a branch switch",
      next: status([file("a.ts", 3, 1), file("new/")], { insertions: 13, deletions: 1 }, "other"),
      rereads: true,
    },
  ])("$name", ({ next, rereads }) => {
    expect(changesFingerprint(next) !== changesFingerprint(dirty)).toBe(rereads);
  });

  it("changes when a commit lands on a clean working tree", () => {
    expect(changesFingerprint(status([], { insertions: 13, deletions: 1 }))).not.toBe(
      changesFingerprint(status([], { insertions: 21, deletions: 1 })),
    );
  });
});

describe("deriveCodeMapOverlaps", () => {
  const APP = "apps/web/src/App.tsx";
  const overlaps = (threads: CodeMapThreadInput[], changes: Record<string, CodeMapChange[]>) =>
    deriveCodeMapOverlaps({
      threads,
      changesByRoot: changesByRoot(changes),
      projectRoots: PROJECT_ROOTS,
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
