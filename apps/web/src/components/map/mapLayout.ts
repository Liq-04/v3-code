import type { CodeMapFolder } from "@t3tools/client-runtime/state/code-map";

export interface MapRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type MapCell =
  | {
      readonly kind: "file";
      readonly path: string;
      readonly name: string;
      readonly lines: number | null;
      readonly rect: MapRect;
    }
  | {
      readonly kind: "more";
      /** Null inside the folded "more folders" region, which stands for several folders. */
      readonly folder: string | null;
      readonly count: number;
      readonly rect: MapRect;
    };

export interface MapRegion {
  /** Top-level folder, the empty string for the repo root, or null for the folded "more folders" region. */
  readonly path: string | null;
  readonly label: string;
  readonly fileCount: number;
  readonly rect: MapRect;
  readonly cells: ReadonlyArray<MapCell>;
}

export interface MapLayout {
  readonly regions: ReadonlyArray<MapRegion>;
  readonly cellByPath: ReadonlyMap<string, MapCell>;
  readonly moreCellByFolder: ReadonlyMap<string, MapCell>;
}

const MAP_PAD = 4;
const REGION_GAP = 2;
const REGION_HEADER = 17;
const REGION_INSET = 3;
const CELL_GAP = 2;
// About the smallest cell that still fits a file name and its line count.
const MIN_FILE_AREA = 2_000;
const MAX_REGIONS = 8;
const MIN_WEIGHT_LINES = 160;

interface Item {
  readonly value: number;
  rect: MapRect;
}

const weight = (lines: number) => Math.sqrt(Math.max(lines, MIN_WEIGHT_LINES));

