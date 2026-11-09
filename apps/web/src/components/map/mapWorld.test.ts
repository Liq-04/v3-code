import { describe, expect, it } from "vite-plus/test";

import {
  buildWorld,
  hitTest,
  rectOf,
  type World,
  type WorldFile,
  type WorldFolder,
  type WorldNode,
} from "./mapWorld";

const files = {
  paths: [
    "README.md",
    "apps/web/src/App.tsx",
    "apps/web/src/index.css",
    "apps/server/src/ws.ts",
    "packages/contracts/src/git.ts",
    "packages/contracts/src/orchestrationV2.ts",
    "node_modules/left-pad/index.js",
  ],
  lines: [40, 300, 1300, 2200, 700, 4200, 90000],
  vendored: [false, false, false, false, false, false, true],
};

const inside = (inner: WorldNode, outer: WorldNode) =>
  inner.x >= outer.x - 1e-6 &&
  inner.y >= outer.y - 1e-6 &&
  inner.x + inner.w <= outer.x + outer.w + 1e-6 &&
  inner.y + inner.h <= outer.y + outer.h + 1e-6;

function* walk(node: WorldFolder): Generator<[WorldNode, WorldFolder]> {
  for (const kid of node.kids) {
    yield [kid, node];
    if (kid.kind === "folder") yield* walk(kid);
  }
}

const topLevel = (world: World) => world.root.kids.filter((kid) => kid.kind === "folder");

describe("buildWorld", () => {
  it("gives every file a rect inside its folder, below the folder header", () => {
    const world = buildWorld(files, [], 800, 600);
    for (const path of files.paths) {
      expect(rectOf(world, path), path).not.toBeNull();
    }
    for (const [node, parent] of walk(world.root)) {
      expect(inside(node, parent), `${node.path} in ${parent.path}`).toBe(true);
      expect(node.y, `${node.path} under header`).toBeGreaterThanOrEqual(
        parent.y + parent.headerHeight,
      );
    }
    expect(rectOf(world, "node_modules/left-pad/index.js")).toMatchObject({ vendored: true });
  });

  it("scales files by line count and counts files per folder", () => {
    const world = buildWorld(files, [], 800, 600);
    const big = rectOf(world, "packages/contracts/src/orchestrationV2.ts")!;
    const small = rectOf(world, "packages/contracts/src/git.ts")!;
    expect(big.w * big.h).toBeGreaterThan(small.w * small.h * 4);
    const apps = world.root.kids.find((kid) => kid.path === "apps") as WorldFolder;
    expect(apps.fileCount).toBe(3);
  });

  it("stacks top-level folders in a tall panel and lays them side by side in a wide one", () => {
    const [tallFirst, tallSecond] = topLevel(buildWorld(files, [], 300, 900));
    const [wideFirst, wideSecond] = topLevel(buildWorld(files, [], 1600, 240));
    expect(tallFirst!.w).toBeCloseTo(300 * 0.96, 0);
    expect(tallSecond!.y).toBeGreaterThanOrEqual(tallFirst!.y + tallFirst!.h);
    expect(wideFirst!.h).toBeCloseTo(240 * 0.96, 0);
    expect(wideSecond!.x).toBeGreaterThanOrEqual(wideFirst!.x + wideFirst!.w);
  });

  it("is deterministic for the same input", () => {
    const rects = (world: World) =>
      [...world.files.values()].map(({ path, x, y, w, h }) => [path, x, y, w, h]);
    expect(rects(buildWorld(files, [], 640, 480))).toEqual(rects(buildWorld(files, [], 640, 480)));
  });

  it("gives a marked file the snapshot does not list a slot under its deepest listed folder", () => {
    const path = "apps/web/src/components/map/CodeMapCanvas.tsx";
    const world = buildWorld(files, [path], 800, 600);
    const slot = rectOf(world, path)!;
    expect(slot).toMatchObject({ lines: null, name: "components/map/CodeMapCanvas.tsx" });
    const src = [...walk(world.root)].find(([node]) => node.path === "apps/web/src")![0];
    expect(inside(slot, src)).toBe(true);
    expect(slot.w * slot.h).toBeGreaterThan(0);
  });
});

describe("hitTest", () => {
  it("finds the file under a point and nothing over a folder header", () => {
    const world = buildWorld(files, [], 800, 600);
    for (const path of files.paths) {
      const rect = rectOf(world, path)!;
      expect(hitTest(world, rect.x + rect.w / 2, rect.y + rect.h / 2)?.path).toBe(path);
    }
    const apps = world.root.kids.find((kid) => kid.path === "apps") as WorldFolder;
    expect(hitTest(world, apps.x + apps.w / 2, apps.y + apps.headerHeight / 2)).toBeNull();
    expect(hitTest(world, -1, -1)).toBeNull();
  });

  it("returns a file node, never a folder", () => {
    const world = buildWorld(files, [], 800, 600);
    const hit: WorldFile | null = hitTest(world, 400, 300);
    if (hit) expect(hit.kind).toBe("file");
  });
});
