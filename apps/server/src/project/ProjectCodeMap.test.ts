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

const layerTest = (numstatRuns: Ref.Ref<number>) =>
  ProjectCodeMap.layer.pipe(
    Layer.provideMerge(
      Layer.effect(
        GitVcsDriver.GitVcsDriver,
        Effect.gen(function* () {
          const git = yield* GitVcsDriver.GitVcsDriver;
          return GitVcsDriver.GitVcsDriver.of({
            ...git,
            execute: (input) =>
              (input.operation === "ProjectCodeMap.numstat"
                ? Ref.update(numstatRuns, (runs) => runs + 1)
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

const makeRepository = Effect.fn("makeRepository")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-project-code-map-" });
  const run = (...args: ReadonlyArray<string>) =>
    git.execute({ operation: "ProjectCodeMap.test", cwd, args });
  yield* run("init", "-b", "main");
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

const lines = (count: number) => "line\n".repeat(count);

describe("ProjectCodeMap", () => {
  it.effect(
    "counts lines, folds vendored and generated paths into folders, and zeroes binaries",
    () =>
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
          snapshot.files.paths.map((path, index) => [path, snapshot.files.lines[index]]),
          [
            ["src/deep/b.ts", 5],
            ["src/a.ts", 3],
            [".gitattributes", 2],
            ["logo.png", 0],
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
  it("lists the largest files first, caps the list, and keeps capped files in folder totals", () => {
    const entries = [
      { path: "a/small.ts", lines: 1, folded: false },
      { path: "a/big.ts", lines: 9, folded: false },
      { path: "b/mid.ts", lines: 5, folded: false },
      { path: "b/vendored.ts", lines: 100, folded: true },
    ];
    const result = ProjectCodeMap.foldCodeMap(entries, 2);
    assert.deepStrictEqual(result.files, { paths: ["a/big.ts", "b/mid.ts"], lines: [9, 5] });
    assert.strictEqual(result.filesTotal, 4);
    assert.deepStrictEqual(result.folders, [
      { path: "a", fileCount: 2, lines: 10 },
      { path: "b", fileCount: 2, lines: 105 },
    ]);
  });
});
