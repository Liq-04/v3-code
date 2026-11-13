import {
  parseScopedProjectKey,
  parseScopedThreadKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
} from "@t3tools/client-runtime/environment";
import {
  changesFingerprint,
  deriveCodeMap,
  deriveCodeMapOverlaps,
  observeReadTrails,
  repositoryGroupKey,
  repositoryGroupOf,
  type CodeMap,
  type CodeMapCheckoutChanges,
  type CodeMapReadTrail,
} from "@t3tools/client-runtime/state/code-map";
import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import {
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
  type EnvironmentId,
  type ProjectCodeMapSnapshot,
  type ProjectId,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { environmentProjects } from "./projects";
import { formatEnvironmentQueryError } from "./query";
import { environmentThreadShells } from "./threads";
import { vcsEnvironment } from "./vcs";

const CODE_MAP_BASES_STORAGE_KEY = "t3code:code-map-bases:v1";
const CodeMapBases = Schema.Record(Schema.String, Schema.String);
type CodeMapBases = typeof CodeMapBases.Type;
const NO_BASES: CodeMapBases = {};

interface CodeMapBaseChoice {
  /** `CodeMapView.baseKey`: one choice per repository. */
  readonly baseKey: string;
  /** Null returns the repository to its default branch. */
  readonly baseRef: string | null;
}

/** The base branch the operator chose for each repository's map and overlap pill. */
export const codeMapBasesAtom: Atom.Writable<CodeMapBases, CodeMapBaseChoice> = Atom.writable(
  (): CodeMapBases => {
    try {
      return getLocalStorageItem(CODE_MAP_BASES_STORAGE_KEY, CodeMapBases) ?? NO_BASES;
    } catch {
      return NO_BASES;
    }
  },
  (ctx, choice: CodeMapBaseChoice) => {
    const { [choice.baseKey]: _previous, ...rest } = ctx.get(codeMapBasesAtom);
    const bases = choice.baseRef === null ? rest : { ...rest, [choice.baseKey]: choice.baseRef };
    ctx.setSelf(bases);
    try {
      setLocalStorageItem(CODE_MAP_BASES_STORAGE_KEY, bases, CodeMapBases);
    } catch {
      // The choice still holds for this session.
    }
  },
).pipe(Atom.keepAlive, Atom.withLabel("code-map:bases"));

const baseInput = (baseRef: string | null) => (baseRef === null ? {} : { baseRef });

// The snapshot lists the repository's worktrees once, so one an agent makes mid-run (Claude's
// isolated subagents) stays unknown. Each thread's first touched file rereads them.
const fileTouchersFamily = Atom.family((key: string) => {
  const ref = parseScopedProjectKey(key);
  return Atom.make((get) => {
    const group = ref === null ? null : readGroup(get, ref);
    if (group === null) return "";
    return group.threads
      .flatMap((thread) => (thread.source.activeFile ? [thread.id] : []))
      .sort()
      .join("\n");
  });
});

const projectCodeMapSnapshot = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:projects:code-map",
  tag: WS_METHODS.projectsGetCodeMap,
  staleTimeMs: 30_000,
  idleTtlMs: 5 * 60_000,
  refreshTrigger: ({ environmentId, input }) =>
    fileTouchersFamily(scopedProjectKey(scopeProjectRef(environmentId, input.projectId))),
});

export const codeMapSnapshotAtom = (ref: ScopedProjectRef, baseRef: string | null) =>
  projectCodeMapSnapshot({
    environmentId: ref.environmentId,
    input: { projectId: ref.projectId, ...baseInput(baseRef) },
  });

const statusOf = (environmentId: EnvironmentId, root: string) =>
  vcsEnvironment.status({ environmentId, input: { cwd: root, includeRemote: false } });

/** Null until the checkout's git status arrives. */
const changesFingerprintFamily = Atom.family((key: string) => {
  const { environmentId, root } = JSON.parse(key) as {
    readonly environmentId: EnvironmentId;
    readonly root: string;
  };
  return Atom.make((get) => {
    const status = Option.getOrNull(AsyncResult.value(get(statusOf(environmentId, root))));
    return status === null ? null : changesFingerprint(status);
  });
});

