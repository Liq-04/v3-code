import type { CodeMapPlace, CodeMapSprite } from "@t3tools/client-runtime/state/code-map";
import type { ThreadId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import type { CameraStore } from "./mapCamera";
import type { World } from "./mapWorld";

export interface SpriteInput {
  readonly threadId: ThreadId;
  readonly path: string | null;
  /** Where a sprite with no position yet stands until a path names its place. */
  readonly home: CodeMapPlace | null;
  readonly verb: string | null;
  readonly kind: "agent" | "subagent";
  readonly parentThreadId: ThreadId | null;
  readonly color: string;
  readonly quiet: boolean;
  readonly title: string;
  readonly state: CodeMapSprite["state"];
  readonly idleSince: number | null;
}

type Mood = CodeMapSprite["state"] | "awake";

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

type Stride =
  | { readonly kind: "hop"; readonly hops: number }
  | { readonly kind: "dash"; readonly crouch: boolean };

interface Leg {
  readonly from: Point;
  readonly to: Point;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly stride: Stride;
  readonly onArrive: (() => void) | null;
}

type Gait = "paced" | "walk" | "amble";

interface Stop {
  readonly place: CodeMapPlace;
  /** The bubble for landing here, or null for a sprite that does not speak. */
  readonly say: string | null;
}

interface Walker {
  readonly threadId: ThreadId;
  readonly el: HTMLDivElement;
  readonly body: HTMLDivElement;
  readonly shadow: HTMLElement;
  readonly terminal: HTMLElement;
  linesPrinted: number;
  input: SpriteInput;
  worldPos: Point | null;
  /** Where the sprite ends up once `stops` drains. */
  place: CodeMapPlace | null;
  leg: Leg | null;
  /** Paths named while a leg was in flight, visited in order. */
  readonly stops: Stop[];
  /** A moving average of the time between path changes, which budgets each leg. */
  paceMs: number | null;
  pathChangedAt: number | null;
  pose: ReadonlyArray<Animation>;
  mood: Mood;
  awakeUntil: number;
  readonly phase: number;
  cueBeat: number;
  strayed: boolean;
  leaving: boolean;
}

const WALK_HOP_MS = 560;
const TWO_HOP_PX = 110;
const HOP_LIFT_AT = 0.16;
const HOP_LAND_AT = 0.84;
const DASH_CROUCH_ENDS_AT = 0.18;
const DASH_SKID_STARTS_AT = 0.78;
const DASH_OVERSHOOT = 1.04;
const SUBAGENT_SCALE = 0.6;
const FADE_MS = 320;
const HOVER_DELAY_MS = 150;
const PACE_ALPHA = 0.4;
// A longer gap budgets a full walk whatever the distance, so it must not outweigh a burst after it.
const PACE_CEILING_MS = (2 * WALK_HOP_MS) / 0.8;
const MIN_LEG_MS = 140;
const MAX_STOPS = 6;
const DASH_MIN_PX = 24;
const BEAT_MS = 500;
const BLINK_EVERY_BEATS = 8;
const TYPE_CYCLE_BEATS = 6;
const TYPE_BURST_BEATS = 4;
const PRINT_EVERY_BEATS = 2;
const TERMINAL_ROWS = 3;
const HOP_EVERY_BEATS = 16;
const CLOUD_DOTS = 3;
// Reads finish faster than the shell can show a tool running, so a sprite that just named a
// file is still busy reading; the cloud waits until the files stop coming.
const READ_SETTLE_MS = 1500;
const AWAKE_MS = 5 * 60_000;
const STROLL_MIN_BEATS = 16;
const STROLL_MAX_BEATS = 28;
const STROLL_MIN_PX = 40;
const STROLL_MAX_PX = 90;
const STROLL_EDGE_PX = 24;
const NEAR_PARENT_MIN_PX = 24;
const NEAR_PARENT_MAX_PX = 48;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const easeInOutQuad = (u: number) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);
const easeOutCubic = (u: number) => 1 - (1 - u) ** 3;