function topLevelOf(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function worst(row: ReadonlyArray<number>, side: number): number {
  let sum = 0;
  let max = 0;
  let min = Infinity;
  for (const area of row) {
    sum += area;
    max = Math.max(max, area);
    min = Math.min(min, area);
  }
  return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
}

/** Bruls, Huizing and van Wijk's squarified treemap; items arrive sorted by value, largest first. */
function squarify<T extends Item>(items: ReadonlyArray<T>, bounds: MapRect): void {
  let { x, y, width, height } = bounds;
  if (items.length === 0) return;
  if (width <= 0 || height <= 0) {
    for (const item of items) item.rect = { x, y, width: 0, height: 0 };
    return;
  }
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const areas = items.map((item) => (item.value / total) * width * height);
  let start = 0;
  while (start < items.length) {
    const side = Math.min(width, height);
    let end = start + 1;
    while (
      end < items.length &&
      worst(areas.slice(start, end + 1), side) <= worst(areas.slice(start, end), side)
    ) {
      end++;
    }
    const rowArea = areas.slice(start, end).reduce((sum, area) => sum + area, 0);
    if (width >= height) {
      const rowWidth = rowArea / height;
      let cursor = y;
      for (let i = start; i < end; i++) {
        const cellHeight = areas[i]! / rowWidth;
        items[i]!.rect = { x, y: cursor, width: rowWidth, height: cellHeight };
        cursor += cellHeight;
      }
      x += rowWidth;
      width -= rowWidth;
    } else {
      const rowHeight = rowArea / width;
      let cursor = x;
      for (let i = start; i < end; i++) {
        const cellWidth = areas[i]! / rowHeight;
        items[i]!.rect = { x: cursor, y, width: cellWidth, height: rowHeight };
        cursor += cellWidth;
      }
      y += rowHeight;
      height -= rowHeight;
    }
    start = end;
  }
}

function inset(rect: MapRect, by: number): MapRect {
  return {
    x: rect.x + by,
    y: rect.y + by,
    width: Math.max(0, rect.width - 2 * by),
    height: Math.max(0, rect.height - 2 * by),
  };
}

interface RegionSource {
  readonly path: string | null;
  readonly label: string;
  readonly fileCount: number;
  readonly lines: number;
  readonly files: ReadonlyArray<{ readonly path: string; readonly lines: number }>;
  readonly folders: ReadonlyArray<string>;
}

type TopLevelRegion = RegionSource & { readonly path: string };

const EMPTY_RECT: MapRect = { x: 0, y: 0, width: 0, height: 0 };
const byLines = (
  a: { readonly path: string; readonly lines: number },
  b: { readonly path: string; readonly lines: number },
) => b.lines - a.lines || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function collectRegions(
  folders: ReadonlyArray<CodeMapFolder>,
  marked: ReadonlySet<string>,
): TopLevelRegion[] {
  const regions = new Map<
    string,
    TopLevelRegion & { files: Array<CodeMapFolder["files"][number]> }
  >();
  for (const folder of folders) {
    const top = folder.path.includes("/") ? topLevelOf(folder.path) : folder.path;
    let region = regions.get(top);
    if (!region) {
      region = { path: top, label: top || "/", fileCount: 0, lines: 0, files: [], folders: [top] };
      regions.set(top, region);
    }
    if (folder.path === top) {
      region = { ...region, fileCount: folder.fileCount, lines: folder.lines };
      regions.set(top, region);
    }
    region.files.push(...folder.files);
  }
  for (const path of marked) {
    const top = topLevelOf(path);
    if (!regions.has(top)) {
      regions.set(top, {
        path: top,
        label: top || "/",
        fileCount: 0,
        lines: 0,
        files: [],
        folders: [top],
      });
    }
  }
  return [...regions.values()];
}

function foldSmallRegions(
  regions: ReadonlyArray<TopLevelRegion>,
  marked: ReadonlySet<string>,
): RegionSource[] {
  const markedTops = new Set([...marked].map(topLevelOf));
  const sorted = regions
    .slice()
    .sort((a, b) => weight(b.lines) - weight(a.lines) || (a.path < b.path ? -1 : 1));
  const kept: RegionSource[] = [];
  const folded: TopLevelRegion[] = [];
  for (const region of sorted) {
    if (kept.length < MAX_REGIONS || markedTops.has(region.path)) kept.push(region);
    else folded.push(region);
  }
  if (folded.length === 1) kept.push(folded[0]!);
  else if (folded.length > 1) {
    kept.push({
      path: null,
      label: `${folded.length} more folders`,
      fileCount: folded.reduce((sum, region) => sum + region.fileCount, 0),
      lines: folded.reduce((sum, region) => sum + region.lines, 0),
      files: [],
      folders: folded.map((region) => region.path),
    });
  }
  return kept;
}

type FileItem = Item & Extract<MapCell, { kind: "file" }>;
type MoreItem = Item & {
  readonly kind: "more";
  readonly folder: string | null;
  readonly count: number;
};
type CellItem = FileItem | MoreItem;

const fileItem = (path: string, lines: number | null): FileItem => ({
  kind: "file",
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  lines,
  value: weight(lines ?? 0),
  rect: EMPTY_RECT,
});

/** How many of the largest files fit at a readable size, with the rest folded into "+N more". */
function labelledCount(
  region: RegionSource,
  listed: ReadonlyArray<{ readonly lines: number }>,
  area: number,
): number {
  let count = 0;
  let shownWeight = 0;
  let shownLines = 0;
  for (const file of listed) {
    shownWeight += weight(file.lines);
    shownLines += file.lines;
    const moreWeight =
      region.fileCount > count + 1 ? weight(Math.max(region.lines - shownLines, 0)) : 0;
    if ((area * weight(file.lines)) / (shownWeight + moreWeight) < MIN_FILE_AREA) break;
    count++;
  }
  return count;
}

/**
 * Cells for one region. Listed files fill the budget largest first, so a mark on one of them
 * changes nothing. Every other marked path takes a slot carved out of the "+N more" cell, so
 * the shown files keep their rects when a mark arrives.
 */
function regionCells(
  region: RegionSource,
  marked: ReadonlySet<string>,
  bounds: MapRect,
): CellItem[] {
  const listed = region.files.slice().sort(byLines);
  const shown = listed.slice(0, labelledCount(region, listed, bounds.width * bounds.height));
  const shownPaths = new Set(shown.map((file) => file.path));
  const linesByPath = new Map(listed.map((file) => [file.path, file.lines]));
  const extras = [...marked]
    .filter((path) => region.folders.includes(topLevelOf(path)) && !shownPaths.has(path))
    .sort()
    .map((path) => fileItem(path, linesByPath.get(path) ?? null));
  const remaining = region.fileCount - shown.length;
  const shownLines = shown.reduce((sum, file) => sum + file.lines, 0);

  const items: CellItem[] = shown.map((file) => fileItem(file.path, file.lines));
  const slot: MoreItem | null =
    remaining > 0 || extras.length > 0
      ? {
          kind: "more",
          folder: region.path,
          count: remaining,
          value: weight(Math.max(region.lines - shownLines, 0)),
          rect: EMPTY_RECT,
        }
      : null;
  if (slot) items.push(slot);
  items.sort((a, b) => b.value - a.value);
  squarify(items, bounds);

  if (!slot || extras.length === 0) return items;
  const residual: MoreItem | null =
    remaining > 0 ? { ...slot, value: extras.reduce((sum, item) => sum + item.value, 0) } : null;
  const inner: CellItem[] = residual ? [...extras, residual] : extras;
  inner.sort((a, b) => b.value - a.value);
  squarify(inner, slot.rect);
  return [...items.filter((item) => item !== slot), ...inner];
}

export function layoutCodeMap(
  folders: ReadonlyArray<CodeMapFolder>,
  markedPaths: ReadonlyArray<string>,
  width: number,
  height: number,
): MapLayout {
  const marked = new Set(markedPaths);
  const sources = foldSmallRegions(collectRegions(folders, marked), marked);
  const regionItems = sources.map((source) => ({
    source,
    value: weight(source.lines) + Math.sqrt(source.fileCount),
    rect: EMPTY_RECT,
  }));
  regionItems.sort((a, b) => b.value - a.value);
  squarify(regionItems, {
    x: MAP_PAD,
    y: MAP_PAD,
    width: Math.max(0, width - 2 * MAP_PAD),
    height: Math.max(0, height - 2 * MAP_PAD),
  });

  const cellByPath = new Map<string, MapCell>();
  const moreCellByFolder = new Map<string, MapCell>();
  const regions = regionItems.map(({ source, rect: outer }) => {
    const rect = inset(outer, REGION_GAP);
    const body: MapRect = {
      x: rect.x + REGION_INSET,
      y: rect.y + REGION_HEADER,
      width: Math.max(0, rect.width - 2 * REGION_INSET),
      height: Math.max(0, rect.height - REGION_HEADER - REGION_INSET),
    };
    const cells = regionCells(source, marked, body).map((item): MapCell => {
      const cellRect = {
        x: item.rect.x + CELL_GAP / 2,
        y: item.rect.y + CELL_GAP / 2,
        width: Math.max(0, item.rect.width - CELL_GAP),
        height: Math.max(0, item.rect.height - CELL_GAP),
      };
      if (item.kind === "file") {
        const cell: MapCell = {
          kind: "file",
          path: item.path,
          name: item.name,
          lines: item.lines,
          rect: cellRect,
        };
        cellByPath.set(item.path, cell);
        return cell;
      }
      const cell: MapCell = {
        kind: "more",
        folder: item.folder,
        count: item.count,
        rect: cellRect,
      };
      for (const folder of source.folders) moreCellByFolder.set(folder, cell);
      return cell;
    });
    return { path: source.path, label: source.label, fileCount: source.fileCount, rect, cells };
  });
  return { regions, cellByPath, moreCellByFolder };
}

export function slotForPath(layout: MapLayout, path: string): MapCell | null {
  return layout.cellByPath.get(path) ?? layout.moreCellByFolder.get(topLevelOf(path)) ?? null;
}
