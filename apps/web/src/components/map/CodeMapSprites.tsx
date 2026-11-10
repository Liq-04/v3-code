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

/** A sprite whose turn just ended is awake for a while; idle is asleep. */
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
  input: SpriteInput;
  worldPos: Point | null;
  /** Where the sprite ends up once `stops` drains. Only ever a place the world could anchor. */
  place: CodeMapPlace | null;
  leg: Leg | null;
  /** Paths named while a leg was in flight, visited in order. */
  readonly stops: Stop[];
  /** A moving average of the time between path changes, which budgets each leg. */
  paceMs: number | null;
  pathChangedAt: number | null;
  pose: Animation | null;
  mood: Mood;
  /** When an idle walker falls asleep, on this client's clock. */
  awakeUntil: number;
  /** Offsets this walker's blinks and taps on the shared beat so sprites do not move in step. */
  readonly phase: number;
  /** The beat its mood counts from: waiting hops every so often after it, awake strolls once it comes. */
  cueBeat: number;
  /** Off its place on a stroll, until a leg takes it somewhere it belongs. */
  strayed: boolean;
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
const BEAT_MS = 500;
const TAP_EVERY_BEATS = 2;
const BLINK_EVERY_BEATS = 8;
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
const AMBLE_MS_PER_PX = 18;

const easeInOutQuad = (u: number) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);
const easeOutCubic = (u: number) => 1 - (1 - u) ** 3;

const samePlace = (a: CodeMapPlace | null, b: CodeMapPlace) =>
  a !== null && (a.kind === "file" ? b.kind === "file" && a.path === b.path : b.kind === "dock");

const between = (min: number, max: number) => min + Math.random() * (max - min);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

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
  el.append(body, cloud);
  return { el, body };
}

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
    // A stroll would walk the sprite out from under its hover card.
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
    let lane = 0;
    for (const other of walkers.values()) {
      if (other !== walker && samePlace(other.place, place) && !other.leaving) lane++;
    }
    const { scale } = camera.get();
    const step = walker.input.kind === "agent" ? 14 : 8;
    if (place.kind === "dock") {
      const { root } = world;
      return { x: root.x + (20 + lane * 30) / scale, y: root.y + root.headerHeight + 26 / scale };
    }
    const file = world.files.get(place.path);
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

  const tap = (walker: Walker) =>
    walker.body.animate(
      { scale: ["1 1", "1.06 0.9", "1 1"] },
      { duration: 220, easing: "ease-in-out" },
    );

  const hop = (walker: Walker) => {
    if (!reducedMotion()) {
      walker.body.animate(HOP_KEYFRAMES, { duration: 620, easing: "ease-in-out" });
    }
  };

  const act = (walker: Walker) => {
    const { mood } = walker;
    const own = beat + walker.phase;
    if (mood === "thinking") {
      walker.el.querySelectorAll<HTMLElement>(".code-map-cloud i").forEach((dot, index) => {
        dot.toggleAttribute("data-lit", index === beat % CLOUD_DOTS);
      });
    }
    if (mood === "working" && own % TAP_EVERY_BEATS === 0 && !walker.leg) tap(walker);
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
    look(walker, 0, 0);
    if (walker.mood !== "idle") blink(walker);
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
    const walkMs =
      gait === "amble"
        ? distance * AMBLE_MS_PER_PX
        : Math.min(MAX_WALK_MS, WALK_BASE_MS + distance * WALK_MS_PER_PX);
    const budgetMs = (gait === "paced" ? legBudget(walker) : null) ?? walkMs;
    const durationMs = Math.min(walkMs, budgetMs);
    const dash = budgetMs < walkMs && distance > DASH_MIN_PX;
    // A leg hurried mid-stride is already moving, so it skips the squash.
    const holdMs = dash && !interrupted ? Math.min(DASH_SQUASH_MS, durationMs * 0.25) : 0;
    const moveMs = dash ? durationMs * 0.75 : durationMs;
    const leg: Leg = { from, to, startedAt: now, holdMs, moveMs, dash, onArrive };
    walker.leg = leg;
    look(walker, dx, dy);
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
    const remainingMs = leg.startedAt + leg.holdMs + leg.moveMs - now;
    if (budgetMs !== null && remainingMs > budgetMs) {
      startLeg(walker, leg.to, now, "paced", leg.onArrive);
    }
  };

  const nextStrollBeat = () => beat + Math.round(between(STROLL_MIN_BEATS, STROLL_MAX_BEATS));

  /** Ambles to a point near the walker's place, so a stroll never carries it off its file. */
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

  /** Ends a stroll where it is and walks the sprite back to its place. */
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

  const speaks = (input: SpriteInput) => !input.quiet && input.state !== "idle";

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

  const bubbleText = (input: SpriteInput, path: string) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    return input.verb ? `${input.verb} ${name}` : name;
  };

  const besideParent = (input: SpriteInput): Point | null =>
    (input.parentThreadId && walkers.get(input.parentThreadId)?.worldPos) || null;

  const spawn = (input: SpriteInput): Walker => {
    const { el, body } = createElement(input);
    const walker: Walker = {
      threadId: input.threadId,
      el,
      body,
      input,
      worldPos: besideParent(input),
      place: null,
      leg: null,
      stops: [],
      paceMs: null,
      pathChangedAt: null,
      pose: null,
      mood: "idle",
      awakeUntil: awakeUntilOf(input.idleSince, Date.now()),
      phase: spawned++,
      cueBeat: beat,
      strayed: false,
      leaving: false,
    };
    walkers.set(input.threadId, walker);
    listen(walker);
    container?.appendChild(el);
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
      walker.worldPos ??= besideParent(input);
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