const travelled = (stride: Stride, elapsedShare: number) => {
  if (stride.kind === "hop") {
    const hop = Math.min(Math.floor(elapsedShare * stride.hops), stride.hops - 1);
    const air =
      (easeInOutQuad(elapsedShare * stride.hops - hop) - HOP_LIFT_AT) / (HOP_LAND_AT - HOP_LIFT_AT);
    return (hop + clamp(air, 0, 1)) / stride.hops;
  }
  const at = easeOutCubic(elapsedShare);
  const crouch = stride.crouch ? DASH_CROUCH_ENDS_AT : 0;
  if (at < DASH_SKID_STARTS_AT)
    return (DASH_OVERSHOOT * Math.max(0, at - crouch)) / (DASH_SKID_STARTS_AT - crouch);
  return (
    DASH_OVERSHOOT - ((DASH_OVERSHOOT - 1) * (at - DASH_SKID_STARTS_AT)) / (1 - DASH_SKID_STARTS_AT)
  );
};

const terminalRowTop = (row: number) => `${2 + row * 3}px`;

const samePlace = (a: CodeMapPlace | null, b: CodeMapPlace) =>
  a !== null && (a.kind === "file" ? b.kind === "file" && a.path === b.path : b.kind === "dock");

const between = (min: number, max: number) => min + Math.random() * (max - min);

// Seeded by thread so a reload or relayout keeps a sprite on the same spot.
const unitHash = (id: string, seed: number) => {
  let hash = 2166136261 ^ seed;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return (hash >>> 0) / 2 ** 32;
};

// The server stamped `idleSince` on its own clock, so it is read once against ours: a turn that
// ended in our future just ended, and no stamp keeps a sprite awake past AWAKE_MS from now.
const awakeUntilOf = (idleSince: number | null, now: number) =>
  idleSince === null ? 0 : now + AWAKE_MS - clamp(now - idleSince, 0, AWAKE_MS);

const moodOf = (walker: Walker, now: number): Mood =>
  walker.input.state === "idle" && now < walker.awakeUntil ? "awake" : walker.input.state;

const movesOnBeat = (walker: Walker) => !walker.leaving && walker.mood !== "idle";

const reducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const SPRITE_CLASS =
  "code-map-sprite group pointer-events-auto absolute top-0 left-0 z-10 cursor-pointer outline-none will-change-transform";
const AGENT_BOX = "h-[22px] w-[26px] -mt-[22px] -ml-[13px]";
const SUBAGENT_BOX = "h-[13px] w-[15px] -mt-[13px] -ml-[7.5px]";
const AGENT_BODY =
  "relative flex size-full origin-bottom items-center justify-center gap-[5px] rounded-t-lg rounded-b-sm shadow-lg shadow-black/30 ring-2 ring-background";
const SUBAGENT_BODY =
  "relative flex size-full origin-bottom items-center justify-center gap-[3px] rounded-t-sm rounded-b-xs opacity-90 shadow-md shadow-black/30 ring-1 ring-background";
const BODY_FOCUS_CLASS =
  "group-focus-visible:outline-2 group-focus-visible:-outline-offset-2 group-focus-visible:outline-ring";
const WAITING_BADGE_CLASS =
  "pointer-events-none absolute -top-1 -right-1 size-2 rounded-full bg-warning ring-1 ring-background";

const HOP_KEYFRAMES = [
  { translate: "0 0", scale: "1 1" },
  { translate: "0 -6px", scale: "0.96 1.05", offset: 0.22 },
  { translate: "0 0", scale: "1.08 0.92", offset: 0.45 },
  { translate: "0 -3px", scale: "1 1", offset: 0.68 },
  { translate: "0 0", scale: "1 1" },
];

