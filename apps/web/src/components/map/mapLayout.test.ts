import type { CodeMapFolder } from "@t3tools/client-runtime/state/code-map";
import { describe, expect, it } from "vite-plus/test";

import { layoutCodeMap, slotForPath, type MapCell } from "./mapLayout";

const file = (path: string, lines: number) => ({ path, lines });

const folders: CodeMapFolder[] = [
  {
    path: "apps",
    fileCount: 40,
    lines: 9000,
    files: [],
  },
  {
    path: "apps/web",
    fileCount: 40,
    lines: 9000,
    files: [file("apps/web/ChatView.tsx", 1600), file("apps/web/index.css", 1300)],
  },
  {
    path: "packages",
    fileCount: 3,
    lines: 5000,
    files: [],
  },
  {
    path: "packages/contracts",
    fileCount: 3,
    lines: 5000,
    files: [
      file("packages/contracts/orchestrationV2.ts", 4200),
      file("packages/contracts/git.ts", 700),
      file("packages/contracts/codeMap.ts", 100),
    ],
  },
];

const rects = (cells: ReadonlyArray<MapCell>) =>
  new Map(
    cells.map((cell) => [cell.kind === "file" ? cell.path : `more:${cell.folder}`, cell.rect]),
  );

describe("layoutCodeMap", () => {
  it("folds files too small to label into the more cell instead of a grid of blank cells", () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      file(`lib/f${String(i).padStart(3, "0")}.ts`, 200),
    );
    const layout = layoutCodeMap(
      [{ path: "lib", fileCount: 400, lines: 80_000, files: many }],
      [],
      600,
      400,
    );
    const cells = layout.regions[0]!.cells;
    const files = cells.filter((cell) => cell.kind === "file");
    expect(files.length).toBeLessThan(400);
    expect(cells.find((cell) => cell.kind === "more")).toMatchObject({ count: 400 - files.length });
    for (const cell of files) expect(cell.rect.width * cell.rect.height).toBeGreaterThan(1_200);
  });

  it("gives every top-level folder a region and folds unlisted files into one more cell", () => {
    const layout = layoutCodeMap(folders, [], 600, 400);
    expect(layout.regions.map((region) => region.label).sort()).toEqual(["apps", "packages"]);
    const apps = layout.regions.find((region) => region.path === "apps")!;
    expect(apps.cells.filter((cell) => cell.kind === "file")).toHaveLength(2);
    expect(apps.cells.find((cell) => cell.kind === "more")).toMatchObject({ count: 38 });
    for (const region of layout.regions) {
      for (const cell of region.cells) {
        expect(cell.rect.x).toBeGreaterThanOrEqual(region.rect.x);
        expect(cell.rect.y).toBeGreaterThanOrEqual(region.rect.y);
        expect(cell.rect.x + cell.rect.width).toBeLessThanOrEqual(
          region.rect.x + region.rect.width + 0.01,
        );
        expect(cell.rect.y + cell.rect.height).toBeLessThanOrEqual(
          region.rect.y + region.rect.height + 0.01,
        );
      }
    }
  });

  it("keeps every other cell in place when a mark lands on a listed file", () => {
    const before = layoutCodeMap(folders, [], 600, 400);
    const after = layoutCodeMap(folders, ["packages/contracts/git.ts"], 600, 400);
    expect([...rects(after.regions.flatMap((region) => region.cells))]).toEqual([
      ...rects(before.regions.flatMap((region) => region.cells)),
    ]);
  });

  it("carves a new file's slot out of its folder's more cell and leaves the shown files alone", () => {
    const before = layoutCodeMap(folders, [], 600, 400);
    const after = layoutCodeMap(folders, ["apps/web/map/CodeMapPanel.tsx"], 600, 400);
    const shown = (layout: typeof before) =>
      rects(
        layout.regions
          .flatMap((region) => region.cells)
          .filter((cell) => cell.kind === "file" && cell.lines !== null),
      );
    expect([...shown(after)]).toEqual([...shown(before)]);
    const added = after.cellByPath.get("apps/web/map/CodeMapPanel.tsx");
    expect(added).toMatchObject({ kind: "file", name: "CodeMapPanel.tsx", lines: null });
    const more = before.moreCellByFolder.get("apps")!.rect;
    expect(added!.rect.x).toBeGreaterThanOrEqual(more.x - 0.01);
    expect(added!.rect.y).toBeGreaterThanOrEqual(more.y - 0.01);
    expect(added!.rect.x + added!.rect.width).toBeLessThanOrEqual(more.x + more.width + 0.01);
    expect(added!.rect.y + added!.rect.height).toBeLessThanOrEqual(more.y + more.height + 0.01);
  });

  it("routes a path without a cell to its folder's more cell", () => {
    const layout = layoutCodeMap(folders, [], 600, 400);
    expect(slotForPath(layout, "apps/web/hidden.ts")).toBe(layout.moreCellByFolder.get("apps"));
    expect(slotForPath(layout, "packages/contracts/git.ts")).toBe(
      layout.cellByPath.get("packages/contracts/git.ts"),
    );
    expect(slotForPath(layout, "docs/guide.md")).toBeNull();
  });

  it("folds small folders into one region unless a mark keeps one of them", () => {
    const many: CodeMapFolder[] = Array.from({ length: 12 }, (_, i) => ({
      path: `pkg${i}`,
      fileCount: 1,
      lines: 1000 * (i + 1),
      files: [file(`pkg${i}/index.ts`, 1000 * (i + 1))],
    }));
    const moreFolders = (layout: ReturnType<typeof layoutCodeMap>) =>
      layout.regions.find((region) => region.label.endsWith("more folders"));
    const folded = layoutCodeMap(many, [], 600, 400);
    expect(folded.regions).toHaveLength(9);
    expect(moreFolders(folded)).toMatchObject({ label: "4 more folders", fileCount: 4 });
    expect(slotForPath(folded, "pkg0/index.ts")).toBe(moreFolders(folded)!.cells[0]);

    const kept = layoutCodeMap(many, ["pkg0/index.ts"], 600, 400);
    expect(kept.regions.some((region) => region.path === "pkg0")).toBe(true);
    expect(moreFolders(kept)).toMatchObject({ label: "3 more folders" });
  });
});
