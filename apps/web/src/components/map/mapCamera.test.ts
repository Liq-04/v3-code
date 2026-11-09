import { describe, expect, it } from "vite-plus/test";

import {
  cameraForRect,
  createCameraStore,
  fitCamera,
  flightAt,
  panBy,
  toWorld,
  zoomAt,
  type Camera,
} from "./mapCamera";

const view = { width: 800, height: 600 };

describe("zoomAt", () => {
  it("keeps the world point under the cursor fixed", () => {
    const camera: Camera = { x: 37, y: -12, scale: 1.5 };
    const cursor = { x: 210, y: 140 };
    const before = toWorld(camera, cursor.x, cursor.y);
    const zoomed = zoomAt(camera, cursor, 2.7, 0.1);
    const after = toWorld(zoomed, cursor.x, cursor.y);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    expect(zoomed.scale).toBeCloseTo(1.5 * 2.7);
  });

  it("clamps the zoom to the given range", () => {
    const camera: Camera = { x: 0, y: 0, scale: 1 };
    expect(zoomAt(camera, { x: 0, y: 0 }, 0.01, 0.8).scale).toBe(0.8);
    expect(zoomAt(camera, { x: 0, y: 0 }, 1e9, 0.8, 400).scale).toBe(400);
  });
});

describe("fitCamera and cameraForRect", () => {
  it("is the identity when the world is the size of the view", () => {
    expect(fitCamera(view, view)).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it("centres a world that is a different shape than the view", () => {
    const camera = fitCamera({ width: 400, height: 600 }, view);
    expect(camera.scale).toBe(1);
    expect(camera.x).toBe(200);
    expect(camera.y).toBe(0);
  });

  it("centres the rect in the view", () => {
    const rect = { x: 100, y: 50, w: 20, h: 10 };
    const camera = cameraForRect(rect, view);
    const centre = toWorld(camera, view.width / 2, view.height / 2);
    expect(centre.x).toBeCloseTo(110);
    expect(centre.y).toBeCloseTo(55);
    expect(camera.scale).toBeCloseTo(Math.min(800 / 120, 600 / 60));
  });

  it("pans by screen pixels without changing the zoom", () => {
    expect(panBy({ x: 1, y: 2, scale: 3 }, 10, -5)).toEqual({ x: 11, y: -3, scale: 3 });
  });
});

describe("flightAt", () => {
  const from: Camera = { x: 0, y: 0, scale: 1 };
  const to: Camera = { x: -500, y: -300, scale: 16 };
  const flight = { from, to, startedAt: 1000, durationMs: 700 };

  it("starts at the origin camera and ends exactly at the target", () => {
    expect(flightAt(flight, 1000)).toEqual({ camera: from, done: false });
    expect(flightAt(flight, 1700)).toEqual({ camera: to, done: true });
    expect(flightAt(flight, 5000)).toEqual({ camera: to, done: true });
  });

  it("interpolates the zoom geometrically", () => {
    const { camera } = flightAt(flight, 1350);
    expect(camera.scale).toBeCloseTo(4);
    expect(camera.x).toBeCloseTo(-250);
  });
});

describe("createCameraStore", () => {
  it("steps a flight until it lands and tells listeners about every change", () => {
    const store = createCameraStore({ x: 0, y: 0, scale: 1 });
    let changes = 0;
    store.subscribe(() => changes++);
    store.fly({ x: -100, y: 0, scale: 2 }, 100, 0);
    expect(store.isFlying()).toBe(true);
    expect(store.step(50)).toBe(true);
    expect(store.get().scale).toBeCloseTo(Math.SQRT2);
    expect(store.step(100)).toBe(false);
    expect(store.get()).toEqual({ x: -100, y: 0, scale: 2 });
    expect(store.isFlying()).toBe(false);
    expect(store.step(200)).toBe(false);
    expect(changes).toBe(3);
  });

  it("cancels a flight when the camera jumps", () => {
    const store = createCameraStore({ x: 0, y: 0, scale: 1 });
    store.fly({ x: -100, y: 0, scale: 2 }, 700, 0);
    store.jumpTo({ x: 5, y: 5, scale: 1 });
    expect(store.isFlying()).toBe(false);
    expect(store.step(350)).toBe(false);
    expect(store.get()).toEqual({ x: 5, y: 5, scale: 1 });
  });
});