function createElement(input: SpriteInput) {
  const el = document.createElement("div");
  el.dataset.testid = "code-map-sprite";
  el.dataset.threadId = input.threadId;
  el.dataset.kind = input.kind;
  el.className = `${SPRITE_CLASS} ${input.kind === "agent" ? AGENT_BOX : SUBAGENT_BOX}`;
  el.setAttribute("role", "button");
  el.tabIndex = 0;
  const body = document.createElement("div");
  body.className = `${input.kind === "agent" ? AGENT_BODY : SUBAGENT_BODY} ${BODY_FOCUS_CLASS}`;
  for (let i = 0; i < 2; i++) {
    body.appendChild(document.createElement("i")).className = "code-map-eye";
  }
  // index.css draws the cloud from this shape: two tail puffs, then the bubble and its dots.
  const cloud = document.createElement("div");
  cloud.dataset.testid = "code-map-cloud";
  cloud.className = "code-map-cloud";
  for (let i = 0; i < 3; i++) cloud.appendChild(document.createElement("span"));
  for (let i = 0; i < CLOUD_DOTS; i++) {
    cloud.lastElementChild!.appendChild(document.createElement("i"));
  }
  cloud.querySelector("i")!.dataset.lit = "";
  const shadow = document.createElement("span");
  shadow.className = "code-map-shadow";
  const terminal = document.createElement("div");
  terminal.dataset.testid = "code-map-terminal";
  terminal.className = "code-map-terminal";
  [7, 9].forEach((width, row) => {
    const line = terminal.appendChild(document.createElement("i"));
    line.className = "code-map-terminal-line";
    line.style.top = terminalRowTop(row);
    line.style.width = `${width}px`;
  });
  terminal.appendChild(document.createElement("b")).className = "code-map-terminal-cursor";
  el.append(body, cloud, shadow, terminal);
  return { el, body, shadow, terminal };
}

/** Turns the eyes toward a screen direction, or back to their state's expression for none. */
const look = (walker: Walker, dx: number, dy: number) => {
  const { el } = walker;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) {
    delete el.dataset.look;
    return;
  }
  el.style.setProperty("--code-map-look-x", String(dx / distance));
  el.style.setProperty("--code-map-look-y", String(dy / distance));
  el.dataset.look = Math.abs(dx) < distance * 0.3 ? "straight" : dx < 0 ? "left" : "right";
};

// These animate `scale` and `translate`, which compose with the transforms CSS and walks own.
const blink = (walker: Walker) => {
  for (const eye of walker.body.querySelectorAll("i")) {
    eye.animate({ scale: ["1 1", "1 0.1", "1 1"] }, { duration: 140 });
  }
};

const hop = (walker: Walker) => {
  if (!reducedMotion()) {
    walker.body.animate(HOP_KEYFRAMES, { duration: 620, easing: "ease-in-out" });
  }
};

const typeOnTerminal = (walker: Walker, beat: number) => {
  const { terminal } = walker;
  terminal.toggleAttribute("data-blink", beat % 2 === 0);
  const printing = beat % TYPE_CYCLE_BEATS < TYPE_BURST_BEATS && beat % PRINT_EVERY_BEATS === 0;
  if (!printing || walker.leg) return;
  walker.linesPrinted++;
  terminal.querySelectorAll<HTMLElement>(".code-map-terminal-line").forEach((line, index) => {
    const row = (index + walker.linesPrinted * (TERMINAL_ROWS - 1)) % TERMINAL_ROWS;
    line.style.top = terminalRowTop(row);
    if (row === TERMINAL_ROWS - 1) line.style.width = `${Math.round(between(5, 11))}px`;
  });
  walker.body.animate(
    { rotate: ["0deg", "3deg", "0deg"], scale: ["1 1", "1.03 0.96", "1 1"] },
    { duration: 240 },
  );
};

const hopFrame = (lift: number, scale: string, lean: number) =>
  `translateY(${-lift}px) scale(${scale}) rotate(${lean}deg)`;

const dashFrame = (lift: number, scale: string, skew: number) =>
  `translateY(${-lift}px) scale(${scale}) skewX(${skew}deg)`;

