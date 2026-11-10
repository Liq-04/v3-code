import * as Schema from "effect/Schema";
import { threadColor, type CodeMapPathMark } from "@t3tools/client-runtime/state/code-map";
import type { ThreadId } from "@t3tools/contracts";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { subscribeRenderedAppearance } from "~/hooks/useTheme";
import { projectIconColorValue } from "~/projectIconColors";

import {
  fitCamera,
  panBy,
  toWorld,
  zoomAt,
  type Camera,
  type CameraStore,
  type Size,
} from "./mapCamera";
import { hitTest, type World, type WorldFile, type WorldFolder, type WorldNode } from "./mapWorld";

export const MapScope = Schema.Literals(["thread", "all"]);
export type MapScope = typeof MapScope.Type;

export interface MarkView {
  readonly path: string;
  readonly kind: "overlap" | "mine" | "other";
  readonly strong: boolean;
  readonly isNew: boolean;
  readonly threadId: ThreadId;
  readonly label: string;
}

export function markView(
  mark: CodeMapPathMark,
  threadId: ThreadId,
  scope: MapScope,
  finished: ReadonlySet<ThreadId>,
  titleOf: (threadId: ThreadId) => string,
): MarkView {
  const mine = mark.sets.some((set) => set.threadIds.includes(threadId));
  const overlap = mark.sets.length > 1;
  const allFinished = mark.sets.every((set) => set.threadIds.every((id) => finished.has(id)));
  return {
    path: mark.path,
    kind: overlap ? "overlap" : mine ? "mine" : "other",
    strong: (scope === "all" || mine || overlap) && !allFinished,
    isNew: mark.isNew,
    threadId: mark.sets[0]!.threadIds[0]!,
    label: `${mark.path}, changed in ${mark.sets
      .flatMap((set) => set.threadIds)
      .map(titleOf)
      .join(", ")}`,
  };
}

export interface ReadView {
  readonly path: string;
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly strong: boolean;
}

interface Inputs {
  readonly world: World | null;
  readonly size: Size;
  readonly reads: ReadonlyArray<ReadView>;
  readonly marks: ReadonlyArray<MarkView>;
  readonly standing: ReadonlyArray<{ readonly path: string; readonly threadId: ThreadId }>;
  readonly hoveredPath: string | null;
  readonly selectedPath: string | null;
}

const TOKENS = [
  "muted",
  "card",
  "border",
  "foreground",
  "muted-foreground",
  "warning",
  "primary",
] as const;
type Token = (typeof TOKENS)[number];
const MIN_MARK_PX = 7;
const LOD_BLOCK_PX = 6;
const ZOOM_PER_WHEEL_PX = 0.0015;

/** Canvas fills need absolute colours, so tokens resolve through the element's computed `color`. */
function createPalette(element: HTMLElement) {
  const cache = new Map<string, string>();
  let fontFamily = "ui-sans-serif, system-ui, sans-serif";
  const resolve = (value: string) => {
    let color = cache.get(value);
    if (color === undefined) {
      element.style.color = value;
      color = getComputedStyle(element).color;
      element.style.color = "";
      cache.set(value, color);
    }
    return color;
  };
  return {
    token: (name: Token) => resolve(`var(--${name})`),
    thread: (threadId: ThreadId) => resolve(projectIconColorValue(threadColor(threadId))),
    get fontFamily() {
      return fontFamily;
    },
    refresh: () => {
      cache.clear();
      fontFamily = getComputedStyle(element).fontFamily || fontFamily;
    },
  };
}

type Palette = ReturnType<typeof createPalette>;

