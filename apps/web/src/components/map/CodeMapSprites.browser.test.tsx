import { CODE_MAP_DOCK } from "@t3tools/client-runtime/state/code-map";
import { ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { fakeTimers, render } from "../../../test/render";

import { CodeMapSprites, type SpriteInput } from "./CodeMapSprites";
import { createCameraStore } from "./mapCamera";
import { buildWorld, rectOf } from "./mapWorld";

const A = "apps/web/ChatView.tsx";
const B = "packages/contracts/git.ts";
const C = "apps/web/index.css";
const world = buildWorld(
  {
    paths: [A, B, C],
    lines: [1600, 700, 1300],
    vendored: [false, false, false],
  },
  [],
  600,
  400,
);
const resized = buildWorld(
  { paths: [A, B, C], lines: [1600, 700, 1300], vendored: [false, false, false] },
  [],
  900,
  500,
);

const agent = (path: string | null): SpriteInput => ({
  threadId: ThreadId.make("root"),
  path,
  home: null,
  verb: "Edit",
  kind: "agent",
  parentThreadId: null,
  color: "rgb(10, 20, 30)",
  quiet: false,
  title: "Root",
  state: "working",
});

const subagent = (path: string | null): SpriteInput => ({
  threadId: ThreadId.make("sub"),
  path,
  home: null,
  verb: "Read",
  kind: "subagent",
  parentThreadId: ThreadId.make("root"),
  color: "rgb(10, 20, 30)",
  quiet: false,
  title: "Explore",
  state: "working",
});

const idle = { onHover: () => {}, onOpen: () => {} };

const spriteOf = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-testid="code-map-sprite"][data-thread-id="${id}"]`);
const translateX = (el: HTMLElement) => Number(el.style.transform.match(/-?[\d.]+/)![0]);
/** The file whose anchor the sprite is exactly on, or null while it travels between files. */
const standingOn = (el: HTMLElement) => {
  const [x, y] = [...el.style.transform.matchAll(/-?[\d.]+/g)].map(Number);
  for (const file of world.files.values()) {
    const anchorY = file.y + Math.min(file.h * 0.35, 12);
    if (Math.abs(x! - (file.x + file.w / 2)) < 0.01 && Math.abs(y! - anchorY) < 0.01) {
      return file.path;
    }
  }
  return null;
};

it("spawns a subagent at its parent in the parent's colour, walks it to its file, and walks it home when it finishes", async () => {
  const camera = createCameraStore({ x: 0, y: 0, scale: 1 });
  // Mounted empty so the shared beat starts under the fake clock.
  await using screen = await render(
    <CodeMapSprites sprites={[]} world={world} camera={camera} {...idle} />,
  );
  using _clock = fakeTimers();
  await screen.rerender(
    <CodeMapSprites sprites={[agent(A)]} world={world} camera={camera} {...idle} />,
  );
  const parentX = translateX(spriteOf(screen.container, "root")!);

  await screen.rerender(
    <CodeMapSprites sprites={[agent(A), subagent(B)]} world={world} camera={camera} {...idle} />,
  );
  const sub = spriteOf(screen.container, "sub")!;
  expect(sub.dataset.kind).toBe("subagent");
  expect(sub.firstElementChild!.getAttribute("style")).toContain("rgb(10, 20, 30)");
  expect(translateX(sub)).toBe(parentX);
  expect(sub.firstElementChild!.className).toContain("code-map-walk");

  vi.advanceTimersByTime(2000);
  const target = rectOf(world, B)!;
  expect(translateX(sub)).toBeGreaterThan(target.x);
  expect(translateX(sub)).toBeLessThan(target.x + target.w);
  expect(sub.querySelector('[data-testid="code-map-say"]')).toHaveTextContent("Read git.ts");
  // The working parent's beat is the one timer left: no walk frame, no fade.
  expect(vi.getTimerCount()).toBe(1);

  await screen.rerender(
    <CodeMapSprites sprites={[agent(A)]} world={world} camera={camera} {...idle} />,
  );
  expect(sub.firstElementChild!.className).toContain("code-map-walk");
  vi.advanceTimersByTime(2000);
  expect(translateX(sub)).toBe(parentX);
  expect(sub.style.opacity).toBe("0");
  vi.advanceTimersByTime(400);
  expect(spriteOf(screen.container, "sub")).toBeNull();
  // The working parent's beat is the one timer left: no walk frame, no fade.
  expect(vi.getTimerCount()).toBe(1);
});

it("keeps a sprite in place when its path goes null and stands a fileless subagent at its parent", async () => {
  const camera = createCameraStore({ x: 0, y: 0, scale: 1 });
  await using screen = await render(
    <CodeMapSprites sprites={[agent(A), subagent(null)]} world={world} camera={camera} {...idle} />,
  );
  const root = spriteOf(screen.container, "root")!;
  const placed = root.style.transform;
  expect(root.dataset.path).toBe(A);
  expect(spriteOf(screen.container, "sub")!.style.transform).toBe(placed);

  await screen.rerender(
    <CodeMapSprites
      sprites={[agent(null), subagent(null)]}
      world={world}
      camera={camera}
      {...idle}
    />,
  );
  expect(root.style.transform).toBe(placed);
  expect(root.dataset.path).toBe(A);
  expect(root.firstElementChild!.className).not.toContain("code-map-walk");

  // A new layout moves the parent, and the subagent with no file of its own stays beside it.
  await screen.rerender(
    <CodeMapSprites
      sprites={[agent(null), subagent(null)]}
      world={resized}
      camera={camera}
      {...idle}
    />,
  );
  const sub = spriteOf(screen.container, "sub")!;
  expect(root.style.transform).not.toBe(placed);
  expect(sub.style.visibility).toBe("");
  expect(sub.style.transform).toBe(root.style.transform);
});

it("repositions sprites when the camera moves without restarting a walk", async () => {
  const camera = createCameraStore({ x: 0, y: 0, scale: 1 });
  await using screen = await render(
    <CodeMapSprites sprites={[agent(A)]} world={world} camera={camera} {...idle} />,
  );
  const root = spriteOf(screen.container, "root")!;
  const x = translateX(root);
  camera.jumpTo({ x: 50, y: 0, scale: 2 });
  expect(translateX(root)).toBeCloseTo(x * 2 + 50, 2);
  expect(root.firstElementChild!.className).not.toContain("code-map-walk");
});

it("stands a thread with no file at the dock and walks it off once a file names its place", async () => {
  const camera = createCameraStore({ x: 0, y: 0, scale: 1 });
  await using screen = await render(
    <CodeMapSprites
      sprites={[{ ...agent(null), home: CODE_MAP_DOCK }]}
      world={world}
      camera={camera}
      {...idle}
    />,
  );
  const root = spriteOf(screen.container, "root")!;
  expect(root.style.visibility).toBe("");
  expect(translateX(root)).toBeLessThan(world.root.x + 60);

  await screen.rerender(
    <CodeMapSprites
      sprites={[{ ...agent(null), home: CODE_MAP_DOCK }]}
      world={resized}
      camera={camera}
      {...idle}
    />,
  );
  expect(root.style.visibility).toBe("");
  expect(translateX(root)).toBeLessThan(resized.root.x + 60);

  using _clock = fakeTimers();
  await screen.rerender(
    <CodeMapSprites
      sprites={[{ ...agent(A), home: CODE_MAP_DOCK }]}
      world={resized}
      camera={camera}
      {...idle}
    />,
  );
  vi.advanceTimersByTime(2000);
  expect(root.dataset.path).toBe(A);
  const target = rectOf(resized, A)!;
  expect(translateX(root)).toBeGreaterThan(target.x);
});

it("stands on every file of a fast burst in order and lands on the last one soon after it", async () => {
  const camera = createCameraStore({ x: 0, y: 0, scale: 1 });
  // Mounted empty so the shared beat starts under the fake clock.
  await using screen = await render(
    <CodeMapSprites sprites={[]} world={world} camera={camera} {...idle} />,
  );
  using _clock = fakeTimers();
  await screen.rerender(
    <CodeMapSprites sprites={[agent(A)]} world={world} camera={camera} {...idle} />,
  );
  const root = spriteOf(screen.container, "root")!;
  const stood: string[] = [];
  const said: string[] = [];
  const watch = (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 4) {
      vi.advanceTimersByTime(4);
      const path = standingOn(root);
      if (path !== null && stood.at(-1) !== path) stood.push(path);
      const text = root.querySelector('[data-testid="code-map-say"]')?.textContent;
      if (text && said.at(-1) !== text) said.push(text);
    }
  };

  for (const path of [B, C, A, B, C]) {
    await screen.rerender(
      <CodeMapSprites sprites={[agent(path)]} world={world} camera={camera} {...idle} />,
    );
    watch(100);
  }
  expect(root.dataset.look).toBeDefined();
  watch(500);

  expect(stood).toEqual([A, B, C, A, B, C]);
  expect(standingOn(root)).toBe(C);
  expect(said).toEqual(["Edit ChatView.tsx", "Edit index.css"]);
  expect(root.firstElementChild!.className).not.toContain("code-map-walk");
  expect(root.dataset.look).toBeUndefined();
  // The working sprite's beat is the one timer left: no walk frame.
  expect(vi.getTimerCount()).toBe(1);
});

const inState = (state: SpriteInput["state"]): SpriteInput => ({ ...agent(A), state });
const stopAnimations = (...elements: ReadonlyArray<Element>) => {
  for (const element of elements)
    for (const animation of element.getAnimations()) animation.cancel();
};

it("steps a thinking sprite's cloud and taps a working one on a beat that stops when all are idle", async () => {
  const camera = createCameraStore({ x: 0, y: 0, scale: 1 });
  await using screen = await render(
    <CodeMapSprites sprites={[inState("idle")]} world={world} camera={camera} {...idle} />,
  );
  using _clock = fakeTimers();
  const root = spriteOf(screen.container, "root")!;
  const body = root.firstElementChild!;
  const cloud = root.querySelector('[data-testid="code-map-cloud"]')!;
  const litDot = () =>
    [...cloud.querySelectorAll("i")].findIndex((dot) => dot.dataset.lit !== undefined);
  expect(getComputedStyle(body.querySelector("i")!).transform).toBe("matrix(1, 0, 0, 0.14, 0, 0)");
  expect(getComputedStyle(cloud).visibility).toBe("hidden");
  expect(vi.getTimerCount()).toBe(0);

  await screen.rerender(
    <CodeMapSprites sprites={[inState("thinking")]} world={world} camera={camera} {...idle} />,
  );
  expect(root.dataset.state).toBe("thinking");
  expect(vi.getTimerCount()).toBe(1);
  const lit = [litDot()];
  for (let beat = 0; beat < 3; beat++) {
    vi.advanceTimersByTime(500);
    lit.push(litDot());
  }
  expect(lit).toEqual([0, 1, 2, 0]);

  await screen.rerender(
    <CodeMapSprites sprites={[inState("working")]} world={world} camera={camera} {...idle} />,
  );
  expect(root.dataset.state).toBe("working");
  stopAnimations(body);
  vi.advanceTimersByTime(1000);
  expect(body.getAnimations()).toHaveLength(1);
  expect(litDot()).toBe(0);

  await screen.rerender(
    <CodeMapSprites sprites={[inState("idle")]} world={world} camera={camera} {...idle} />,
  );
  expect(root.dataset.state).toBe("idle");
  expect(root.dataset.done).toBeDefined();
  expect(vi.getTimerCount()).toBe(0);
});

it("hops a waiting sprite when it starts waiting and every 8 s, blinks it, and stops when it is idle", async () => {
  const camera = createCameraStore({ x: 0, y: 0, scale: 1 });
  await using screen = await render(
    <CodeMapSprites sprites={[inState("idle")]} world={world} camera={camera} {...idle} />,
  );
  using _clock = fakeTimers();
  const root = spriteOf(screen.container, "root")!;
  const body = root.firstElementChild!;
  const eye = body.querySelector("i")!;

  await screen.rerender(
    <CodeMapSprites sprites={[inState("waiting")]} world={world} camera={camera} {...idle} />,
  );
  expect(root.querySelector('[data-testid="code-map-waiting"]')).not.toBeNull();
  expect(body.getAnimations()).toHaveLength(1);

  stopAnimations(body, eye);
  vi.advanceTimersByTime(3500);
  expect(eye.getAnimations()).toHaveLength(0);
  vi.advanceTimersByTime(500);
  expect(eye.getAnimations()).toHaveLength(1);
  vi.advanceTimersByTime(3500);
  expect(body.getAnimations()).toHaveLength(0);
  vi.advanceTimersByTime(500);
  expect(body.getAnimations()).toHaveLength(1);

  await screen.rerender(
    <CodeMapSprites sprites={[inState("idle")]} world={world} camera={camera} {...idle} />,
  );
  expect(root.dataset.done).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
  stopAnimations(body);
  vi.advanceTimersByTime(8000);
  expect(body.getAnimations()).toHaveLength(0);
});

it("holds the thinking cloud back while files keep coming and shows it once they stop", async () => {
  const camera = createCameraStore({ x: 0, y: 0, scale: 1 });
  const thinkingAt = (path: string): SpriteInput => ({ ...agent(path), state: "thinking" });
  // Mounted idle so the shared beat starts under the fake clock.
  await using screen = await render(
    <CodeMapSprites sprites={[inState("idle")]} world={world} camera={camera} {...idle} />,
  );
  using _clock = fakeTimers();
  const root = spriteOf(screen.container, "root")!;

  for (const path of [B, C, A]) {
    await screen.rerender(
      <CodeMapSprites sprites={[thinkingAt(path)]} world={world} camera={camera} {...idle} />,
    );
    vi.advanceTimersByTime(400);
    expect(root.dataset.busy).toBeDefined();
  }

  vi.advanceTimersByTime(2500);
  expect(root.dataset.state).toBe("thinking");
  expect(root.dataset.busy).toBeUndefined();
});