const poseFor = (
  walker: Walker,
  stride: Stride,
  headingX: number,
  durationMs: number,
): ReadonlyArray<Animation> => {
  const { body, shadow } = walker;
  const unit = walker.input.kind === "agent" ? 1 : SUBAGENT_SCALE;
  const eyes = [...body.querySelectorAll("i")];
  if (stride.kind === "hop") {
    const timing = {
      duration: durationMs / stride.hops,
      iterations: stride.hops,
      easing: "ease-in-out",
    };
    return [
      body.animate(
        [
          { transform: hopFrame(0, "1, 1", 0) },
          { transform: hopFrame(0, "1.14, 0.84", 0), offset: HOP_LIFT_AT },
          { transform: hopFrame(12 * unit, "0.88, 1.14", headingX * 8), offset: 0.42 },
          { transform: hopFrame(14 * unit, "0.96, 1.04", headingX * 4.8), offset: 0.58 },
          { transform: hopFrame(0, "1.16, 0.82", 0), offset: HOP_LAND_AT },
          { transform: hopFrame(0, "1, 1", 0) },
        ],
        timing,
      ),
      shadow.animate(
        { scale: [1, 1.1, 0.7, 1.1, 1], offset: [0, HOP_LIFT_AT, 0.5, HOP_LAND_AT, 1] },
        timing,
      ),
      ...eyes.map((eye) =>
        eye.animate(
          {
            translate: [
              "0 0",
              `${-headingX * 0.8 * unit}px ${unit}px`,
              `${headingX * 1.2 * unit}px ${-0.5 * unit}px`,
              "0 0",
            ],
            offset: [0, 0.42, HOP_LAND_AT, 1],
          },
          timing,
        ),
      ),
    ];
  }
  const timing = { duration: durationMs, easing: "ease-out" };
  return [
    body.animate(
      [
        { transform: dashFrame(0, "1, 1", 0) },
        ...(stride.crouch
          ? [{ transform: dashFrame(0, "1.22, 0.74", 0), offset: DASH_CROUCH_ENDS_AT }]
          : []),
        { transform: dashFrame(2 * unit, "1.42, 0.7", -headingX * 16), offset: 0.4 },
        { transform: dashFrame(unit, "1.3, 0.78", -headingX * 12), offset: 0.66 },
        { transform: dashFrame(0, "0.86, 1.16", headingX * 8), offset: 0.82 },
        { transform: dashFrame(0, "1.08, 0.94", 0), offset: 0.92 },
        { transform: dashFrame(0, "1, 1", 0) },
      ],
      timing,
    ),
    ...eyes.map((eye) =>
      eye.animate(
        {
          translate: ["0 0", `${-headingX * 1.5 * unit}px 0`, `${headingX * 2 * unit}px 0`, "0 0"],
          offset: [0, 0.4, 0.82, 1],
        },
        timing,
      ),
    ),
  ];
};

const strike = (walker: Walker, pose: ReadonlyArray<Animation>) => {
  for (const animation of walker.pose) animation.cancel();
  walker.pose = pose;
};

