import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectCodeMap from "./ProjectCodeMap.ts";

const layerTest = (runs: Ref.Ref<number>, operation = "ProjectCodeMap.numstat") =>
  ProjectCodeMap.layer.pipe(
    Layer.provideMerge(
      Layer.effect(
        GitVcsDriver.GitVcsDriver,
        Effect.gen(function* () {
          const git = yield* GitVcsDriver.GitVcsDriver;
          return GitVcsDriver.GitVcsDriver.of({
            ...git,
            execute: (input) =>
              (input.operation === operation
                ? Ref.update(runs, (count) => count + 1)
                : Effect.void
              ).pipe(Effect.andThen(git.execute(input))),
          });
        }),
      ).pipe(
        Layer.provide(
          GitVcsDriver.layer.pipe(
            Layer.provide(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-code-map-test-" }),
            ),
          ),
        ),
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const repositoryAt = Effect.fn("repositoryAt")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const run = (...args: ReadonlyArray<string>) =>
    git.execute({ operation: "ProjectCodeMap.test", cwd, args });
  const write = (relativePath: string, content: string | Uint8Array) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(path.join(cwd, relativePath)), { recursive: true });
      if (typeof content === "string") {
        yield* fs.writeFileString(path.join(cwd, relativePath), content);
      } else {
        yield* fs.writeFile(path.join(cwd, relativePath), content);
      }
    });
  const commit = (message: string) =>
    Effect.gen(function* () {
      yield* run("add", "-A");
      yield* run(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        message,
      );
    });
  return { cwd, write, commit, run };
});

const makeRepository = Effect.fn("makeRepository")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const repo = yield* repositoryAt(
    yield* fs.makeTempDirectoryScoped({ prefix: "t3-project-code-map-" }),
  );
  yield* repo.run("init", "-b", "main");
  return repo;
});

const lines = (count: number) => "line\n".repeat(count);