const changesFingerprintAtom = (environmentId: EnvironmentId, root: string) =>
  changesFingerprintFamily(JSON.stringify({ environmentId, root }));

const codeMapChanges = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:projects:code-map-changes",
  tag: WS_METHODS.projectsGetCodeMapChanges,
  staleTimeMs: 30_000,
  idleTtlMs: 5 * 60_000,
  refreshTrigger: ({ environmentId, input }) => changesFingerprintAtom(environmentId, input.root),
});

const runReadPaths = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:orchestration:run-read-paths",
  tag: ORCHESTRATION_V2_WS_METHODS.getRunReadPaths,
  // Reread whenever the map opens: reads made while it was closed were not observed.
  staleTimeMs: 0,
  idleTtlMs: 60_000,
});

export type CodeMapView =
  | { readonly status: "loading" }
  | {
      readonly status: "error";
      readonly message: string;
      readonly baseKey: string;
      /** The operator's chosen base, or null when the default branch itself failed. */
      readonly chosenBaseRef: string | null;
    }
  | {
      readonly status: "ready";
      readonly treeSha: string;
      readonly baseKey: string;
      readonly baseRef: string;
      readonly defaultBaseRef: string | null;
      readonly chosenBaseRef: string | null;
      readonly files: ProjectCodeMapSnapshot["files"];
      /** Titles of every thread the map can show, whichever project owns it. */
      readonly threadTitles: ReadonlyMap<ThreadId, string>;
      /** The name of the project each of those threads belongs to. */
      readonly threadProjectNames: ReadonlyMap<ThreadId, string>;
      readonly model: CodeMap;
    };

const LOADING: CodeMapView = { status: "loading" };
const NO_TRAILS: ReadonlyMap<ThreadId, CodeMapReadTrail> = new Map();
const RECENT_WORKTREE_MS = 72 * 60 * 60 * 1000;

interface CodeMapGroup {
  readonly baseKey: string;
  readonly chosenBaseRef: string | null;
  readonly projectRoots: ReadonlyMap<ProjectId, string>;
  readonly projectTitles: ReadonlyMap<ProjectId, string>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}

/** Everyone working on the project's repository in its environment, whatever the checkout. */
function readGroup(get: Atom.AtomContext, ref: ScopedProjectRef): CodeMapGroup | null {
  const projects = get(environmentProjects.environmentProjectsAtom(ref.environmentId));
  const group = repositoryGroupOf(projects, ref.projectId);
  const own = group.find((project) => project.id === ref.projectId);
  if (own === undefined) return null;
  const baseKey = repositoryGroupKey(own) ?? scopedProjectKey(ref);
  return {
    baseKey,
    chosenBaseRef: get(codeMapBasesAtom)[baseKey] ?? null,
    projectRoots: new Map(group.map((project) => [project.id, project.workspaceRoot])),
    projectTitles: new Map(group.map((project) => [project.id, project.title])),
    threads: get(
      environmentThreadShells.threadShellsForProjectRefsAtom(
        group.map((project) => scopeProjectRef(ref.environmentId, project.id)),
      ),
    ),
  };
}

function readChangesByRoot(
  get: Atom.AtomContext,
  environmentId: EnvironmentId,
  group: CodeMapGroup,
): ReadonlyMap<string, CodeMapCheckoutChanges> {
  // Each root costs a git status stream. Recently finished worktrees stay in, because their
  // unmerged changes are the overlaps worth seeing.
  const recentSince = Date.now() - RECENT_WORKTREE_MS;
  const roots = new Set<string>(group.projectRoots.values());
  for (const thread of group.threads) {
    if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
    if (
      thread.worktreePath !== null &&
      (threadRuntimeIsActive(thread.runtime) || Date.parse(thread.updatedAt) >= recentSince)
    ) {
      roots.add(thread.worktreePath);
    }
  }
  const changesByRoot = new Map<string, CodeMapCheckoutChanges>();
  for (const root of roots) {
    // The first status would reread a diff that was asked for before it arrived.
    if (get(changesFingerprintAtom(environmentId, root)) === null) continue;
    const changes = Option.getOrNull(
      AsyncResult.value(
        get(codeMapChanges({ environmentId, input: { root, ...baseInput(group.chosenBaseRef) } })),
      ),
    );
    if (changes !== null) changesByRoot.set(root, changes);
  }
  return changesByRoot;
}