function createPainter() {
  let canvas: HTMLCanvasElement | null = null;
  let store: CameraStore | null = null;
  let palette: Palette | null = null;
  let inputs: Inputs | null = null;
  let frame = 0;
  const charWidths = new Map<string, number>();

  const requestDraw = () => {
    if (frame === 0 && canvas) frame = requestAnimationFrame(draw);
  };

  const draw = (now: number) => {
    frame = 0;
    if (!canvas || !store || !palette || !inputs) return;
    if (store.step(now)) requestDraw();
    const camera = store.get();
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    const { width, height } = inputs.size;
    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = palette.token("muted");
    ctx.fillRect(0, 0, width, height);
    if (!inputs.world) return;
    const scene = { ctx, palette, camera, width, height, charWidths };
    drawChildren(scene, inputs.world.root);
    for (const read of inputs.reads) drawRead(scene, inputs.world, read);
    for (const mark of inputs.marks) drawMark(scene, inputs.world, mark);
    for (const { path, threadId } of inputs.standing) {
      outline(scene, inputs.world, path, palette.thread(threadId), 2, 1);
    }
    if (inputs.selectedPath) {
      outline(scene, inputs.world, inputs.selectedPath, palette.token("primary"), 2, 1);
    }
    if (inputs.hoveredPath && inputs.hoveredPath !== inputs.selectedPath) {
      outline(scene, inputs.world, inputs.hoveredPath, palette.token("primary"), 2, 1);
    }
  };

  return {
    attach(element: HTMLCanvasElement | null, cameraStore: CameraStore | null) {
      canvas = element;
      store = cameraStore;
      palette = element ? createPalette(element) : null;
      palette?.refresh();
      if (!element && frame !== 0) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    },
    setInputs(next: Inputs) {
      inputs = next;
    },
    refreshColors() {
      palette?.refresh();
      charWidths.clear();
      requestDraw();
    },
    requestDraw,
  };
}

interface Scene {
  readonly ctx: CanvasRenderingContext2D;
  readonly palette: Palette;
  readonly camera: Camera;
  readonly width: number;
  readonly height: number;
  readonly charWidths: Map<string, number>;
}

function label(
  scene: Scene,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  color: string,
  size: number,
  weight = 400,
) {
  const { ctx, palette, charWidths } = scene;
  const font = `${weight} ${size}px ${palette.fontFamily}`;
  ctx.font = font;
  let charWidth = charWidths.get(font);
  if (charWidth === undefined) {
    charWidth = ctx.measureText("abcdefghijklmnopqrstuvwxyz0123456789-_.").width / 39;
    charWidths.set(font, charWidth);
  }
  const fit = Math.floor(maxWidth / charWidth);
  if (fit < 2) return;
  ctx.fillStyle = color;
  ctx.fillText(text.length > fit ? `${text.slice(0, fit - 1)}…` : text, x, y);
}

interface ScreenRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

function project(scene: Scene, node: WorldNode, out: ScreenRect): boolean {
  const { camera } = scene;
  out.sx = node.x * camera.scale + camera.x;
  out.sy = node.y * camera.scale + camera.y;
  out.sw = node.w * camera.scale;
  out.sh = node.h * camera.scale;
  return !(
    out.sx > scene.width ||
    out.sy > scene.height ||
    out.sx + out.sw < 0 ||
    out.sy + out.sh < 0 ||
    out.sw < 0.4 ||
    out.sh < 0.4
  );
}

const isBlock = (r: ScreenRect) => r.sw < LOD_BLOCK_PX || r.sh < LOD_BLOCK_PX;

