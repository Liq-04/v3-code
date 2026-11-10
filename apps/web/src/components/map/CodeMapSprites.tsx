import { CODE_MAP_DOCK, type CodeMapSprite } from "@t3tools/client-runtime/state/code-map";
import type { ThreadId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import type { CameraStore } from "./mapCamera";
import type { World } from "./mapWorld";

export interface SpriteInput {
  readonly threadId: ThreadId;
  readonly path: string | null;
  /** Where a sprite with no position yet stands until a path names its place. */
  readonly home: string | null;
  readonly verb: string | null;
  readonly kind: "agent" | "subagent";
  readonly parentThreadId: ThreadId | null;
  readonly color: string;
  readonly quiet: boolean;
  readonly title: string;
  readonly state: CodeMapSprite["state"];
}

export interface SpriteHover {
  readonly threadId: ThreadId;
  /** The sprite's box, relative to the map container. */
  readonly rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

interface SpriteHandlers {
  readonly onHover: (hover: SpriteHover | null) => void;
  readonly onOpen: (threadId: ThreadId) => void;
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
const HOVER_DELAY_MS = 150;

const easeInOutQuad = (u: number) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);

const reducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const SPRITE_CLASS =
  "group pointer-events-auto absolute top-0 left-0 z-10 cursor-pointer outline-none will-change-transform";
const AGENT_BOX = "h-[22px] w-[26px] -mt-[22px] -ml-[13px]";
const SUBAGENT_BOX = "h-[13px] w-[15px] -mt-[13px] -ml-[7.5px]";
const AGENT_BODY =
  "flex size-full origin-bottom items-center justify-center gap-1 rounded-t-lg rounded-b-sm shadow-lg shadow-black/30 ring-2 ring-background";
const SUBAGENT_BODY =
  "flex size-full origin-bottom items-center justify-center gap-[3px] rounded-t-sm rounded-b-xs opacity-90 shadow-md shadow-black/30 ring-1 ring-background";
const BODY_FOCUS_CLASS =
  "group-focus-visible:outline-2 group-focus-visible:-outline-offset-2 group-focus-visible:outline-ring";
const EYE_CLASS = "rounded-xs bg-white transition-transform duration-200";
const WAITING_BADGE_CLASS =
  "pointer-events-none absolute -top-1 -right-1 size-2 rounded-full bg-warning ring-1 ring-background";

const eyeShape = (input: SpriteInput) =>
  input.kind === "subagent" ? "size-[3px]" : input.state === "idle" ? "h-0.5 w-1.5" : "h-1.5 w-1";

function createElement(input: SpriteInput): { el: HTMLDivElement; body: HTMLDivElement } {
  const el = document.createElement("div");
  el.dataset.testid = "code-map-sprite";
  el.dataset.threadId = input.threadId;
  el.dataset.kind = input.kind;
  el.className = `${SPRITE_CLASS} ${input.kind === "agent" ? AGENT_BOX : SUBAGENT_BOX}`;
  el.setAttribute("role", "button");
  el.tabIndex = 0;
  const body = document.createElement("div");
  body.className = `${input.kind === "agent" ? AGENT_BODY : SUBAGENT_BODY} ${BODY_FOCUS_CLASS}`;
  for (let i = 0; i < 2; i++) body.appendChild(document.createElement("i"));
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
  let handlers: SpriteHandlers | null = null;
  let hover: {
    readonly walker: Walker;
    readonly timer: ReturnType<typeof setTimeout>;
    reported: boolean;
  } | null = null;

  const endHover = (walker?: Walker) => {
    if (!hover || (walker && hover.walker !== walker)) return;
    clearTimeout(hover.timer);
    if (hover.reported) handlers?.onHover(null);
    hover = null;
  };

  const beginHover = (walker: Walker) => {
    if (hover?.walker === walker || walker.leaving) return;
    endHover();
    const timer = setTimeout(() => {
      if (hover?.walker !== walker || !container) return;
      hover.reported = true;
      const box = container.getBoundingClientRect();
      const rect = walker.el.getBoundingClientRect();
      handlers?.onHover({
        threadId: walker.threadId,
        rect: { x: rect.left - box.left, y: rect.top - box.top, w: rect.width, h: rect.height },
      });
    }, HOVER_DELAY_MS);
    hover = { walker, timer, reported: false };
  };

  const listen = (walker: Walker) => {
    const { el } = walker;
    const open = () => handlers?.onOpen(walker.threadId);
    // Keeps a press on a sprite from starting a pan of the map under it.
    el.addEventListener("pointerdown", (event) => event.stopPropagation());
    el.addEventListener("pointerenter", () => beginHover(walker));
    // A camera move ends the hover with the pointer still inside; the next move resumes it.
    el.addEventListener("pointermove", () => beginHover(walker));
    el.addEventListener("pointerleave", () => endHover(walker));
    el.addEventListener("focus", () => beginHover(walker));
    el.addEventListener("blur", () => endHover(walker));
    el.addEventListener("click", open);
    el.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      open();
    });
  };

  const project = (walker: Walker) => {
    walker.el.style.visibility = walker.worldPos ? "" : "hidden";
    if (!walker.worldPos || !camera) return;
    const { x, y, scale } = camera.get();
    const { worldPos } = walker;
    walker.el.style.transform = `translate(${worldPos.x * scale + x}px, ${worldPos.y * scale + y}px)`;
  };

  const anchor = (walker: Walker, path: string): Point | null => {
    if (!world || !camera) return null;
    let lane = 0;
    for (const other of walkers.values()) {
      if (other !== walker && other.targetPath === path && !other.leaving) lane++;
    }
    const { scale } = camera.get();
    const step = walker.input.kind === "agent" ? 14 : 8;
    if (path === CODE_MAP_DOCK) {
      const { root } = world;
      return { x: root.x + (20 + lane * 30) / scale, y: root.y + root.headerHeight + 26 / scale };
    }
    const file = world.files.get(path);
    if (!file) return null;
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
    bubble.className = `code-map-say pointer-events-none absolute left-full whitespace-nowrap rounded-sm border border-border bg-popover text-popover-foreground ${
      walker.input.kind === "agent"
        ? "top-0 ml-1.5 px-1.5 py-px text-3xs"
        : "-top-[3px] ml-0.5 px-1 text-4xs"
    }`;
    bubble.textContent = text;
    walker.el.appendChild(bubble);
  };

  const walkTo = (walker: Walker, to: Point, onArrive: (() => void) | null) => {
    if (!camera) return;
    endHover(walker);
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
    endHover(walker);
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

  const paintState = (walker: Walker) => {
    const { input, el, body } = walker;
    el.dataset.state = input.state;
    body.classList.toggle("opacity-70", input.state === "idle");
    for (const eye of body.querySelectorAll("i")) eye.className = `${EYE_CLASS} ${eyeShape(input)}`;
    el.querySelector("[data-testid=code-map-waiting]")?.remove();
    if (input.state !== "waiting") return;
    const badge = document.createElement("span");
    badge.dataset.testid = "code-map-waiting";
    badge.className = WAITING_BADGE_CLASS;
    el.appendChild(badge);
  };

  const speaks = (input: SpriteInput) => !input.quiet && input.state !== "idle";

  const apply = (walker: Walker, input: SpriteInput) => {
    walker.input = input;
    if (walker.el.dataset.state !== input.state) paintState(walker);
    walker.body.style.background = input.color;
    walker.el.classList.toggle("opacity-50", input.quiet);
    walker.el.setAttribute(
      "aria-label",
      walker.targetPath ? `${input.title} at ${walker.targetPath}` : input.title,
    );
    if (walker.targetPath) walker.el.dataset.path = walker.targetPath;
    if (!speaks(input)) walker.el.querySelector("[data-testid=code-map-say]")?.remove();
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
    listen(walker);
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
          const speak = speaks(input);
          if (existing || walker.worldPos) {
            walkTo(walker, to, speak ? () => say(walker, text) : null);
          } else {
            walker.worldPos = to;
            if (speak) say(walker, text);
          }
        }
      }
      if (walker.targetPath === null && input.home !== null) {
        const to = anchor(walker, input.home);
        if (to) {
          walker.targetPath = input.home;
          walker.worldPos = to;
        }
      }
      apply(walker, input);
      project(walker);
    }
    for (const walker of walkers.values()) {
      if (seen.has(walker.threadId) || walker.leaving) continue;
      walker.leaving = true;
      endHover(walker);
      walker.el.classList.replace("pointer-events-auto", "pointer-events-none");
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
    handle(next: SpriteHandlers) {
      handlers = next;
    },
    reposition() {
      endHover();
      for (const walker of walkers.values()) if (!walker.walk) project(walker);
    },
    dispose() {
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
      handlers = null;
      endHover();
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
  readonly onHover: SpriteHandlers["onHover"];
  readonly onOpen: SpriteHandlers["onOpen"];
}) {
  const { sprites, world, camera, onHover, onOpen } = props;
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the imperative sprite elements call the latest handlers
  useEffect(() => {
    layer.handle({ onHover, onOpen });
  }, [layer, onHover, onOpen]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reconciles sprite walks against the model outside React state
  useEffect(() => {
    if (element) layer.sync(sprites, world);
  }, [layer, element, sprites, world]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels the walk frame and fade timers on unmount
  useEffect(() => () => layer.dispose(), [layer]);

  return <div ref={setElement} className="pointer-events-none absolute inset-0 overflow-hidden" />;
}
