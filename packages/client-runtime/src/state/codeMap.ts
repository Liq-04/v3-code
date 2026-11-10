import {
  isLiveSubagentShell,
  ProjectIconColor,
  repositoryGroupingKeyOf,
  type OrchestrationV2ThreadShell,
  type ProjectCodeMapChanges,
  type ProjectCodeMapSnapshot,
  type ProjectId,
  type RepositoryIdentity,
  type RunId,
  type ThreadId,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { workspaceRelativeFilePath } from "@t3tools/shared/path";
import * as DateTime from "effect/DateTime";

import { threadRuntimeIsActive, type EnvironmentThreadShell } from "./models.ts";
import { isThreadWorking } from "./threadInbox.ts";
import { effectiveSnoozed } from "./threadSettled.ts";

export interface CodeMapChange {
  readonly path: string;
  readonly insertions: number;
  readonly deletions: number;
}

/** What one checkout changed since the map's base, as `projects.getCodeMapChanges` returns it. */
export type CodeMapCheckoutChanges = Pick<ProjectCodeMapChanges, "checkout" | "files">;

export interface CodeMapThread {
  readonly threadId: ThreadId;
  /** The checkout the thread works in, or its own folder until that checkout's changes arrive. */
  readonly root: string;
  readonly running: boolean;
  /** Not running and its runtime is no longer active. A thread waiting on the user is neither. */
  readonly finished: boolean;
}

export interface CodeMapMarkSet {
  /** The checkout's root. */
  readonly root: string;
  /** Every thread sharing this working tree. */
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly insertions: number;
  readonly deletions: number;
}

export interface CodeMapPathMark {
  readonly path: string;
  /** Null when the path is not a listed file. */
  readonly lines: number | null;
  readonly isNew: boolean;
  readonly sets: ReadonlyArray<CodeMapMarkSet>;
}

export interface CodeMapOverlap {
  readonly path: string;
  readonly threadIds: ReadonlyArray<ThreadId>;
}

export interface CodeMapSprite {
  readonly threadId: ThreadId;
  readonly kind: "agent" | "subagent";
  /** The root thread for a subagent, null for a top-level thread. */
  readonly parentThreadId: ThreadId | null;
  /** The thread whose `threadColor` paints the sprite: the root thread for a subagent. */
  readonly colorThreadId: ThreadId;
  /** Null means the latest touch named no path inside a checkout: keep the sprite where it was. */
  readonly path: string | null;
  /** Where a sprite with no position yet stands: its thread's busiest listed change. */
  readonly home: string | null;
  readonly op: "read" | "edit" | null;
  /** Waiting is on the user: an approval, a question, or a plan to accept. Subagents only work. */
  readonly state: "working" | "waiting" | "idle";
}

export interface CodeMapRead {
  readonly path: string;
  /** The threads whose colours paint the mark: a subagent's reads count for its root thread. */
  readonly threadIds: ReadonlyArray<ThreadId>;
}

export interface CodeMap {
  readonly threads: ReadonlyArray<CodeMapThread>;
  readonly marks: ReadonlyArray<CodeMapPathMark>;
  readonly overlaps: ReadonlyArray<CodeMapOverlap>;
  readonly sprites: ReadonlyArray<CodeMapSprite>;
  /** Files the running threads read during their current runs. */
  readonly reads: ReadonlyArray<CodeMapRead>;
}

/** The reads seen arriving on one thread's shell during one run. Paths are absolute. */
export interface CodeMapReadTrail {
  /** Null for a provider-native subagent, whose work runs under no T3 run of its own. */
  readonly runId: RunId | null;
  /** The active file last folded in, so the same shell value is not counted twice. */
  readonly seen: string;
  readonly paths: ReadonlyArray<string>;
}

export type CodeMapThreadInput = Pick<
  EnvironmentThreadShell,
  | "id"
  | "projectId"
  | "worktreePath"
  | "archivedAt"
  | "deletedAt"
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingUserInputAt"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
  | "interactionMode"
  | "settledOverride"
  | "snoozedUntil"
  | "snoozedAt"
  | "latestRun"
  | "runtime"
  | "lineage"
> & {
  readonly source: Pick<
    OrchestrationV2ThreadShell,
    | "activeFile"
    | "activeRunId"
    | "status"
    | "activityRunStatus"
    | "pendingRuntimeRequest"
    | "pendingBackgroundTasks"
  >;
};

const isLiveThread = (thread: CodeMapThreadInput) =>
  thread.archivedAt === null && thread.deletedAt === null;

const isSubagent = (thread: CodeMapThreadInput) =>
  thread.lineage.relationshipToParent === "subagent";

// Provider-native subagents have no T3 runtime or run, so the shell's own liveness decides.
const isActorWorking = (thread: CodeMapThreadInput) =>
  isSubagent(thread) ? isLiveSubagentShell(thread.source) : isThreadWorking(thread);

export interface DeriveCodeMapInput {
  readonly snapshot: ProjectCodeMapSnapshot;
  /** Threads of every project in the map. Archived and deleted ones are skipped here. */
  readonly threads: ReadonlyArray<CodeMapThreadInput>;
  /**
   * Keyed by the folder asked about: a worktree path or a project folder. Several folders can
   * share one checkout, and a folder is absent until its changes arrive.
   */
  readonly changesByRoot: ReadonlyMap<string, CodeMapCheckoutChanges>;
  /** Where each project's threads run when they have no worktree. Other projects' threads are skipped. */
  readonly projectRoots: ReadonlyMap<ProjectId, string>;
  /** The ISO time snoozes are judged against. */
  readonly now: string;
  /** Absolute paths the server lists for each thread's current run. */
  readonly backfilledReads: ReadonlyMap<ThreadId, ReadonlyArray<string>>;
  readonly observedReads: ReadonlyMap<ThreadId, CodeMapReadTrail>;
}

interface CodeMapProject {
  readonly id: ProjectId;
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
}

/** A key shared by every project that is a checkout of the same repository, or null without an identity. */
export function repositoryGroupKey(project: CodeMapProject): string | null {
  return project.repositoryIdentity ? repositoryGroupingKeyOf(project.repositoryIdentity) : null;
}

/** The projects that are checkouts of `projectId`'s repository, itself included. */
export function repositoryGroupOf<P extends CodeMapProject>(
  projects: ReadonlyArray<P>,
  projectId: ProjectId,
): ReadonlyArray<P> {
  const own = projects.find((project) => project.id === projectId);
  if (own === undefined) return [];
  const key = repositoryGroupKey(own);
  return key === null ? [own] : projects.filter((project) => repositoryGroupKey(project) === key);
}

/** `path` relative to the deepest of `roots` that contains it, or null when none does. */
export function checkoutRelativePath(path: string, roots: Iterable<string>): string | null {
  let best: string | null = null;
  let bestRootLength = -1;
  for (const root of roots) {
    if (root.length <= bestRootLength) continue;
    const relative = workspaceRelativeFilePath(path, root);
    if (relative === null || relative === ".") continue;
    best = relative;
    bestRootLength = root.length;
  }
  return best;
}

/**
 * Changes when a checkout's diff against the base can list other paths: another branch, other
 * dirty paths, or committed or untracked lines moving (the branch totals the tracked working
 * tree does not account for). More edits to an already-dirty file move both totals alike.
 */
export function changesFingerprint(
  status: Pick<VcsStatusResult, "refName" | "workingTree" | "branchChanges">,
): string {
  const { workingTree, branchChanges } = status;
  return JSON.stringify([
    status.refName,
    workingTree.files.map((file) => file.path).sort(),
    branchChanges ? branchChanges.insertions - workingTree.insertions : null,
    branchChanges ? branchChanges.deletions - workingTree.deletions : null,
  ]);
}

const THREAD_COLORS = ProjectIconColor.literals.filter((color) => color !== "gray");

export function threadColor(threadId: ThreadId): ProjectIconColor {
  let hash = 2166136261;
  for (let i = 0; i < threadId.length; i++) {
    hash = Math.imul(hash ^ threadId.charCodeAt(i), 16777619) >>> 0;
  }
  return THREAD_COLORS[hash % THREAD_COLORS.length]!;
}

export function threadOverlaps(model: CodeMap, threadId: ThreadId): ReadonlyArray<string> {
  return model.overlaps.filter((o) => o.threadIds.includes(threadId)).map((o) => o.path);
}

function normalizeRoot(root: string): string {
  return root.length > 1 ? root.replace(/\/+$/, "") : root;
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

type MarkSetsInput = Pick<DeriveCodeMapInput, "threads" | "changesByRoot" | "projectRoots">;

/** A thread or live subagent that draws a sprite. A working one also leaves a read trail. */
interface CodeMapActor {
  readonly thread: CodeMapThreadInput;
  readonly kind: CodeMapSprite["kind"];
  readonly parentThreadId: ThreadId | null;
  readonly colorThreadId: ThreadId;
  readonly state: CodeMapSprite["state"];
}

/** Null for a parked thread: settled or snoozed, the sidebar's rule. A working one is never parked. */
function spriteStateOf(thread: CodeMapThreadInput, now: string): CodeMapSprite["state"] | null {
  if (isThreadWorking(thread)) return "working";
  if (thread.settledOverride === "settled" || effectiveSnoozed(thread, { now })) return null;
  const waiting =
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.pendingSubagentRequest != null ||
    (thread.interactionMode === "plan" && thread.hasActionableProposedPlan);
  return waiting ? "waiting" : "idle";
}

function collectActors(
  input: Pick<DeriveCodeMapInput, "threads" | "projectRoots" | "now">,
): ReadonlyArray<CodeMapActor> {
  const liveIds = new Set(input.threads.filter(isLiveThread).map((thread) => thread.id));
  const actors: CodeMapActor[] = [];
  for (const thread of input.threads) {
    if (!liveIds.has(thread.id)) continue;
    if (isSubagent(thread)) {
      const rootId = thread.lineage.rootThreadId;
      if (isActorWorking(thread) && liveIds.has(rootId)) {
        actors.push({
          thread,
          kind: "subagent",
          parentThreadId: rootId,
          colorThreadId: rootId,
          state: "working",
        });
      }
      continue;
    }
    if (thread.worktreePath === null && !input.projectRoots.has(thread.projectId)) continue;
    const state = spriteStateOf(thread, input.now);
    if (state === null) continue;
    actors.push({ thread, kind: "agent", parentThreadId: null, colorThreadId: thread.id, state });
  }
  return actors;
}

function collectMarkSets(input: MarkSetsInput) {
  const changesByRoot = new Map<string, CodeMapCheckoutChanges>();
  for (const [root, changes] of input.changesByRoot)
    changesByRoot.set(normalizeRoot(root), changes);
  const threads: CodeMapThread[] = [];
  const checkouts = new Map<
    string,
    { readonly threadIds: ThreadId[]; readonly files: ReadonlyArray<CodeMapChange> }
  >();
  for (const thread of input.threads) {
    if (!isLiveThread(thread) || isSubagent(thread)) continue;
    const threadRoot = thread.worktreePath ?? input.projectRoots.get(thread.projectId);
    if (threadRoot === undefined) continue;
    const changes = changesByRoot.get(normalizeRoot(threadRoot));
    const root = normalizeRoot(changes?.checkout ?? threadRoot);
    const files = changes?.files ?? [];
    const running = isThreadWorking(thread);
    if (!running && files.length === 0) continue;
    threads.push({
      threadId: thread.id,
      root,
      running,
      finished: !running && !threadRuntimeIsActive(thread.runtime),
    });
    const checkout = checkouts.get(root);
    if (checkout) checkout.threadIds.push(thread.id);
    else checkouts.set(root, { threadIds: [thread.id], files });
  }

  const setsByPath = new Map<string, CodeMapMarkSet[]>();
  for (const [root, { threadIds, files }] of checkouts) {
    for (const change of files) {
      const set = { root, threadIds, insertions: change.insertions, deletions: change.deletions };
      const sets = setsByPath.get(change.path);
      if (sets) sets.push(set);
      else setsByPath.set(change.path, [set]);
    }
  }

  return { threads, setsByPath };
}

/**
 * Folds each working thread's latest read into its run's trail and drops the trails of threads
 * that stopped. Returns `previous` itself when nothing changed.
 */
export function observeReadTrails(
  previous: ReadonlyMap<ThreadId, CodeMapReadTrail>,
  threads: ReadonlyArray<CodeMapThreadInput>,
): ReadonlyMap<ThreadId, CodeMapReadTrail> {
  let next: Map<ThreadId, CodeMapReadTrail> | null = null;
  const working = new Set<ThreadId>();
  for (const thread of threads) {
    const runId = thread.source.activeRunId;
    if (!isLiveThread(thread) || !isActorWorking(thread)) continue;
    if (runId === null && !isSubagent(thread)) continue;
    working.add(thread.id);
    const active = thread.source.activeFile;
    const seen = active ? `${DateTime.toEpochMillis(active.at)}\n${active.op}\n${active.path}` : "";
    const trail = previous.get(thread.id);
    if (trail?.runId === runId && trail.seen === seen) continue;
    // The file active when a run is first seen was touched before then; the backfill lists it.
    const paths =
      trail?.runId !== runId
        ? []
        : active?.op === "read" && !trail.paths.includes(active.path)
          ? [...trail.paths, active.path]
          : trail.paths;
    next ??= new Map(previous);
    next.set(thread.id, { runId, seen, paths });
  }
  for (const threadId of previous.keys()) {
    if (working.has(threadId)) continue;
    next ??= new Map(previous);
    next.delete(threadId);
  }
  return next ?? previous;
}

/** The overlap rule, usable without a snapshot: a path changed in two or more working trees. */
export function deriveCodeMapOverlaps(input: MarkSetsInput): ReadonlyArray<CodeMapOverlap> {
  return overlapsOf(collectMarkSets(input).setsByPath);
}

function overlapsOf(
  setsByPath: ReadonlyMap<string, ReadonlyArray<CodeMapMarkSet>>,
): CodeMapOverlap[] {
  const overlaps: CodeMapOverlap[] = [];
  for (const [path, sets] of setsByPath) {
    if (sets.length > 1) overlaps.push({ path, threadIds: sets.flatMap((set) => set.threadIds) });
  }
  return overlaps;
}

export function deriveCodeMap(input: DeriveCodeMapInput): CodeMap {
  const { snapshot } = input;
  const listed = new Map<string, number>();
  snapshot.files.paths.forEach((path, i) => listed.set(path, snapshot.files.lines[i] ?? 0));

  const { threads, setsByPath } = collectMarkSets(input);

  // Only checkout roots: a project folder can be a subfolder, and map paths are repository-relative.
  const roots = new Set<string>(snapshot.checkouts);
  for (const changes of input.changesByRoot.values()) roots.add(changes.checkout);
  for (const thread of input.threads) {
    if (thread.worktreePath !== null) roots.add(thread.worktreePath);
  }
  // Where a sprite stands before any file of the map names its place.
  const busiest = new Map<ThreadId, { readonly path: string; readonly size: number }>();
  for (const [path, sets] of setsByPath) {
    if (!listed.has(path)) continue;
    for (const set of sets) {
      const size = set.insertions + set.deletions;
      for (const threadId of set.threadIds) {
        if ((busiest.get(threadId)?.size ?? -1) < size) busiest.set(threadId, { path, size });
      }
    }
  }
  const sprites: CodeMapSprite[] = [];
  const readers = new Map<string, ThreadId[]>();
  for (const { thread, kind, parentThreadId, colorThreadId, state } of collectActors(input)) {
    const active = thread.source.activeFile;
    const path = active ? checkoutRelativePath(active.path, roots) : null;
    const home = busiest.get(thread.id)?.path ?? null;
    // A thread that stopped has nowhere to stand until a file of the map names its place.
    if (state !== "working" && path === null && home === null) continue;
    sprites.push({
      threadId: thread.id,
      kind,
      parentThreadId,
      colorThreadId,
      path,
      home,
      op: active?.op ?? null,
      state,
    });
    if (state !== "working") continue;
    const observed = input.observedReads.get(thread.id);
    const trail = [
      ...(input.backfilledReads.get(thread.id) ?? []),
      ...(observed?.runId === thread.source.activeRunId ? observed.paths : []),
    ];
    for (const absolute of trail) {
      const path = checkoutRelativePath(absolute, roots);
      if (path === null) continue;
      const threadIds = readers.get(path);
      if (threadIds === undefined) readers.set(path, [colorThreadId]);
      else if (!threadIds.includes(colorThreadId)) threadIds.push(colorThreadId);
    }
  }

  const folderTotals = new Map(snapshot.folders.map((folder) => [folder.path, folder.fileCount]));
  let listedUnder: Map<string, number> | undefined;
  const hasHiddenFiles = (path: string): boolean => {
    if (!listedUnder) {
      listedUnder = new Map();
      for (const file of listed.keys()) {
        for (let dir = parentOf(file); dir !== ""; dir = parentOf(dir)) {
          listedUnder.set(dir, (listedUnder.get(dir) ?? 0) + 1);
        }
      }
    }
    for (let dir = parentOf(path); dir !== ""; dir = parentOf(dir)) {
      const total = folderTotals.get(dir);
      if (total === undefined) continue;
      const shown = listedUnder.get(dir) ?? 0;
      if (shown === 0 || dir === parentOf(path)) return total > shown;
    }
    return false;
  };

  const marks: CodeMapPathMark[] = [];
  for (const [path, sets] of setsByPath) {
    const lines = listed.get(path) ?? null;
    marks.push({ path, lines, isNew: lines === null && !hasHiddenFiles(path), sets });
  }

  return {
    threads,
    marks,
    overlaps: overlapsOf(setsByPath),
    sprites,
    reads: [...readers].map(([path, threadIds]) => ({ path, threadIds })),
  };
}