function drawChildren(scene: Scene, node: WorldFolder) {
  const { ctx, palette } = scene;
  const r: ScreenRect = { sx: 0, sy: 0, sw: 0, sh: 0 };
  const kids = node.kids;

  ctx.beginPath();
  let vendored = 0;
  let blocks = 0;
  for (const kid of kids) {
    if (!project(scene, kid, r)) continue;
    if (kid.kind === "file") {
      if (kid.vendored) vendored++;
      else ctx.rect(r.sx, r.sy, r.sw, r.sh);
    } else if (isBlock(r)) {
      blocks++;
    }
  }
  ctx.fillStyle = palette.token("card");
  ctx.fill();

  if (vendored > 0) {
    ctx.beginPath();
    for (const kid of kids) {
      if (kid.kind === "file" && kid.vendored && project(scene, kid, r)) {
        ctx.rect(r.sx, r.sy, r.sw, r.sh);
      }
    }
    ctx.globalAlpha = 0.45;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  if (blocks > 0) {
    ctx.beginPath();
    for (const kid of kids) {
      if (kid.kind === "folder" && project(scene, kid, r) && isBlock(r)) {
        ctx.rect(r.sx, r.sy, r.sw, r.sh);
      }
    }
    ctx.globalAlpha = 0.55;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = palette.token("border");
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  ctx.beginPath();
  for (const kid of kids) {
    if (kid.kind === "file" && project(scene, kid, r) && r.sw > 3 && r.sh > 3) {
      ctx.rect(r.sx + 0.25, r.sy + 0.25, r.sw - 0.5, r.sh - 0.5);
    }
  }
  ctx.strokeStyle = palette.token("border");
  ctx.lineWidth = 0.5;
  ctx.stroke();

  for (const kid of kids) {
    if (!project(scene, kid, r)) continue;
    if (kid.kind === "file") {
      if (r.sw > 46 && r.sh > 15) drawFileLabels(scene, kid, r);
    } else if (!isBlock(r)) {
      drawFolder(scene, kid, r);
    }
  }
}

function drawFolder(scene: Scene, node: WorldFolder, r: ScreenRect) {
  const { ctx, palette } = scene;
  ctx.fillStyle = palette.token("card");
  ctx.globalAlpha = 0.55;
  ctx.fillRect(r.sx, r.sy, r.sw, r.sh);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = palette.token("border");
  ctx.lineWidth = 1;
  ctx.strokeRect(r.sx + 0.5, r.sy + 0.5, r.sw - 1, r.sh - 1);
  const headerHeight = node.headerHeight * scene.camera.scale;
  if (headerHeight > 9 && r.sw > 40) {
    label(
      scene,
      `${node.name}  ·  ${node.fileCount.toLocaleString()} files`,
      r.sx + 5,
      r.sy + Math.min(headerHeight - 3, 13),
      r.sw - 10,
      palette.token("foreground"),
      Math.min(12, headerHeight - 2),
      600,
    );
  }
  drawChildren(scene, node);
}

function drawFileLabels(scene: Scene, file: WorldFile, r: ScreenRect) {
  const { palette } = scene;
  const color = palette.token(file.vendored ? "muted-foreground" : "foreground");
  label(scene, file.name, r.sx + 4, r.sy + 11, r.sw - 8, color, 10);
  if (r.sh > 28 && file.lines !== null) {
    const text = `${file.lines.toLocaleString()} lines`;
    label(scene, text, r.sx + 4, r.sy + 23, r.sw - 8, palette.token("muted-foreground"), 9);
  }
}

function screenRectAtLeast(scene: Scene, file: WorldFile, minPx: number) {
  const { camera } = scene;
  let sx = file.x * camera.scale + camera.x;
  let sy = file.y * camera.scale + camera.y;
  let sw = file.w * camera.scale;
  let sh = file.h * camera.scale;
  if (sw < minPx) {
    sx -= (minPx - sw) / 2;
    sw = minPx;
  }
  if (sh < minPx) {
    sy -= (minPx - sh) / 2;
    sh = minPx;
  }
  return { sx, sy, sw, sh };
}

const onScreen = (scene: Scene, r: { sx: number; sy: number; sw: number; sh: number }) =>
  r.sx <= scene.width && r.sy <= scene.height && r.sx + r.sw >= 0 && r.sy + r.sh >= 0;

/** An outline and light wash in each reader's colour, split into bands when several threads read it. */
function drawRead(scene: Scene, world: World, read: ReadView) {
  const file = world.files.get(read.path);
  if (!file) return;
  const r = screenRectAtLeast(scene, file, MIN_MARK_PX);
  if (!onScreen(scene, r)) return;
  const { ctx, palette } = scene;
  const band = r.sw / read.threadIds.length;
  read.threadIds.forEach((threadId, index) => {
    const color = palette.thread(threadId);
    const x = r.sx + index * band;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.globalAlpha = read.strong ? 0.15 : 0.06;
    ctx.fillRect(x, r.sy, band, r.sh);
    ctx.globalAlpha = read.strong ? 0.9 : 0.4;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, r.sy + 0.5, band - 1, r.sh - 1);
  });
  ctx.globalAlpha = 1;
}

function drawMark(scene: Scene, world: World, mark: MarkView) {
  const file = world.files.get(mark.path);
  if (!file) return;
  const r = screenRectAtLeast(scene, file, MIN_MARK_PX);
  if (!onScreen(scene, r)) return;
  const { ctx, palette } = scene;
  const color = mark.kind === "overlap" ? palette.token("warning") : palette.thread(mark.threadId);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  if (mark.isNew) {
    ctx.globalAlpha = mark.strong ? 1 : 0.5;
    ctx.setLineDash([3, 2]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(r.sx + 0.75, r.sy + 0.75, r.sw - 1.5, r.sh - 1.5);
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    return;
  }
  ctx.globalAlpha = mark.strong ? 0.35 : 0.12;
  ctx.fillRect(r.sx, r.sy, r.sw, r.sh);
  if (mark.kind === "overlap") {
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.sx, r.sy, r.sw, r.sh);
    ctx.clip();
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let d = -r.sh; d < r.sw; d += 6) {
      ctx.moveTo(r.sx + d, r.sy + r.sh);
      ctx.lineTo(r.sx + d + r.sh, r.sy);
    }
    ctx.stroke();
    ctx.restore();
  }
  ctx.globalAlpha = mark.strong ? 1 : 0.5;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(r.sx + 0.75, r.sy + 0.75, r.sw - 1.5, r.sh - 1.5);
  ctx.globalAlpha = 1;
}

