import {
  ProjectCodeMapError,
  type ProjectCodeMapChanges,
  type ProjectCodeMapSnapshot,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

const MAX_LISTED_FILES = 200_000;
const CACHE_CAPACITY = 16;
const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const FALLBACK_DEFAULT_BRANCHES = ["main", "master"] as const;

class CodeMapCacheKey extends Data.Class<{
  readonly cwd: string;
  readonly treeSha: string;
  readonly baseRef: string;
}> {}

export class ProjectCodeMap extends Context.Service<
  ProjectCodeMap,
  {
    /** `baseRef` is a branch name; omitted means the repository's default branch. */
    readonly snapshot: (
      workspaceRoot: string,
      baseRef?: string,
    ) => Effect.Effect<ProjectCodeMapSnapshot, ProjectCodeMapError>;
    /** What the checkout containing `root` changed since it left the base branch. */
    readonly changes: (
      root: string,
      baseRef?: string,
    ) => Effect.Effect<ProjectCodeMapChanges, ProjectCodeMapError>;
  }
>()("t3/project/ProjectCodeMap") {}

interface CodeMapEntry {
  readonly path: string;
  readonly lines: number;
  readonly vendored: boolean;
}

/** @public */
export function foldCodeMap(
  entries: ReadonlyArray<CodeMapEntry>,
  maxFiles: number,
): Pick<ProjectCodeMapSnapshot, "files" | "folders" | "filesTotal"> {
  const totals = new Map<string, { fileCount: number; lines: number }>();
  for (const entry of entries) {
    let slash = entry.path.indexOf("/");
    while (slash !== -1) {
      const folder = entry.path.slice(0, slash);
      const total = totals.get(folder) ?? { fileCount: 0, lines: 0 };
      total.fileCount += 1;
      total.lines += entry.lines;
      totals.set(folder, total);
      slash = entry.path.indexOf("/", slash + 1);
    }
  }
  const listed = entries
    .toSorted((a, b) => b.lines - a.lines || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, maxFiles);
  return {
    files: {
      paths: listed.map((entry) => entry.path),
      lines: listed.map((entry) => entry.lines),
      vendored: listed.map((entry) => entry.vendored),
    },
    folders: [...totals]
      .map(([path, total]) => ({ path, ...total }))
      .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    filesTotal: entries.length,
  };
}

function parseNumstat(stdout: string) {
  const entries: Array<{ path: string; lines: number }> = [];
  for (const record of stdout.split("\0")) {
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab === -1 || secondTab === -1) continue;
    // Binary files report "-" for both counts.
    const added = Number(record.slice(0, firstTab));
    const deleted = Number(record.slice(firstTab + 1, secondTab));
    entries.push({
      path: record.slice(secondTab + 1),
      lines: Number.isFinite(added) && Number.isFinite(deleted) ? added : 0,
    });
  }
  return entries;
}

function parseVendoredPaths(stdout: string) {
  const vendored = new Set<string>();
  const fields = stdout.split("\0");
  for (let index = 0; index + 2 < fields.length; index += 3) {
    if (fields[index + 2] === "set" || fields[index + 2] === "true") {
      vendored.add(fields[index]!);
    }
  }
  return vendored;
}

interface BaseCandidate {
  /** The branch name the operator sees and picks. */
  readonly name: string;
  readonly ref: string;
}

// The remote's copy comes first: a local branch nobody pulled gives every checkout an old
// merge-base, and work that already landed shows up as theirs.
const branchCandidates = (name: string, remote: string | null): ReadonlyArray<BaseCandidate> => [
  ...(remote === null ? [] : [{ name, ref: `refs/remotes/${remote}/${name}` }]),
  { name, ref: `refs/heads/${name}` },
];

