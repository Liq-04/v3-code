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
  await using screen = await render(
    <CodeMapSprites sprites={[agent(A)]} world={world} camera={camera} {...idle} />,
  );
  using _clock = fakeTimers();
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
  expect(vi.getTimerCount()).toBe(0);

  await screen.rerender(
    <CodeMapSprites sprites={[agent(A)]} world={world} camera={camera} {...idle} />,
  );
  expect(sub.firstElementChild!.className).toContain("code-map-walk");
  vi.advanceTimersByTime(2000);
  expect(translateX(sub)).toBe(parentX);
  expect(sub.style.opacity).toBe("0");
  vi.advanceTimersByTime(400);
  expect(spriteOf(screen.container, "sub")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
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

  using _clock = fakeTimers();
  await screen.rerender(
    <CodeMapSprites
      sprites={[{ ...agent(A), home: CODE_MAP_DOCK }]}
      world={world}
      camera={camera}
      {...idle}
    />,
  );
  vi.advanceTimersByTime(2000);
  expect(root.dataset.path).toBe(A);
  const target = rectOf(world, A)!;
  expect(translateX(root)).toBeGreaterThan(target.x);
});

it("stands on every file of a fast burst in order and lands on the last one soon after it", async () => {
  const camera = createCameraStore({ x: 0, y: 0, scale: 1 });
  await using screen = await render(
    <CodeMapSprites sprites={[agent(A)]} world={world} camera={camera} {...idle} />,
  );
  using _clock = fakeTimers();
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
  watch(500);

  expect(stood).toEqual([A, B, C, A, B, C]);
  expect(standingOn(root)).toBe(C);
  expect(said).toEqual(["Edit ChatView.tsx", "Edit index.css"]);
  expect(root.firstElementChild!.className).not.toContain("code-map-walk");
  expect(vi.getTimerCount()).toBe(0);
});
