import {
  parseScopedProjectKey,
  parseScopedThreadKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
} from "@t3tools/client-runtime/environment";
import {
  deriveCodeMap,
  deriveCodeMapOverlaps,
  type CodeMap,
  type CodeMapChange,
} from "@t3tools/client-runtime/state/code-map";
import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type ScopedProjectRef, type ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentProjects } from "./projects";
import { formatEnvironmentQueryError } from "./query";
import { environmentThreadShells } from "./threads";
import { vcsEnvironment } from "./vcs";

const projectCodeMapSnapshot = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:projects:code-map",
  tag: WS_METHODS.projectsGetCodeMap,
  staleTimeMs: 30_000,
  idleTtlMs: 5 * 60_000,
});

export const codeMapSnapshotAtom = (ref: ScopedProjectRef) =>
  projectCodeMapSnapshot({ environmentId: ref.environmentId, input: { projectId: ref.projectId } });

export type CodeMapView =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "ready";
      readonly treeSha: string;
      readonly baseRef: string;
      readonly model: CodeMap;
      /** Sorted; the array keeps its identity while the set of marked paths is unchanged. */
      readonly markedPaths: ReadonlyArray<string>;
    };

const LOADING: CodeMapView = { status: "loading" };
const NO_CHANGES: ReadonlyArray<CodeMapChange> = [];
const RECENT_WORKTREE_MS = 72 * 60 * 60 * 1000;

function readChangesByRoot(
  get: Atom.AtomContext,
  ref: ScopedProjectRef,
  projectRoot: string,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyMap<string, ReadonlyArray<CodeMapChange>> {
  // Each root costs a git status stream. Recently finished worktrees stay in, because their
  // unmerged changes are the overlaps worth seeing.
  const recentSince = Date.now() - RECENT_WORKTREE_MS;
  const roots = new Set<string>([projectRoot]);
  for (const thread of threads) {
    if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
    if (
      thread.worktreePath !== null &&
      (threadRuntimeIsActive(thread.runtime) || Date.parse(thread.updatedAt) >= recentSince)
    ) {
      roots.add(thread.worktreePath);
    }
  }
  const changesByRoot = new Map<string, ReadonlyArray<CodeMapChange>>();
  for (const root of roots) {
    const status = Option.getOrNull(
      AsyncResult.value(
        get(
          vcsEnvironment.status({
            environmentId: ref.environmentId,
            input: { cwd: root, includeRemote: false },
          }),
        ),
      ),
    );
    changesByRoot.set(root, status?.branchChanges?.files ?? NO_CHANGES);
  }
  return changesByRoot;
}

const codeMapViewFamily = Atom.family((key: string) => {
  const ref = parseScopedProjectKey(key);
  return Atom.make((get): CodeMapView => {
    if (ref === null) return LOADING;
    const project = get(environmentProjects.projectAtom(ref));
    if (project === null) return LOADING;
    const snapshotResult = get(codeMapSnapshotAtom(ref));
    if (snapshotResult._tag === "Failure") {
      return { status: "error", message: formatEnvironmentQueryError(snapshotResult.cause) };
    }
    const snapshot = Option.getOrNull(AsyncResult.value(snapshotResult));
    if (snapshot === null) return LOADING;

    const threads = get(environmentThreadShells.threadShellsForProjectRefsAtom([ref]));
    const changesByRoot = readChangesByRoot(get, ref, project.workspaceRoot, threads);

    const previous = Option.getOrNull(get.self<CodeMapView>());
    const model = deriveCodeMap({
      snapshot,
      threads,
      changesByRoot,
      projectRoot: project.workspaceRoot,
    });
    const markedPaths = model.marks.map((mark) => mark.path).sort();
    const sameTree = previous?.status === "ready" && previous.treeSha === snapshot.treeSha;
    const sameMarks =
      previous?.status === "ready" &&
      previous.markedPaths.length === markedPaths.length &&
      previous.markedPaths.every((path, i) => path === markedPaths[i]);
    return {
      status: "ready",
      treeSha: snapshot.treeSha,
      baseRef: snapshot.baseRef,
      model: sameTree ? { ...model, folders: previous.model.folders } : model,
      markedPaths: sameMarks ? previous.markedPaths : markedPaths,
    };
  });
});

export const codeMapViewAtom = (ref: ScopedProjectRef) => codeMapViewFamily(scopedProjectKey(ref));

export interface ThreadOverlap {
  readonly path: string;
  readonly otherTitles: ReadonlyArray<string>;
}

const NO_OVERLAPS: ReadonlyArray<ThreadOverlap> = [];

const threadOverlapsFamily = Atom.family((key: string) => {
  const threadRef = parseScopedThreadKey(key);
  return Atom.make((get): ReadonlyArray<ThreadOverlap> => {
    if (threadRef === null) return NO_OVERLAPS;
    const shell = get(environmentThreadShells.threadShellAtom(threadRef));
    if (shell === null) return NO_OVERLAPS;
    const ref = scopeProjectRef(threadRef.environmentId, shell.projectId);
    const project = get(environmentProjects.projectAtom(ref));
    if (project === null) return NO_OVERLAPS;
    const threads = get(environmentThreadShells.threadShellsForProjectRefsAtom([ref]));
    const overlaps = deriveCodeMapOverlaps({
      threads,
      changesByRoot: readChangesByRoot(get, ref, project.workspaceRoot, threads),
      projectRoot: project.workspaceRoot,
    }).filter((overlap) => overlap.threadIds.includes(threadRef.threadId));
    const result = overlaps.map(({ path, threadIds }) => ({
      path,
      otherTitles: threadIds
        .filter((id) => id !== threadRef.threadId)
        .map((id) => threads.find((t) => t.id === id)?.title || "Untitled thread"),
    }));
    const previous = Option.getOrNull(get.self<ReadonlyArray<ThreadOverlap>>());
    if (result.length === 0) return NO_OVERLAPS;
    return previous && JSON.stringify(previous) === JSON.stringify(result) ? previous : result;
  });
});

/** Reads only thread shells and git status, never the code map snapshot. */
export const threadOverlapsAtom = (ref: ScopedThreadRef) =>
  threadOverlapsFamily(scopedThreadKey(ref));
