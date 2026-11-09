import {
  ProjectIconColor,
  type OrchestrationV2ThreadShell,
  type ProjectCodeMapSnapshot,
  type ThreadId,
} from "@t3tools/contracts";

import { threadRuntimeIsActive, type EnvironmentThreadShell } from "./models.ts";
import { isThreadWorking } from "./threadInbox.ts";

export interface CodeMapChange {
  readonly path: string;
  readonly insertions: number;
  readonly deletions: number;
}

export interface CodeMapFolder {
  /** Repo-relative; the empty string holds files at the repo root. */
  readonly path: string;
  /** Recursive totals from the snapshot, including files that are not listed. */
  readonly fileCount: number;
  readonly lines: number;
  /** Listed files whose direct parent is this folder. */
  readonly files: ReadonlyArray<{ readonly path: string; readonly lines: number }>;
}

export interface CodeMapThread {
  readonly threadId: ThreadId;
  /** Worktree path, or the project root when the thread has no worktree. */
  readonly root: string;
  readonly running: boolean;
  /** Not running and its runtime is no longer active. A thread waiting on the user is neither. */
  readonly finished: boolean;
}

export interface CodeMapMarkSet {
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
  /** Null means the latest touch named no path inside the root: keep the sprite where it was. */
  readonly path: string | null;
  readonly op: "read" | "edit" | null;
}

export interface CodeMap {
  readonly folders: ReadonlyArray<CodeMapFolder>;
  readonly threads: ReadonlyArray<CodeMapThread>;
  readonly marks: ReadonlyArray<CodeMapPathMark>;
  readonly overlaps: ReadonlyArray<CodeMapOverlap>;
  readonly sprites: ReadonlyArray<CodeMapSprite>;
}

export type CodeMapThreadInput = Pick<
  EnvironmentThreadShell,
  | "id"
  | "worktreePath"
  | "archivedAt"
  | "deletedAt"
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "interactionMode"
  | "latestRun"
  | "runtime"
  | "lineage"
> & { readonly source: Pick<OrchestrationV2ThreadShell, "activeFile"> };

export interface DeriveCodeMapInput {
  readonly snapshot: ProjectCodeMapSnapshot;
  /** The project's threads. Archived and deleted ones are skipped here. */
  readonly threads: ReadonlyArray<CodeMapThreadInput>;
  readonly changesByRoot: ReadonlyMap<string, ReadonlyArray<CodeMapChange>>;
  readonly projectRoot: string;
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

type MarkSetsInput = Pick<DeriveCodeMapInput, "threads" | "changesByRoot" | "projectRoot">;

function collectMarkSets(input: MarkSetsInput) {
  const projectRoot = normalizeRoot(input.projectRoot);
  const changes = new Map<string, ReadonlyArray<CodeMapChange>>();
  for (const [root, files] of input.changesByRoot) changes.set(normalizeRoot(root), files);
  const threads: CodeMapThread[] = [];
  const idsByRoot = new Map<string, ThreadId[]>();
  const sprites: CodeMapSprite[] = [];
  const liveIds = new Set<ThreadId>();
  for (const thread of input.threads) {
    if (thread.archivedAt === null && thread.deletedAt === null) liveIds.add(thread.id);
  }
  for (const thread of input.threads) {
    if (!liveIds.has(thread.id)) continue;
    if (thread.lineage.relationshipToParent === "subagent") {
      const rootId = thread.lineage.rootThreadId;
      if (isThreadWorking(thread) && liveIds.has(rootId)) {
        const active = thread.source.activeFile;
        sprites.push({
          threadId: thread.id,
          kind: "subagent",
          parentThreadId: rootId,
          colorThreadId: rootId,
          path: active?.path ?? null,
          op: active?.op ?? null,
        });
      }
      continue;
    }
    const root = normalizeRoot(thread.worktreePath ?? projectRoot);
    const running = isThreadWorking(thread);
    if (!running && !changes.get(root)?.length) continue;
    threads.push({
      threadId: thread.id,
      root,
      running,
      finished: !running && !threadRuntimeIsActive(thread.runtime),
    });
    const ids = idsByRoot.get(root);
    if (ids) ids.push(thread.id);
    else idsByRoot.set(root, [thread.id]);
    if (running) {
      const active = thread.source.activeFile;
      sprites.push({
        threadId: thread.id,
        kind: "agent",
        parentThreadId: null,
        colorThreadId: thread.id,
        path: active?.path ?? null,
        op: active?.op ?? null,
      });
    }
  }

  const setsByPath = new Map<string, CodeMapMarkSet[]>();
  for (const [root, threadIds] of idsByRoot) {
    for (const change of changes.get(root) ?? []) {
      const set = { root, threadIds, insertions: change.insertions, deletions: change.deletions };
      const sets = setsByPath.get(change.path);
      if (sets) sets.push(set);
      else setsByPath.set(change.path, [set]);
    }
  }

  return { threads, sprites, setsByPath };
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
  const filesByFolder = new Map<string, Array<{ path: string; lines: number }>>();
  const listed = new Map<string, number>();
  snapshot.files.paths.forEach((path, i) => {
    const lines = snapshot.files.lines[i] ?? 0;
    listed.set(path, lines);
    const parent = parentOf(path);
    const files = filesByFolder.get(parent);
    if (files) files.push({ path, lines });
    else filesByFolder.set(parent, [{ path, lines }]);
  });
  const folders: CodeMapFolder[] = snapshot.folders.map((folder) => ({
    ...folder,
    files: filesByFolder.get(folder.path) ?? [],
  }));
  const rootFiles = filesByFolder.get("");
  if (rootFiles) {
    folders.unshift({
      path: "",
      fileCount:
        snapshot.filesTotal -
        snapshot.folders.reduce((sum, f) => sum + (f.path.includes("/") ? 0 : f.fileCount), 0),
      lines: rootFiles.reduce((sum, file) => sum + file.lines, 0),
      files: rootFiles,
    });
  }

  const { threads, sprites, setsByPath } = collectMarkSets(input);

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

  return { folders, threads, marks, overlaps: overlapsOf(setsByPath), sprites };
}