describe("ProjectCodeMap", () => {
  it.effect("counts lines, lists vendored and generated paths flagged, and zeroes binaries", () =>
    Effect.gen(function* () {
      const repo = yield* makeRepository();
      yield* repo.write("src/a.ts", lines(3));
      yield* repo.write("src/deep/b.ts", lines(5));
      yield* repo.write("logo.png", new Uint8Array([0, 1, 2, 0, 255]));
      yield* repo.write(
        ".gitattributes",
        "vendor/** linguist-vendored\n*.gen.ts linguist-generated\n",
      );
      yield* repo.write("vendor/lib.js", lines(40));
      yield* repo.write("src/schema.gen.ts", lines(7));
      yield* repo.commit("initial");

      const codeMap = yield* ProjectCodeMap.ProjectCodeMap;
      const snapshot = yield* codeMap.snapshot(repo.cwd);

      assert.strictEqual(snapshot.baseRef, "main");
      assert.deepStrictEqual(
        snapshot.files.paths.map((path, index) => [
          path,
          snapshot.files.lines[index],
          snapshot.files.vendored[index],
        ]),
        [
          ["vendor/lib.js", 40, true],
          ["src/schema.gen.ts", 7, true],
          ["src/deep/b.ts", 5, false],
          ["src/a.ts", 3, false],
          [".gitattributes", 2, false],
          ["logo.png", 0, false],
        ],
      );
      assert.strictEqual(snapshot.filesTotal, 6);
      assert.deepStrictEqual(snapshot.folders, [
        { path: "src", fileCount: 3, lines: 15 },
        { path: "src/deep", fileCount: 1, lines: 5 },
        { path: "vendor", fileCount: 1, lines: 40 },
      ]);
    }).pipe(Effect.scoped, Effect.provide(layerTest(Ref.makeUnsafe(0)))),
  );

  it.effect("reads the default branch rather than the checked-out one", () =>
    Effect.gen(function* () {
      const repo = yield* makeRepository();
      yield* repo.write("a.ts", lines(1));
      yield* repo.commit("initial");
      yield* repo.run("checkout", "-b", "feature");
      yield* repo.write("b.ts", lines(1));
      yield* repo.commit("feature work");

      const snapshot = yield* (yield* ProjectCodeMap.ProjectCodeMap).snapshot(repo.cwd);
      assert.deepStrictEqual(snapshot.files.paths, ["a.ts"]);
    }).pipe(Effect.scoped, Effect.provide(layerTest(Ref.makeUnsafe(0)))),
  );

  it.effect("reads the requested base branch and names the default beside it", () =>
    Effect.gen(function* () {
      const repo = yield* makeRepository();
      yield* repo.write("a.ts", lines(1));
      yield* repo.commit("initial");
      yield* repo.run("checkout", "-b", "dev");
      yield* repo.write("b.ts", lines(2));
      yield* repo.commit("dev work");
      yield* repo.run("checkout", "main");
      const codeMap = yield* ProjectCodeMap.ProjectCodeMap;

      const snapshot = yield* codeMap.snapshot(repo.cwd, "dev");
      assert.strictEqual(snapshot.baseRef, "dev");
      assert.strictEqual(snapshot.defaultBaseRef, "main");
      assert.deepStrictEqual(snapshot.files.paths, ["b.ts", "a.ts"]);

      const error = yield* codeMap.snapshot(repo.cwd, "missing").pipe(Effect.flip);
      assert.strictEqual(error.failure, "base_not_found");
    }).pipe(Effect.scoped, Effect.provide(layerTest(Ref.makeUnsafe(0)))),
  );

  it.effect("measures against the remote's branch when the local copy is behind", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const upstream = yield* makeRepository();
      yield* upstream.write("a.ts", lines(1));
      yield* upstream.commit("initial");
      const cloneRoot = path.join(yield* fs.makeTempDirectoryScoped(), "clone");
      yield* upstream.run("clone", upstream.cwd, cloneRoot);
      const clone = yield* repositoryAt(cloneRoot);
      yield* upstream.write("b.ts", lines(2));
      yield* upstream.commit("lands upstream");
      yield* clone.run("fetch", "origin");
      yield* clone.run("checkout", "-b", "feature", "origin/main");
      yield* clone.write("c.ts", lines(3));
      yield* clone.commit("feature work");
      const codeMap = yield* ProjectCodeMap.ProjectCodeMap;

      for (const base of [undefined, "main", "origin/main"]) {
        const snapshot = yield* codeMap.snapshot(clone.cwd, base);
        assert.strictEqual(snapshot.baseRef, base ?? "main");
        assert.strictEqual(snapshot.defaultBaseRef, "main");
        assert.deepStrictEqual(snapshot.files.paths, ["b.ts", "a.ts"]);
        assert.deepStrictEqual(
          (yield* codeMap.changes(clone.cwd, base)).files.map((file) => file.path),
          ["c.ts"],
        );
      }

      // A branch that was never pushed has only its local ref.
      assert.deepStrictEqual((yield* codeMap.snapshot(clone.cwd, "feature")).files.paths, [
        "c.ts",
        "b.ts",
        "a.ts",
      ]);
    }).pipe(Effect.scoped, Effect.provide(layerTest(Ref.makeUnsafe(0)))),
  );

  it.effect("lists linked worktrees as checkouts without rebuilding the tree", () => {
    const numstatRuns = Ref.makeUnsafe(0);
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repo = yield* makeRepository();
      yield* repo.write("a.ts", lines(1));
      yield* repo.commit("initial");
      const codeMap = yield* ProjectCodeMap.ProjectCodeMap;
      const root = yield* fs.realPath(repo.cwd);
      assert.deepStrictEqual((yield* codeMap.snapshot(repo.cwd)).checkouts, [root]);

      const linked = path.join(yield* fs.makeTempDirectoryScoped(), "linked");
      yield* repo.run("worktree", "add", "-b", "feature", linked);
      const snapshot = yield* codeMap.snapshot(repo.cwd);
      assert.deepStrictEqual(snapshot.checkouts, [root, yield* fs.realPath(linked)]);
      assert.strictEqual(yield* Ref.get(numstatRuns), 1);
    }).pipe(Effect.scoped, Effect.provide(layerTest(numstatRuns)));
  });

  it.effect("diffs a stacked branch against the chosen base and counts untracked files", () => {
    const baseLookups = Ref.makeUnsafe(0);
    return Effect.gen(function* () {
      const repo = yield* makeRepository();
      yield* repo.write("a.ts", lines(1));
      yield* repo.commit("initial");
      yield* repo.run("checkout", "-b", "parent");
      yield* repo.write("parent.ts", lines(3));
      yield* repo.commit("parent work");
      yield* repo.run("checkout", "-b", "child");
      yield* repo.write("child.ts", lines(2));
      yield* repo.commit("child work");
      yield* repo.write("a.ts", lines(5));
      yield* repo.write("untracked.ts", lines(7));
      const codeMap = yield* ProjectCodeMap.ProjectCodeMap;

      const fs = yield* FileSystem.FileSystem;
      const checkout = yield* fs.realPath(repo.cwd);
      const againstDefault = yield* codeMap.changes(repo.cwd);
      assert.deepStrictEqual(againstDefault, {
        checkout,
        files: [
          { path: "untracked.ts", insertions: 7, deletions: 0 },
          { path: "a.ts", insertions: 4, deletions: 0 },
          { path: "parent.ts", insertions: 3, deletions: 0 },
          { path: "child.ts", insertions: 2, deletions: 0 },
        ],
        filesTotal: 4,
      });

      const path = yield* Path.Path;
      yield* repo.write("docs/guide.md", lines(1));
      const fromSubfolder = yield* codeMap.changes(path.join(repo.cwd, "docs"));
      assert.strictEqual(fromSubfolder.checkout, checkout);
      assert.deepStrictEqual(
        fromSubfolder.files.map((file) => file.path),
        ["untracked.ts", "a.ts", "parent.ts", "child.ts", "docs/guide.md"],
      );

      yield* Ref.set(baseLookups, 0);
      const againstParent = yield* codeMap.changes(repo.cwd, "parent");
      assert.deepStrictEqual(
        againstParent.files.map((file) => file.path),
        ["untracked.ts", "a.ts", "child.ts", "docs/guide.md"],
      );
      // A named base is the only one looked up: the default branch is not resolved beside it.
      assert.strictEqual(yield* Ref.get(baseLookups), 1);

      const error = yield* codeMap.changes(repo.cwd, "missing").pipe(Effect.flip);
      assert.strictEqual(error.failure, "base_not_found");
    }).pipe(Effect.scoped, Effect.provide(layerTest(baseLookups, "ProjectCodeMap.resolveTree")));
  });

  it.effect("serves an unchanged tree from cache and rereads after a new commit", () => {
    const numstatRuns = Ref.makeUnsafe(0);
    return Effect.gen(function* () {
      const repo = yield* makeRepository();
      yield* repo.write("a.ts", lines(2));
      yield* repo.commit("initial");
      const codeMap = yield* ProjectCodeMap.ProjectCodeMap;

      const first = yield* codeMap.snapshot(repo.cwd);
      const second = yield* codeMap.snapshot(repo.cwd);
      assert.strictEqual(second.treeSha, first.treeSha);
      assert.strictEqual(yield* Ref.get(numstatRuns), 1);

      yield* repo.write("b.ts", lines(4));
      yield* repo.commit("add b");
      const third = yield* codeMap.snapshot(repo.cwd);
      assert.notStrictEqual(third.treeSha, first.treeSha);
      assert.deepStrictEqual(third.files.paths, ["b.ts", "a.ts"]);
      assert.strictEqual(yield* Ref.get(numstatRuns), 2);
    }).pipe(Effect.scoped, Effect.provide(layerTest(numstatRuns)));
  });

  it.effect("fails with a typed error outside a Git repository", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-project-code-map-none-" });
      const error = yield* (yield* ProjectCodeMap.ProjectCodeMap).snapshot(cwd).pipe(Effect.flip);
      assert.strictEqual(error.failure, "not_a_git_repository");
    }).pipe(Effect.scoped, Effect.provide(layerTest(Ref.makeUnsafe(0)))),
  );
});

describe("foldCodeMap", () => {
  it("lists vendored files too, largest first, caps the list, and keeps capped files in folder totals", () => {
    const entries = [
      { path: "a/small.ts", lines: 1, vendored: false },
      { path: "a/big.ts", lines: 9, vendored: false },
      { path: "b/mid.ts", lines: 5, vendored: false },
      { path: "b/vendored.ts", lines: 100, vendored: true },
    ];
    const result = ProjectCodeMap.foldCodeMap(entries, 2);
    assert.deepStrictEqual(result.files, {
      paths: ["b/vendored.ts", "a/big.ts"],
      lines: [100, 9],
      vendored: [true, false],
    });
    assert.strictEqual(result.filesTotal, 4);
    assert.deepStrictEqual(result.folders, [
      { path: "a", fileCount: 2, lines: 10 },
      { path: "b", fileCount: 2, lines: 105 },
    ]);
  });
});