const observedReadsFamily = Atom.family((key: string) => {
  const ref = parseScopedProjectKey(key);
  return Atom.make((get): ReadonlyMap<ThreadId, CodeMapReadTrail> => {
    const group = ref === null ? null : readGroup(get, ref);
    if (group === null) return NO_TRAILS;
    const previous = Option.getOrElse(
      get.self<ReadonlyMap<ThreadId, CodeMapReadTrail>>(),
      () => NO_TRAILS,
    );
    return observeReadTrails(previous, group.threads);
  });
});

const codeMapViewFamily = Atom.family((key: string) => {
  const ref = parseScopedProjectKey(key);
  return Atom.make((get): CodeMapView => {
    if (ref === null) return LOADING;
    const group = readGroup(get, ref);
    if (group === null) return LOADING;
    const { baseKey, chosenBaseRef } = group;
    const snapshotResult = get(codeMapSnapshotAtom(ref, chosenBaseRef));
    if (snapshotResult._tag === "Failure") {
      return {
        status: "error",
        message: formatEnvironmentQueryError(snapshotResult.cause),
        baseKey,
        chosenBaseRef,
      };
    }
    const snapshot = Option.getOrNull(AsyncResult.value(snapshotResult));
    if (snapshot === null) return LOADING;

    const observedReads = get(observedReadsFamily(key));
    const backfilledReads = new Map<ThreadId, ReadonlyArray<string>>();
    for (const [threadId, trail] of observedReads) {
      const reads = Option.getOrNull(
        AsyncResult.value(
          get(
            runReadPaths({
              environmentId: ref.environmentId,
              input: { threadId, runId: trail.runId },
            }),
          ),
        ),
      );
      if (reads !== null) backfilledReads.set(threadId, reads.paths);
    }

    return {
      status: "ready",
      treeSha: snapshot.treeSha,
      baseKey,
      baseRef: snapshot.baseRef,
      defaultBaseRef: snapshot.defaultBaseRef,
      chosenBaseRef,
      files: snapshot.files,
      threadTitles: new Map(group.threads.map((thread) => [thread.id, thread.title])),
      threadProjectNames: new Map(
        group.threads.flatMap((thread) => {
          const name = group.projectTitles.get(thread.projectId);
          return name === undefined ? [] : [[thread.id, name] as const];
        }),
      ),
      model: deriveCodeMap({
        snapshot,
        threads: group.threads,
        changesByRoot: readChangesByRoot(get, ref.environmentId, group),
        projectRoots: group.projectRoots,
        now: new Date().toISOString(),
        backfilledReads,
        observedReads,
      }),
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
    const group = readGroup(get, scopeProjectRef(threadRef.environmentId, shell.projectId));
    if (group === null) return NO_OVERLAPS;
    const overlaps = deriveCodeMapOverlaps({
      threads: group.threads,
      changesByRoot: readChangesByRoot(get, threadRef.environmentId, group),
      projectRoots: group.projectRoots,
    }).filter((overlap) => overlap.threadIds.includes(threadRef.threadId));
    const result = overlaps.map(({ path, threadIds }) => ({
      path,
      otherTitles: threadIds
        .filter((id) => id !== threadRef.threadId)
        .map((id) => group.threads.find((t) => t.id === id)?.title || "Untitled thread"),
    }));
    const previous = Option.getOrNull(get.self<ReadonlyArray<ThreadOverlap>>());
    if (result.length === 0) return NO_OVERLAPS;
    return previous && JSON.stringify(previous) === JSON.stringify(result) ? previous : result;
  });
});

/** Reads thread shells and each checkout's diff against the map's base, never the snapshot. */
export const threadOverlapsAtom = (ref: ScopedThreadRef) =>
  threadOverlapsFamily(scopedThreadKey(ref));
