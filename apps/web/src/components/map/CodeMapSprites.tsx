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

interface Leg {
  readonly from: Point;
  readonly to: Point;
  readonly startedAt: number;
  /** A dash squashes in place this long before it glides. */
  readonly holdMs: number;
  readonly moveMs: number;
  readonly dash: boolean;
  readonly onArrive: (() => void) | null;
}

interface Stop {
  readonly path: string;
  /** The bubble for landing here, or null for a sprite that does not speak. */
  readonly say: string | null;
}

interface Walker {
  readonly threadId: ThreadId;
  readonly el: HTMLDivElement;
  readonly body: HTMLDivElement;
  input: SpriteInput;
  worldPos: Point | null;
  /** The latest path the model named: where the sprite ends up once `stops` drains. */
  targetPath: string | null;
  leg: Leg | null;
  /** Paths named while a leg was in flight, visited in order. */
  readonly stops: Stop[];
  /** A moving average of the time between path changes, which budgets each leg. */
  paceMs: number | null;
  pathChangedAt: number | null;
  pose: Animation | null;
  leaving: boolean;
}

const MAX_WALK_MS = 1600;
const WALK_BASE_MS = 250;
const WALK_MS_PER_PX = 2.2;
const FADE_MS = 320;
const HOVER_DELAY_MS = 150;
const PACE_ALPHA = 0.4;
// A longer gap budgets a full walk whatever the distance, so it must not outweigh a burst after it.
const PACE_CEILING_MS = MAX_WALK_MS / 0.8;
const MIN_LEG_MS = 140;
const MAX_STOPS = 6;
const DASH_MIN_PX = 24;
const DASH_SQUASH_MS = 70;
const PASS_TICK_MS = 110;

