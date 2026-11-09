import { parseScopedProjectKey, scopedProjectKey } from "@t3tools/client-runtime/environment";
import {
  deriveCodeMap,
  type CodeMap,
  type CodeMapChange,
} from "@t3tools/client-runtime/state/code-map";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type ScopedProjectRef } from "@t3tools/contracts";
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
    // Each root costs a git status stream. Recently finished worktrees stay in, because their
    // unmerged changes are the overlaps worth seeing.
    const recentSince = Date.now() - RECENT_WORKTREE_MS;
    const roots = new Set<string>([project.workspaceRoot]);
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
