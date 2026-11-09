import type { ThreadId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import type { CameraStore } from "./mapCamera";
import type { World } from "./mapWorld";

export interface SpriteInput {
  readonly threadId: ThreadId;
  readonly path: string | null;
  readonly verb: string | null;
  readonly kind: "agent" | "subagent";
  readonly parentThreadId: ThreadId | null;
  readonly color: string;
  readonly quiet: boolean;
  readonly title: string;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Walk {
  readonly from: Point;
  readonly to: Point;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly onArrive: (() => void) | null;
}

interface Walker {
  readonly threadId: ThreadId;
  readonly el: HTMLDivElement;
  readonly body: HTMLDivElement;
  input: SpriteInput;
  worldPos: Point | null;
  targetPath: string | null;
  walk: Walk | null;
  leaving: boolean;
}

const MAX_WALK_MS = 1600;
const WALK_BASE_MS = 250;
const WALK_MS_PER_PX = 2.2;
const FADE_MS = 320;

const easeInOutQuad = (u: number) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);

const reducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const AGENT_CLASS =
  "flex origin-bottom items-center justify-center rounded-t-md rounded-b-sm shadow-md h-[15px] w-[18px] -mt-[15px] -ml-[9px] gap-0.75";
const SUBAGENT_CLASS =
  "flex origin-bottom items-center justify-center rounded-t-sm rounded-b-xs shadow-sm h-[9px] w-[11px] -mt-[9px] -ml-[5px] gap-0.5 opacity-90";
const EYE_CLASS = "rounded-xs bg-white transition-transform duration-200";

function createElement(input: SpriteInput): { el: HTMLDivElement; body: HTMLDivElement } {
  const el = document.createElement("div");
  el.dataset.testid = "code-map-sprite";
  el.dataset.threadId = input.threadId;
  el.dataset.kind = input.kind;
  el.className = "pointer-events-none absolute top-0 left-0 z-10 will-change-transform";
  const body = document.createElement("div");
  body.className = input.kind === "agent" ? AGENT_CLASS : SUBAGENT_CLASS;
  for (let i = 0; i < 2; i++) {
    const eye = document.createElement("i");
    eye.className = `${EYE_CLASS} ${input.kind === "agent" ? "h-1 w-[3px]" : "size-0.5"}`;
    body.appendChild(eye);
  }
  el.appendChild(body);
  return { el, body };
}

function createSpriteLayer() {
  let container: HTMLElement | null = null;
  let camera: CameraStore | null = null;
  let world: World | null = null;
  const walkers = new Map<ThreadId, Walker>();
  const fades = new Set<ReturnType<typeof setTimeout>>();
  let frame = 0;

  const project = (walker: Walker) => {
    walker.el.style.visibility = walker.worldPos ? "" : "hidden";
    if (!walker.worldPos || !camera) return;
    const { x, y, scale } = camera.get();
    const { worldPos } = walker;
    walker.el.style.transform = `translate(${worldPos.x * scale + x}px, ${worldPos.y * scale + y}px)`;
  };

  const anchor = (walker: Walker, path: string): Point | null => {
    const file = world?.files.get(path);
    if (!file || !camera) return null;
    let lane = 0;
    for (const other of walkers.values()) {
      if (other !== walker && other.targetPath === path && !other.leaving) lane++;
    }
    const { scale } = camera.get();
    const step = walker.input.kind === "agent" ? 10 : 6;
    return {
      x: file.x + file.w / 2 + (lane * step) / scale,
      y: file.y + Math.min(file.h * 0.35, 12 / scale),
    };
  };

  const tick = () => {
    if (frame === 0) frame = requestAnimationFrame(step);
  };

  const step = (now: number) => {
    frame = 0;
    let moving = false;
    for (const walker of walkers.values()) {
      const walk = walker.walk;
      if (!walk) continue;
      const u = Math.min(1, (now - walk.startedAt) / walk.durationMs);
      const e = easeInOutQuad(u);
      walker.worldPos = {
        x: walk.from.x + (walk.to.x - walk.from.x) * e,
        y: walk.from.y + (walk.to.y - walk.from.y) * e,
      };
      project(walker);
      if (u < 1) moving = true;
      else arrive(walker);
    }
    if (moving) tick();
  };

  const arrive = (walker: Walker) => {
    const onArrive = walker.walk?.onArrive ?? null;
    walker.walk = null;
    walker.body.classList.remove("code-map-walk", "code-map-land");
    void walker.body.offsetWidth;
    walker.body.classList.add("code-map-land");
    onArrive?.();
  };

  const say = (walker: Walker, text: string) => {
    walker.el.querySelector("[data-testid=code-map-say]")?.remove();
    const bubble = document.createElement("div");
    bubble.dataset.testid = "code-map-say";
    bubble.className = `code-map-say absolute whitespace-nowrap rounded-sm border border-border bg-popover text-popover-foreground ${
      walker.input.kind === "agent"
        ? "top-[-16px] left-[12px] px-1.5 py-px text-3xs"
        : "top-[-12px] left-[8px] px-1 text-4xs"
    }`;
    bubble.textContent = text;
    walker.el.appendChild(bubble);
  };

  const walkTo = (walker: Walker, to: Point, onArrive: (() => void) | null) => {
    if (!camera) return;
    const from = walker.worldPos ?? to;
    walker.worldPos = from;
    const { scale } = camera.get();
    const dx = (to.x - from.x) * scale;
    const dy = (to.y - from.y) * scale;
    const distance = Math.hypot(dx, dy);
    const durationMs = reducedMotion()
      ? 0
      : Math.min(MAX_WALK_MS, WALK_BASE_MS + distance * WALK_MS_PER_PX);
    for (const eye of walker.body.querySelectorAll<HTMLElement>("i")) {
      eye.style.transform = `translateX(${Math.sign(dx) * 1.5}px)`;
    }
    if (durationMs === 0) {
      walker.worldPos = to;
      project(walker);
      onArrive?.();
      return;
    }
    walker.walk = { from, to, startedAt: performance.now(), durationMs, onArrive };
    walker.body.classList.remove("code-map-land");
    walker.body.classList.add("code-map-walk");
    tick();
  };

  const remove = (walker: Walker) => {
    walkers.delete(walker.threadId);
    walker.el.remove();
  };

  const fadeOut = (walker: Walker) => {
    walker.el.style.transition = `opacity ${FADE_MS}ms`;
    walker.el.style.opacity = "0";
    const timer = setTimeout(() => {
      fades.delete(timer);
      remove(walker);
    }, FADE_MS);
    fades.add(timer);
  };

  const apply = (walker: Walker, input: SpriteInput) => {
    walker.input = input;
    walker.body.style.background = input.color;
    walker.el.classList.toggle("opacity-50", input.quiet);
    walker.el.setAttribute(
      "aria-label",
      walker.targetPath ? `${input.title} at ${walker.targetPath}` : input.title,
    );
    if (walker.targetPath) walker.el.dataset.path = walker.targetPath;
    if (input.quiet) walker.el.querySelector("[data-testid=code-map-say]")?.remove();
  };

  const bubbleText = (input: SpriteInput, path: string) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    return input.verb ? `${input.verb} ${name}` : name;
  };

  const spawn = (input: SpriteInput): Walker => {
    const { el, body } = createElement(input);
    const walker: Walker = {
      threadId: input.threadId,
      el,
      body,
      input,
      worldPos: null,
      targetPath: null,
      walk: null,
      leaving: false,
    };
    walkers.set(input.threadId, walker);
    container?.appendChild(el);
    const parent = input.parentThreadId ? walkers.get(input.parentThreadId) : undefined;
    if (parent?.worldPos) walker.worldPos = parent.worldPos;
    return walker;
  };

  const sync = (inputs: ReadonlyArray<SpriteInput>, nextWorld: World | null) => {
    if (nextWorld !== world) {
      world = nextWorld;
      for (const walker of walkers.values()) {
        const interrupted = walker.walk;
        walker.walk = null;
        walker.body.classList.remove("code-map-walk");
        walker.worldPos = walker.targetPath ? anchor(walker, walker.targetPath) : null;
        project(walker);
        if (interrupted && walker.leaving) fadeOut(walker);
      }
    }
    const seen = new Set<ThreadId>();
    for (const input of inputs) {
      seen.add(input.threadId);
      const existing = walkers.get(input.threadId);
      const walker = existing ?? spawn(input);
      const moved = input.path !== null && input.path !== walker.targetPath;
      if (moved) {
        walker.targetPath = input.path;
        const to = anchor(walker, input.path!);
        if (to) {
          const text = bubbleText(input, input.path!);
          const quiet = input.quiet;
          if (existing || walker.worldPos) {
            walkTo(walker, to, quiet ? null : () => say(walker, text));
          } else {
            walker.worldPos = to;
            if (!quiet) say(walker, text);
          }
        }
      }
      apply(walker, input);
      project(walker);
    }
    for (const walker of walkers.values()) {
      if (seen.has(walker.threadId) || walker.leaving) continue;
      walker.leaving = true;
      walker.el.querySelector("[data-testid=code-map-say]")?.remove();
      const parent = walker.input.parentThreadId
        ? walkers.get(walker.input.parentThreadId)
        : undefined;
      if (walker.input.kind === "subagent" && parent?.worldPos && walker.worldPos) {
        walkTo(walker, parent.worldPos, () => fadeOut(walker));
      } else {
        fadeOut(walker);
      }
    }
  };

  return {
    attach(element: HTMLElement | null, cameraStore: CameraStore | null) {
      container = element;
      camera = cameraStore;
      for (const walker of walkers.values()) {
        if (element) element.appendChild(walker.el);
        else walker.el.remove();
      }
    },
    sync,
    reposition() {
      for (const walker of walkers.values()) if (!walker.walk) project(walker);
    },
    dispose() {
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
      for (const timer of fades) clearTimeout(timer);
      fades.clear();
      for (const walker of walkers.values()) walker.el.remove();
      walkers.clear();
    },
  };
}

export function CodeMapSprites(props: {
  readonly sprites: ReadonlyArray<SpriteInput>;
  readonly world: World | null;
  readonly camera: CameraStore;
}) {
  const { sprites, world, camera } = props;
  const [layer] = useState(createSpriteLayer);
  const [element, setElement] = useState<HTMLDivElement | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the sprite layer is imperative DOM that follows the camera store
  useEffect(() => {
    layer.attach(element, camera);
    if (!element) return;
    const unsubscribe = camera.subscribe(layer.reposition);
    return () => {
      unsubscribe();
      layer.attach(null, null);
    };
  }, [layer, element, camera]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reconciles sprite walks against the model outside React state
  useEffect(() => {
    if (element) layer.sync(sprites, world);
  }, [layer, element, sprites, world]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels the walk frame and fade timers on unmount
  useEffect(() => () => layer.dispose(), [layer]);

  return <div ref={setElement} className="pointer-events-none absolute inset-0 overflow-hidden" />;
}