const easeInOutQuad = (u: number) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);
const easeOutCubic = (u: number) => 1 - (1 - u) ** 3;

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
      const leg = walker.leg;
      if (!leg) continue;
      const u = Math.min(1, Math.max(0, (now - leg.startedAt - leg.holdMs) / leg.moveMs));
      const e = leg.dash ? easeOutCubic(u) : easeInOutQuad(u);
      walker.worldPos = {
        x: leg.from.x + (leg.to.x - leg.from.x) * e,
        y: leg.from.y + (leg.to.y - leg.from.y) * e,
      };
      project(walker);
      if (u < 1) moving = true;
      else arrive(walker, leg, now);
    }
    if (moving) tick();
  };

  const strike = (walker: Walker, pose: Animation | null) => {
    walker.pose?.cancel();
    walker.pose = pose;
  };

  const halt = (walker: Walker) => {
    walker.leg = null;
    strike(walker, null);
    walker.body.classList.remove("code-map-walk");
  };

  const arrive = (walker: Walker, leg: Leg, now: number) => {
    halt(walker);
    walker.body.classList.remove("code-map-land");
    const next = depart(walker, now);
    if (next) {
      // A dash opens with its own squash, so only a walk needs the passing tick.
      if (!next.dash) {
        strike(
          walker,
          walker.body.animate([{ transform: "scale(1.08, 0.9)" }, { transform: "none" }], {
            duration: PASS_TICK_MS,
          }),
        );
      }
      return;
    }
    void walker.body.offsetWidth;
    walker.body.classList.add("code-map-land");
    leg.onArrive?.();
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

  /** How long a leg may take before the next path is likely to land. Null before a pace is known. */
  const legBudget = (walker: Walker) =>
    walker.paceMs === null
      ? null
      : Math.max(MIN_LEG_MS, walker.paceMs * (walker.stops.length > 0 ? 0.55 : 0.8));

  /**
   * Starts a leg from where the walker is. A paced leg gets only the time until the next path is
   * likely to land, and dashes when a walk does not fit in it. Null means it jumped there.
   */
  const startLeg = (
    walker: Walker,
    to: Point,
    now: number,
    paced: boolean,
    onArrive: (() => void) | null,
  ): Leg | null => {
    if (!camera) return null;
    endHover(walker);
    const interrupted = walker.leg !== null;
    const from = walker.worldPos ?? to;
    walker.worldPos = from;
    const { scale } = camera.get();
    const dx = (to.x - from.x) * scale;
    const dy = (to.y - from.y) * scale;
    const distance = Math.hypot(dx, dy);
    for (const eye of walker.body.querySelectorAll<HTMLElement>("i")) {
      eye.style.transform = `translateX(${Math.sign(dx) * 1.5}px)`;
    }
    if (reducedMotion()) {
      halt(walker);
      walker.worldPos = to;
      project(walker);
      onArrive?.();
      return null;
    }
    const walkMs = Math.min(MAX_WALK_MS, WALK_BASE_MS + distance * WALK_MS_PER_PX);
    const budgetMs = (paced ? legBudget(walker) : null) ?? walkMs;
    const durationMs = Math.min(walkMs, budgetMs);
    const dash = budgetMs < walkMs && distance > DASH_MIN_PX;
    // A leg hurried mid-stride is already moving, so it skips the squash.
    const holdMs = dash && !interrupted ? Math.min(DASH_SQUASH_MS, durationMs * 0.25) : 0;
    const moveMs = dash ? durationMs * 0.75 : durationMs;
    const leg: Leg = { from, to, startedAt: now, holdMs, moveMs, dash, onArrive };
    walker.leg = leg;
    walker.body.classList.remove("code-map-land");
    walker.body.classList.toggle("code-map-walk", !dash);
    if (dash) {
      const lean = `scale(1.18, 0.86) rotate(${Math.sign(dx) * 6}deg)`;
      const squashed = holdMs / (holdMs + moveMs);
      const windUp =
        holdMs > 0
          ? [
              { transform: "none" },
              { transform: "scale(1.14, 0.82)", offset: squashed },
              { transform: lean, offset: squashed + 0.1 },
            ]
          : [{ transform: "none" }, { transform: lean, offset: 0.15 }];
      strike(
        walker,
        walker.body.animate([...windUp, { transform: lean }], {
          duration: holdMs + moveMs,
          fill: "forwards",
        }),
      );
    } else {
      strike(walker, null);
    }
    tick();
    return leg;
  };

  /** Sets off for the next stop still on the map. Null when none is left to walk to. */
  const depart = (walker: Walker, now: number): Leg | null => {
    for (let stop = walker.stops.shift(); stop; stop = walker.stops.shift()) {
      const to = anchor(walker, stop.path);
      if (!to) continue;
      const text = stop.say;
      const leg = startLeg(walker, to, now, true, text === null ? null : () => say(walker, text));
      if (leg) return leg;
    }
    return null;
  };

  /** Queues a path behind the leg in flight, and hurries that leg when the pace outruns it. */
  const visit = (walker: Walker, stop: Stop) => {
    const now = performance.now();
    if (walker.pathChangedAt !== null) {
      const gap = Math.min(now - walker.pathChangedAt, PACE_CEILING_MS);
      walker.paceMs =
        walker.paceMs === null ? gap : walker.paceMs * (1 - PACE_ALPHA) + gap * PACE_ALPHA;
    }
    walker.pathChangedAt = now;
    walker.stops.push(stop);
    if (walker.stops.length > MAX_STOPS) walker.stops.shift();
    const leg = walker.leg;
    if (!leg) {
      depart(walker, now);
      return;
    }
    const budgetMs = legBudget(walker);
    const remainingMs = leg.startedAt + leg.holdMs + leg.moveMs - now;
    if (budgetMs !== null && remainingMs > budgetMs) {
      startLeg(walker, leg.to, now, true, leg.onArrive);
    }
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
      leg: null,
      stops: [],
      paceMs: null,
      pathChangedAt: null,
      pose: null,
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
        const interrupted = walker.leg;
        halt(walker);
        walker.stops.length = 0;
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
          const text = speaks(input) ? bubbleText(input, input.path!) : null;
          if (existing || walker.worldPos) {
            visit(walker, { path: input.path!, say: text });
          } else {
            walker.worldPos = to;
            if (text !== null) say(walker, text);
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
      walker.stops.length = 0;
      if (walker.input.kind === "subagent" && parent?.worldPos && walker.worldPos) {
        startLeg(walker, parent.worldPos, performance.now(), false, () => fadeOut(walker));
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
      for (const walker of walkers.values()) if (!walker.leg) project(walker);
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