function outline(
  scene: Scene,
  world: World,
  path: string,
  color: string,
  lineWidth: number,
  inset: number,
) {
  const file = world.files.get(path);
  if (!file) return;
  const r = screenRectAtLeast(scene, file, MIN_MARK_PX);
  if (!onScreen(scene, r)) return;
  const { ctx } = scene;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.strokeRect(r.sx + inset, r.sy + inset, r.sw - 2 * inset, r.sh - 2 * inset);
}

const DRAG_THRESHOLD_PX = 3;

interface Drag {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly camera: Camera;
  moved: boolean;
}

export interface CodeMapCanvasProps extends Inputs {
  readonly camera: CameraStore;
  readonly onOpen: (path: string) => void;
  readonly onHover: (path: string | null) => void;
  readonly onManualPanZoom: () => void;
}

export function CodeMapCanvas(props: CodeMapCanvasProps) {
  const {
    world,
    size,
    reads,
    marks,
    standing,
    hoveredPath,
    selectedPath,
    camera,
    onHover,
    onOpen,
    onManualPanZoom,
  } = props;
  const [painter] = useState(createPainter);
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);
  const [element, setElement] = useState<HTMLCanvasElement | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the canvas is painted imperatively from these inputs
  useEffect(() => {
    painter.setInputs({ world, size, reads, marks, standing, hoveredPath, selectedPath });
    painter.requestDraw();
  }, [painter, world, size, reads, marks, standing, hoveredPath, selectedPath]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes the painter to the camera store and the theme
  useEffect(() => {
    painter.attach(element, camera);
    if (!element) return;
    painter.requestDraw();
    const unsubscribeCamera = camera.subscribe(painter.requestDraw);
    const unsubscribeTheme = subscribeRenderedAppearance(() => painter.refreshColors());
    return () => {
      unsubscribeCamera();
      unsubscribeTheme();
      painter.attach(null, null);
    };
  }, [painter, element, camera]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- React registers wheel listeners as passive, and zooming must prevent the page from scrolling
  useEffect(() => {
    if (!element || !world) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      onManualPanZoom();
      const box = element.getBoundingClientRect();
      const point = { x: event.clientX - box.left, y: event.clientY - box.top };
      const minZoom = fitCamera(world, size).scale * 0.8;
      camera.jumpTo(
        zoomAt(camera.get(), point, Math.exp(-event.deltaY * ZOOM_PER_WHEEL_PX), minZoom),
      );
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [element, world, size, camera, onManualPanZoom]);

  const fileAt = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!world) return null;
    const box = event.currentTarget.getBoundingClientRect();
    const point = toWorld(camera.get(), event.clientX - box.left, event.clientY - box.top);
    return hitTest(world, point.x, point.y);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      camera: camera.get(),
      moved: false,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) {
      onHover(fileAt(event)?.path ?? null);
      return;
    }
    const dx = event.clientX - active.startX;
    const dy = event.clientY - active.startY;
    if (!active.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      active.moved = true;
      setDragging(true);
      onManualPanZoom();
      onHover(null);
    }
    camera.jumpTo(panBy(active.camera, dx, dy));
  };

  const endDrag = () => {
    drag.current = null;
    setDragging(false);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    endDrag();
    if (active.moved) return;
    const file = fileAt(event);
    if (file) onOpen(file.path);
  };

  return (
    <canvas
      ref={setElement}
      data-testid="code-map-canvas"
      data-dragging={dragging ? "" : undefined}
      className="absolute inset-0 size-full cursor-grab touch-none data-dragging:cursor-grabbing"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={endDrag}
      onPointerLeave={() => onHover(null)}
    >
      {marks.map((mark) => (
        <button
          key={mark.path}
          type="button"
          data-path={mark.path}
          data-marked={mark.kind}
          data-strength={mark.strong ? "strong" : "faint"}
          data-focus={
            mark.path === hoveredPath
              ? "hovered"
              : mark.path === selectedPath
                ? "selected"
                : undefined
          }
          aria-label={mark.label}
          onClick={() => onOpen(mark.path)}
        />
      ))}
    </canvas>
  );
}