/** @public */
export const make = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const platform = yield* HostProcess.Platform;

  const gitFailed = (cause: unknown) => new ProjectCodeMapError({ failure: "git_failed", cause });

  const firstTree = Effect.fn("ProjectCodeMap.firstTree")(function* (
    cwd: string,
    candidates: ReadonlyArray<BaseCandidate>,
  ) {
    for (const candidate of candidates) {
      const tree = yield* git
        .execute({
          operation: "ProjectCodeMap.resolveTree",
          cwd,
          args: ["rev-parse", "--verify", "--quiet", `${candidate.ref}^{tree}`],
          allowNonZeroExit: true,
        })
        .pipe(Effect.mapError(gitFailed));
      if (tree.exitCode === 0) return { ...candidate, treeSha: tree.stdout.trim() };
    }
    return null;
  });

  /** The primary remote, or null without one. Fails outside a repository. */
  const repositoryRemote = Effect.fn("ProjectCodeMap.repositoryRemote")(function* (cwd: string) {
    const inside = yield* git
      .execute({
        operation: "ProjectCodeMap.isRepository",
        cwd,
        args: ["rev-parse", "--git-dir"],
        allowNonZeroExit: true,
      })
      .pipe(Effect.mapError(gitFailed));
    if (inside.exitCode !== 0) {
      return yield* new ProjectCodeMapError({ failure: "not_a_git_repository" });
    }
    return yield* git.resolvePrimaryRemoteName(cwd).pipe(Effect.orElseSucceed(() => null));
  });

  const resolveDefaultBase = Effect.fn("ProjectCodeMap.resolveDefaultBase")(function* (
    cwd: string,
    remote: string | null,
  ) {
    const remoteDefault =
      remote === null
        ? null
        : yield* git.resolveDefaultBranchName(cwd, remote).pipe(Effect.mapError(gitFailed));
    return yield* firstTree(
      cwd,
      [...(remoteDefault === null ? [] : [remoteDefault]), ...FALLBACK_DEFAULT_BRANCHES].flatMap(
        (name) => branchCandidates(name, remote),
      ),
    );
  });

  const resolveNamedBase = (cwd: string, remote: string | null, name: string) =>
    firstTree(cwd, [...branchCandidates(name, remote), { name, ref: `refs/remotes/${name}` }]);

  const baseNotFound = (requested: string | undefined) =>
    new ProjectCodeMapError({
      failure: requested === undefined ? "default_branch_not_found" : "base_not_found",
    });

  const build = Effect.fn("ProjectCodeMap.build")(function* (key: CodeMapCacheKey) {
    const emptyTree = yield* git.execute({
      operation: "ProjectCodeMap.emptyTree",
      cwd: key.cwd,
      args: ["hash-object", "-t", "tree", platform === "win32" ? "NUL" : "/dev/null"],
    });
    const numstat = yield* git.execute({
      operation: "ProjectCodeMap.numstat",
      cwd: key.cwd,
      args: [
        "diff",
        "--numstat",
        "-z",
        "--no-renames",
        "--no-ext-diff",
        emptyTree.stdout.trim(),
        key.treeSha,
      ],
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
    });
    const parsed = parseNumstat(numstat.stdout);
    // Read attributes from the tree itself so the snapshot never depends on the checked-out branch.
    const attributes = yield* git.execute({
      operation: "ProjectCodeMap.checkAttr",
      cwd: key.cwd,
      args: [
        "check-attr",
        "--source",
        key.treeSha,
        "--stdin",
        "-z",
        "linguist-vendored",
        "linguist-generated",
      ],
      stdin: parsed.map((entry) => `${entry.path}\0`).join(""),
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
    });
    const vendoredPaths = parseVendoredPaths(attributes.stdout);
    return {
      treeSha: key.treeSha,
      baseRef: key.baseRef,
      ...foldCodeMap(
        parsed.map((entry) => ({ ...entry, vendored: vendoredPaths.has(entry.path) })),
        MAX_LISTED_FILES,
      ),
    };
  }, Effect.mapError(gitFailed));

  const cache = yield* Cache.makeWith(build, {
    capacity: CACHE_CAPACITY,
    timeToLive: Exit.match({
      onSuccess: () => Duration.infinity,
      onFailure: () => Duration.zero,
    }),
  });

  const snapshot = Effect.fn("ProjectCodeMap.snapshot")(function* (
    workspaceRoot: string,
    baseRef?: string,
  ) {
    const remote = yield* repositoryRemote(workspaceRoot);
    const defaultBase = yield* resolveDefaultBase(workspaceRoot, remote);
    const base =
      baseRef === undefined ? defaultBase : yield* resolveNamedBase(workspaceRoot, remote, baseRef);
    if (base === null) return yield* baseNotFound(baseRef);
    // Checkouts come and go without moving the base tree, so they stay out of the cache.
    const [tree, checkouts] = yield* Effect.all(
      [
        Cache.get(
          cache,
          new CodeMapCacheKey({
            cwd: workspaceRoot,
            treeSha: base.treeSha,
            baseRef: base.name,
          }),
        ),
        git.listWorktreePaths(workspaceRoot).pipe(Effect.mapError(gitFailed)),
      ],
      { concurrency: "unbounded" },
    );
    return {
      ...tree,
      defaultBaseRef: defaultBase?.name ?? null,
      checkouts,
    } satisfies ProjectCodeMapSnapshot;
  });

  const changes = Effect.fn("ProjectCodeMap.changes")(function* (root: string, baseRef?: string) {
    const remote = yield* repositoryRemote(root);
    // This runs on every status change of every watched checkout: only the base it diffs is resolved.
    const base =
      baseRef === undefined
        ? yield* resolveDefaultBase(root, remote)
        : yield* resolveNamedBase(root, remote, baseRef);
    if (base === null) return yield* baseNotFound(baseRef);
    // A project can be rooted in a subfolder; untracked files are only listed below the cwd.
    const toplevel = yield* git
      .execute({
        operation: "ProjectCodeMap.checkoutRoot",
        cwd: root,
        args: ["rev-parse", "--show-toplevel"],
      })
      .pipe(Effect.mapError(gitFailed));
    const checkout = toplevel.stdout.trim();
    const { files, filesTotal } = yield* git
      .readBranchChanges(checkout, base.ref)
      .pipe(Effect.mapError(gitFailed));
    return { checkout, files, filesTotal } satisfies ProjectCodeMapChanges;
  });

  return ProjectCodeMap.of({ snapshot, changes });
});

export const layer = Layer.effect(ProjectCodeMap, make);