const halt = (walker: Walker) => {
  walker.leg = null;
  strike(walker, []);
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

const speaks = (input: SpriteInput) => !input.quiet && input.state !== "idle";

const bubbleText = (input: SpriteInput, path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return input.verb ? `${input.verb} ${name}` : name;
};

function createSpriteLayer() {
  let container: HTMLElement | null = null;
  let camera: CameraStore | null = null;
  let world: World | null = null;
  const walkers = new Map<ThreadId, Walker>();
  const fades = new Set<ReturnType<typeof setTimeout>>();
  let frame = 0;
  let beat = 0;
  let beatTimer: ReturnType<typeof setInterval> | null = null;
  let spawned = 0;
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
    if (walker.strayed && walker.leg) {
      halt(walker);
      look(walker, 0, 0);
    }
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

  const anchor = (walker: Walker, place: CodeMapPlace): Point | null => {
    if (!world || !camera) return null;
    const { scale } = camera.get();
    if (place.kind === "dock") {
      const { root } = world;
      const edge = STROLL_EDGE_PX / scale;
      const top = root.y + root.headerHeight + edge;
      return {
        x: root.x + edge + unitHash(walker.threadId, 1) * Math.max(0, root.w - 2 * edge),
        y: top + unitHash(walker.threadId, 2) * Math.max(0, root.y + root.h - edge - top),
      };
    }
    const file = world.files.get(place.path);
    if (!file) return null;
    let lane = 0;
    for (const other of walkers.values()) {
      if (other !== walker && samePlace(other.place, place) && !other.leaving) lane++;
    }
    const step = walker.input.kind === "agent" ? 14 : 8;
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
      const u = clamp((now - leg.startedAt) / leg.durationMs, 0, 1);
      const e = u < 1 ? travelled(leg.stride, u) : 1;
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

  const act = (walker: Walker) => {
    const { mood } = walker;
    const own = beat + walker.phase;
    if (mood === "thinking") {
      walker.el.querySelectorAll<HTMLElement>(".code-map-cloud i").forEach((dot, index) => {
        dot.toggleAttribute("data-lit", index === beat % CLOUD_DOTS);
      });
    }
    if (mood === "working") typeOnTerminal(walker, own);
    if (mood === "waiting" && (beat - walker.cueBeat) % HOP_EVERY_BEATS === 0) hop(walker);
    if (mood === "awake" && beat >= walker.cueBeat) stroll(walker);
    if (own % BLINK_EVERY_BEATS === 0) blink(walker);
  };

  const onBeat = () => {
    beat++;
    const now = performance.now();
    const wallNow = Date.now();
    const still = reducedMotion();
    for (const walker of walkers.values()) {
      const settled = now - (walker.pathChangedAt ?? 0) >= READ_SETTLE_MS;
      if (walker.el.dataset.busy !== undefined && !walker.leg && settled) {
        delete walker.el.dataset.busy;
      }
      refreshMood(walker, wallNow);
      if (!still && movesOnBeat(walker)) act(walker);
    }
    syncBeat();
  };

  /** The beat runs only while some sprite is in a mood that moves on it. */
  const syncBeat = () => {
    const needed = [...walkers.values()].some(movesOnBeat);
    if (needed && beatTimer === null) {
      beatTimer = setInterval(onBeat, BEAT_MS);
    } else if (!needed && beatTimer !== null) {
      clearInterval(beatTimer);
      beatTimer = null;
    }
  };

  const arrive = (walker: Walker, leg: Leg, now: number) => {
    halt(walker);
    if (depart(walker, now)) return;
    look(walker, 0, 0);
    if (walker.mood !== "idle") blink(walker);
    leg.onArrive?.();
  };

  /**
   * Starts a leg from where the walker is. A paced leg gets only the time until the next path is
   * likely to land, and dashes when a walk does not fit in it. Null means it jumped there.
   */
  const startLeg = (
    walker: Walker,
    to: Point,
    now: number,
    gait: Gait,
    onArrive: (() => void) | null,
  ): Leg | null => {
    if (!camera) return null;
    endHover(walker);
    walker.strayed = gait === "amble";
    const interrupted = walker.leg !== null;
    const from = walker.worldPos ?? to;
    walker.worldPos = from;
    const { scale } = camera.get();
    const dx = (to.x - from.x) * scale;
    const dy = (to.y - from.y) * scale;
    const distance = Math.hypot(dx, dy);
    if (reducedMotion()) {
      halt(walker);
      look(walker, 0, 0);
      walker.worldPos = to;
      project(walker);
      onArrive?.();
      return null;
    }
    const hops = distance > TWO_HOP_PX ? 2 : 1;
    const walkMs = hops * WALK_HOP_MS;
    const budgetMs = (gait === "paced" ? legBudget(walker) : null) ?? walkMs;
    const durationMs = Math.min(walkMs, budgetMs);
    const stride: Stride =
      budgetMs < walkMs && distance > DASH_MIN_PX
        ? { kind: "dash", crouch: !interrupted }
        : { kind: "hop", hops };
    const leg: Leg = { from, to, startedAt: now, durationMs, stride, onArrive };
    walker.leg = leg;
    look(walker, dx, dy);
    strike(walker, poseFor(walker, stride, distance === 0 ? 0 : dx / distance, durationMs));
    tick();
    return leg;
  };

  /** Sets off for the next stop still on the map. Null when none is left to walk to. */
  const depart = (walker: Walker, now: number): Leg | null => {
    for (let stop = walker.stops.shift(); stop; stop = walker.stops.shift()) {
      const to = anchor(walker, stop.place);
      if (!to) continue;
      const text = stop.say;
      const leg = startLeg(
        walker,
        to,
        now,
        "paced",
        text === null ? null : () => say(walker, text),
      );
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
    walker.el.dataset.busy = "";
    walker.stops.push(stop);
    if (walker.stops.length > MAX_STOPS) walker.stops.shift();
    const leg = walker.leg;
    if (!leg || walker.strayed) {
      depart(walker, now);
      return;
    }
    const budgetMs = legBudget(walker);
    const remainingMs = leg.startedAt + leg.durationMs - now;
    if (budgetMs !== null && remainingMs > budgetMs) {
      startLeg(walker, leg.to, now, "paced", leg.onArrive);
    }
  };

  const nextStrollBeat = () => beat + Math.round(between(STROLL_MIN_BEATS, STROLL_MAX_BEATS));

  const stroll = (walker: Walker) => {
    walker.cueBeat = nextStrollBeat();
    const from = walker.worldPos;
    const home = walker.place && anchor(walker, walker.place);
    if (!world || !camera || !from || !home || walker.leg || hover?.walker === walker) return;
    const { scale } = camera.get();
    const angle = between(0, Math.PI * 2);
    const reach = between(STROLL_MIN_PX, STROLL_MAX_PX) / scale;
    const edge = STROLL_EDGE_PX / scale;
    const to = {
      x: clamp(home.x + Math.cos(angle) * reach, edge, world.width - edge),
      y: clamp(home.y + Math.sin(angle) * reach, edge, world.height - edge),
    };
    if (Math.hypot(to.x - from.x, to.y - from.y) * scale < STROLL_MIN_PX / 2) return;
    startLeg(walker, to, performance.now(), "amble", null);
  };

  const recall = (walker: Walker) => {
    if (!walker.strayed) return;
    halt(walker);
    walker.strayed = false;
    const home = walker.place && anchor(walker, walker.place);
    if (home) startLeg(walker, home, performance.now(), "walk", null);
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

  // index.css draws each mood's eyes and cloud from these attributes.
  const setMood = (walker: Walker, mood: Mood) => {
    const { el, body } = walker;
    if (walker.mood === "awake") recall(walker);
    const finished = walker.mood === "working" || walker.mood === "thinking";
    walker.mood = mood;
    el.dataset.state = mood;
    el.toggleAttribute("data-done", finished && walker.input.state === "idle");
    walker.cueBeat = mood === "awake" ? nextStrollBeat() : beat;
    body.classList.toggle("opacity-70", mood === "idle");
    body.querySelector("[data-testid=code-map-waiting]")?.remove();
    if (mood !== "waiting") return;
    const badge = document.createElement("span");
    badge.dataset.testid = "code-map-waiting";
    badge.className = WAITING_BADGE_CLASS;
    body.appendChild(badge);
    hop(walker);
  };

  const refreshMood = (walker: Walker, now: number) => {
    const mood = moodOf(walker, now);
    if (mood !== walker.mood) setMood(walker, mood);
  };

  const apply = (walker: Walker, input: SpriteInput) => {
    const now = Date.now();
    if (input.idleSince !== walker.input.idleSince) {
      walker.awakeUntil = awakeUntilOf(input.idleSince, now);
    }
    walker.input = input;
    refreshMood(walker, now);
    walker.body.style.background = input.color;
    walker.el.style.setProperty("--code-map-color", input.color);
    walker.el.classList.toggle("opacity-50", input.quiet);
    const path = walker.place?.kind === "file" ? walker.place.path : null;
    walker.el.setAttribute("aria-label", path === null ? input.title : `${input.title} at ${path}`);
    if (path !== null) walker.el.dataset.path = path;
    if (!speaks(input)) walker.el.querySelector("[data-testid=code-map-say]")?.remove();
  };

  const besideParent = (input: SpriteInput): Point | null =>
    (input.parentThreadId && walkers.get(input.parentThreadId)?.worldPos) || null;

  const nearParent = (input: SpriteInput): Point | null => {
    const parent = besideParent(input);
    if (!parent || !world || !camera) return parent;
    const { scale } = camera.get();
    const angle = unitHash(input.threadId, 3) * Math.PI * 2;
    const reach =
      (NEAR_PARENT_MIN_PX +
        unitHash(input.threadId, 4) * (NEAR_PARENT_MAX_PX - NEAR_PARENT_MIN_PX)) /
      scale;
    const edge = STROLL_EDGE_PX / scale;
    return {
      x: clamp(parent.x + Math.cos(angle) * reach, edge, world.width - edge),
      y: clamp(parent.y + Math.sin(angle) * reach, edge, world.height - edge),
    };
  };

  const spawn = (input: SpriteInput): Walker => {
    const walker: Walker = {
      threadId: input.threadId,
      ...createElement(input),
      linesPrinted: 0,
      input,
      worldPos: nearParent(input),
      place: null,
      leg: null,
      stops: [],
      paceMs: null,
      pathChangedAt: null,
      pose: [],
      mood: "idle",
      awakeUntil: awakeUntilOf(input.idleSince, Date.now()),
      phase: spawned++,
      cueBeat: beat,
      strayed: false,
      leaving: false,
    };
    walkers.set(input.threadId, walker);
    listen(walker);
    container?.appendChild(walker.el);
    setMood(walker, moodOf(walker, Date.now()));
    return walker;
  };

  const sync = (inputs: ReadonlyArray<SpriteInput>, nextWorld: World | null) => {
    if (nextWorld !== world) {
      world = nextWorld;
      for (const walker of walkers.values()) {
        const interrupted = walker.leg;
        halt(walker);
        look(walker, 0, 0);
        walker.stops.length = 0;
        walker.strayed = false;
        walker.worldPos = walker.place && anchor(walker, walker.place);
        project(walker);
        if (interrupted && walker.leaving) fadeOut(walker);
      }
    }
    const seen = new Set<ThreadId>();
    for (const input of inputs) {
      seen.add(input.threadId);
      const existing = walkers.get(input.threadId);
      const walker = existing ?? spawn(input);
      const named: CodeMapPlace | null =
        input.path === null ? null : { kind: "file", path: input.path };
      const to = named && !samePlace(walker.place, named) ? anchor(walker, named) : null;
      if (named && to) {
        walker.place = named;
        const text = speaks(input) ? bubbleText(input, named.path) : null;
        if (existing || walker.worldPos) {
          visit(walker, { place: named, say: text });
        } else {
          walker.worldPos = to;
          if (text !== null) say(walker, text);
        }
      }
      if (!walker.worldPos && input.home) {
        const home = anchor(walker, input.home);
        if (home) {
          walker.place = input.home;
          walker.worldPos = home;
        }
      }
      walker.worldPos ??= nearParent(input);
      apply(walker, input);
      project(walker);
    }
    for (const walker of walkers.values()) {
      if (seen.has(walker.threadId) || walker.leaving) continue;
      walker.leaving = true;
      endHover(walker);
      walker.el.classList.replace("pointer-events-auto", "pointer-events-none");
      walker.el.querySelector("[data-testid=code-map-say]")?.remove();
      const parentPos = besideParent(walker.input);
      walker.stops.length = 0;
      if (walker.input.kind === "subagent" && parentPos && walker.worldPos) {
        startLeg(walker, parentPos, performance.now(), "walk", () => fadeOut(walker));
      } else {
        fadeOut(walker);
      }
    }
    syncBeat();
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
      if (beatTimer !== null) clearInterval(beatTimer);
      beatTimer = null;
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels the walk frame, the beat and fade timers on unmount
  useEffect(() => () => layer.dispose(), [layer]);

  return <div ref={setElement} className="pointer-events-none absolute inset-0 overflow-hidden" />;
}
