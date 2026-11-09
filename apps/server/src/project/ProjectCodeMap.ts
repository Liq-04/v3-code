import { ProjectCodeMapError, type ProjectCodeMapSnapshot } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

const MAX_LISTED_FILES = 20_000;
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
    readonly snapshot: (
      workspaceRoot: string,
    ) => Effect.Effect<ProjectCodeMapSnapshot, ProjectCodeMapError>;
  }
>()("t3/project/ProjectCodeMap") {}

interface CodeMapEntry {
  readonly path: string;
  readonly lines: number;
  readonly folded: boolean;
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
    .filter((entry) => !entry.folded)
    .toSorted((a, b) => b.lines - a.lines || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, maxFiles);
  return {
    files: { paths: listed.map((entry) => entry.path), lines: listed.map((entry) => entry.lines) },
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

function parseFoldedPaths(stdout: string) {
  const folded = new Set<string>();
  const fields = stdout.split("\0");
  for (let index = 0; index + 2 < fields.length; index += 3) {
    if (fields[index + 2] === "set" || fields[index + 2] === "true") {
      folded.add(fields[index]!);
    }
  }
  return folded;
}

const shortRefName = (ref: string) => ref.replace(/^refs\/(?:heads|remotes)\//, "");

/** @public */
export const make = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const platform = yield* HostProcess.Platform;

  const gitFailed = (cause: unknown) => new ProjectCodeMapError({ failure: "git_failed", cause });

  const readTree = Effect.fn("ProjectCodeMap.readTree")(function* (cwd: string) {
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

    const remote = yield* git.resolvePrimaryRemoteName(cwd).pipe(Effect.orElseSucceed(() => null));
    const remoteDefault =
      remote === null
        ? null
        : yield* git.resolveDefaultBranchName(cwd, remote).pipe(Effect.mapError(gitFailed));
    const candidates = [
      ...(remote !== null && remoteDefault !== null
        ? [`refs/heads/${remoteDefault}`, `refs/remotes/${remote}/${remoteDefault}`]
        : []),
      ...FALLBACK_DEFAULT_BRANCHES.map((name) => `refs/heads/${name}`),
    ];
    for (const ref of candidates) {
      const tree = yield* git
        .execute({
          operation: "ProjectCodeMap.resolveTree",
          cwd,
          args: ["rev-parse", "--verify", "--quiet", `${ref}^{tree}`],
          allowNonZeroExit: true,
        })
        .pipe(Effect.mapError(gitFailed));
      if (tree.exitCode === 0) {
        return { treeSha: tree.stdout.trim(), baseRef: shortRefName(ref) };
      }
    }
    return yield* new ProjectCodeMapError({ failure: "default_branch_not_found" });
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
    const foldedPaths = parseFoldedPaths(attributes.stdout);
    return {
      treeSha: key.treeSha,
      baseRef: key.baseRef,
      ...foldCodeMap(
        parsed.map((entry) => ({ ...entry, folded: foldedPaths.has(entry.path) })),
        MAX_LISTED_FILES,
      ),
    } satisfies ProjectCodeMapSnapshot;
  }, Effect.mapError(gitFailed));

  const cache = yield* Cache.makeWith(build, {
    capacity: CACHE_CAPACITY,
    timeToLive: Exit.match({
      onSuccess: () => Duration.infinity,
      onFailure: () => Duration.zero,
    }),
  });

  const snapshot = Effect.fn("ProjectCodeMap.snapshot")(function* (workspaceRoot: string) {
    const { treeSha, baseRef } = yield* readTree(workspaceRoot);
    return yield* Cache.get(cache, new CodeMapCacheKey({ cwd: workspaceRoot, treeSha, baseRef }));
  });

  return ProjectCodeMap.of({ snapshot });
});

export const layer = Layer.effect(ProjectCodeMap, make);
