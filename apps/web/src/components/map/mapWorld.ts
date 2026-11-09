export interface WorldFile {
  readonly kind: "file";
  readonly path: string;
  readonly name: string;
  readonly lines: number | null;
  readonly vendored: boolean;
  readonly value: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WorldFolder {
  readonly kind: "folder";
  readonly path: string;
  readonly name: string;
  readonly kids: WorldNode[];
  fileCount: number;
  value: number;
  x: number;
  y: number;
  w: number;
  h: number;
  headerHeight: number;
}

export type WorldNode = WorldFile | WorldFolder;

export interface WorldFiles {
  readonly paths: ReadonlyArray<string>;
  readonly lines: ReadonlyArray<number>;
  readonly vendored: ReadonlyArray<boolean>;
}

export interface World {
  readonly root: WorldFolder;
  readonly width: number;
  readonly height: number;
  readonly files: ReadonlyMap<string, WorldFile>;
}

const folderNode = (path: string, name: string): WorldFolder => ({
  kind: "folder",
  path,
  name,
  kids: [],
  fileCount: 0,
  value: 0,
  x: 0,
  y: 0,
  w: 0,
  h: 0,
  headerHeight: 0,
});

const fileNode = (
  path: string,
  name: string,
  lines: number | null,
  vendored: boolean,
  value: number,
): WorldFile => ({ kind: "file", path, name, lines, vendored, value, x: 0, y: 0, w: 0, h: 0 });

function buildTree(files: WorldFiles, extraPaths: ReadonlyArray<string>) {
  const root = folderNode("", "");
  const dirs = new Map<string, WorldFolder>([["", root]]);
  const index = new Map<string, WorldFile>();
  const folderFor = (dir: string): WorldFolder => {
    let folder = dirs.get(dir);
    if (!folder) {
      const slash = dir.lastIndexOf("/");
      folder = folderNode(dir, dir.slice(slash + 1));
      dirs.set(dir, folder);
      folderFor(slash === -1 ? "" : dir.slice(0, slash)).kids.push(folder);
    }
    return folder;
  };
  let totalLines = 0;
  for (let i = 0; i < files.paths.length; i++) {
    const path = files.paths[i]!;
    const lines = files.lines[i] ?? 0;
    totalLines += lines;
    const slash = path.lastIndexOf("/");
    const parent = folderFor(slash === -1 ? "" : path.slice(0, slash));
    const file = fileNode(
      path,
      path.slice(slash + 1),
      lines,
      files.vendored[i] ?? false,
      Math.max(lines, 1),
    );
    parent.kids.push(file);
    index.set(path, file);
  }
  const unlistedFileValue = Math.max(1, Math.round(totalLines / Math.max(files.paths.length, 1)));
  for (const path of extraPaths) {
    if (index.has(path)) continue;
    const folder = deepestListedFolder(dirs, path);
    const name = folder.path === "" ? path : path.slice(folder.path.length + 1);
    const file = fileNode(path, name, null, false, unlistedFileValue);
    folder.kids.push(file);
    index.set(path, file);
  }
  return { root, index };
}

function deepestListedFolder(dirs: ReadonlyMap<string, WorldFolder>, path: string): WorldFolder {
  let dir = path;
  for (;;) {
    const slash = dir.lastIndexOf("/");
    dir = slash === -1 ? "" : dir.slice(0, slash);
    const folder = dirs.get(dir);
    if (folder) return folder;
  }
}

function sumAndSortBySize(node: WorldFolder): void {
  let value = 0;
  let fileCount = 0;
  for (const kid of node.kids) {
    if (kid.kind === "folder") {
      sumAndSortBySize(kid);
      fileCount += kid.fileCount;
    } else {
      fileCount += 1;
    }
    value += kid.value;
  }
  node.value = value;
  node.fileCount = fileCount;
  node.kids.sort((a, b) => b.value - a.value);
}

const worst = (total: number, min: number, max: number, side: number) =>
  Math.max((side * side * max) / (total * total), (total * total) / (side * side * min));

function squarify(kids: WorldNode[], x: number, y: number, w: number, h: number): void {
  let total = 0;
  for (const kid of kids) total += kid.value;
  const scale = (w * h) / (total || 1);
  let i = 0;
  while (i < kids.length) {
    const side = Math.min(w, h);
    let j = i;
    let rowSum = 0;
    let min = Infinity;
    let max = 0;
    let best = Infinity;
    while (j < kids.length) {
      const area = kids[j]!.value * scale;
      const nextSum = rowSum + area;
      const ratio = worst(nextSum, Math.min(min, area), Math.max(max, area), side);
      if (ratio > best) break;
      best = ratio;
      rowSum = nextSum;
      min = Math.min(min, area);
      max = Math.max(max, area);
      j++;
    }
    if (w >= h) {
      const colWidth = rowSum / h;
      let cy = y;
      for (let k = i; k < j; k++) {
        const kid = kids[k]!;
        const kidHeight = (kid.value * scale) / colWidth;
        kid.x = x;
        kid.y = cy;
        kid.w = colWidth;
        kid.h = kidHeight;
        cy += kidHeight;
      }
      x += colWidth;
      w -= colWidth;
    } else {
      const rowHeight = rowSum / w;
      let cx = x;
      for (let k = i; k < j; k++) {
        const kid = kids[k]!;
        const kidWidth = (kid.value * scale) / rowHeight;
        kid.x = cx;
        kid.y = y;
        kid.w = kidWidth;
        kid.h = rowHeight;
        cx += kidWidth;
      }
      y += rowHeight;
      h -= rowHeight;
    }
    i = j;
  }
}

function layIn(node: WorldFolder): void {
  const side = Math.sqrt(Math.max(node.w * node.h, 1));
  const isRoot = node.path === "";
  const headerHeight = isRoot ? 0 : Math.min(side * 0.05, node.h * 0.25);
  const pad = isRoot ? 0 : Math.min(side * 0.012, node.w * 0.05);
  node.headerHeight = headerHeight;
  squarify(
    node.kids,
    node.x + pad,
    node.y + headerHeight,
    Math.max(0, node.w - 2 * pad),
    Math.max(0, node.h - headerHeight - pad),
  );
  for (const kid of node.kids) {
    const gap = Math.min(kid.w, kid.h) * 0.04;
    kid.x += gap / 2;
    kid.y += gap / 2;
    kid.w = Math.max(0, kid.w - gap);
    kid.h = Math.max(0, kid.h - gap);
    if (kid.kind === "folder") layIn(kid);
  }
}

export interface WorldTree {
  readonly root: WorldFolder;
  readonly files: ReadonlyMap<string, WorldFile>;
}

export function buildWorldTree(files: WorldFiles, extraPaths: ReadonlyArray<string>): WorldTree {
  const { root, index } = buildTree(files, extraPaths);
  sumAndSortBySize(root);
  return { root, files: index };
}

export function layoutWorld(tree: WorldTree, width: number, height: number): World {
  tree.root.x = 0;
  tree.root.y = 0;
  tree.root.w = width;
  tree.root.h = height;
  layIn(tree.root);
  return { root: tree.root, files: tree.files, width, height };
}

export const buildWorld = (
  files: WorldFiles,
  extraPaths: ReadonlyArray<string>,
  width: number,
  height: number,
): World => layoutWorld(buildWorldTree(files, extraPaths), width, height);

export const rectOf = (world: World, path: string): WorldFile | null =>
  world.files.get(path) ?? null;

const contains = (node: WorldNode, x: number, y: number) =>
  x >= node.x && y >= node.y && x < node.x + node.w && y < node.y + node.h;

export function hitTest(world: World, x: number, y: number): WorldFile | null {
  let node: WorldNode = world.root;
  while (node.kind === "folder") {
    const kid: WorldNode | undefined = node.kids.find((candidate) => contains(candidate, x, y));
    if (!kid) return null;
    node = kid;
  }
  return node;
}
