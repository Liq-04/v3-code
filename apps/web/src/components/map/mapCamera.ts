export interface Camera {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface Flight {
  readonly from: Camera;
  readonly to: Camera;
  readonly startedAt: number;
  readonly durationMs: number;
}

const MAX_ZOOM = 400;
const RECT_MAX_ZOOM = 300;
const RECT_VIEW_FRACTION = 6;
const FLIGHT_MS = 700;

/** The world is laid out at the view's size, so the whole repo fits at the identity. */
export const HOME_CAMERA: Camera = { x: 0, y: 0, scale: 1 };

export const toWorld = (camera: Camera, sx: number, sy: number) => ({
  x: (sx - camera.x) / camera.scale,
  y: (sy - camera.y) / camera.scale,
});

export function fitCamera(world: Size, view: Size): Camera {
  const scale = Math.min(
    view.width / Math.max(world.width, 1),
    view.height / Math.max(world.height, 1),
  );
  return {
    scale,
    x: (view.width - world.width * scale) / 2,
    y: (view.height - world.height * scale) / 2,
  };
}

export function cameraForRect(rect: Rect, view: Size): Camera {
  const scale = Math.min(
    view.width / Math.max(rect.w * RECT_VIEW_FRACTION, 1e-6),
    view.height / Math.max(rect.h * RECT_VIEW_FRACTION, 1e-6),
    RECT_MAX_ZOOM,
  );
  return {
    scale,
    x: view.width / 2 - (rect.x + rect.w / 2) * scale,
    y: view.height / 2 - (rect.y + rect.h / 2) * scale,
  };
}

export function zoomAt(
  camera: Camera,
  screenAnchor: { readonly x: number; readonly y: number },
  factor: number,
  minZoom: number,
  maxZoom = MAX_ZOOM,
): Camera {
  const scale = Math.min(Math.max(camera.scale * factor, minZoom), maxZoom);
  return {
    scale,
    x: screenAnchor.x - ((screenAnchor.x - camera.x) * scale) / camera.scale,
    y: screenAnchor.y - ((screenAnchor.y - camera.y) * scale) / camera.scale,
  };
}

export const panBy = (camera: Camera, dx: number, dy: number): Camera => ({
  scale: camera.scale,
  x: camera.x + dx,
  y: camera.y + dy,
});

const easeInOutCubic = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
const geometricLerp = (from: number, to: number, t: number) => from * (to / from) ** t;

export function flightAt(flight: Flight, now: number): { camera: Camera; done: boolean } {
  const u = Math.min(1, Math.max(0, (now - flight.startedAt) / Math.max(flight.durationMs, 1)));
  if (u >= 1) return { camera: flight.to, done: true };
  const e = easeInOutCubic(u);
  const { from, to } = flight;
  return {
    camera: {
      x: from.x + (to.x - from.x) * e,
      y: from.y + (to.y - from.y) * e,
      scale: geometricLerp(from.scale, to.scale, e),
    },
    done: false,
  };
}

export interface CameraStore {
  readonly get: () => Camera;
  readonly jumpTo: (camera: Camera) => void;
  readonly fly: (to: Camera, durationMs?: number, now?: number) => void;
  readonly isFlying: () => boolean;
  readonly step: (now: number) => boolean;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createCameraStore(initial: Camera): CameraStore {
  let camera = initial;
  let flight: Flight | null = null;
  const listeners = new Set<() => void>();
  const publish = () => {
    for (const listener of listeners) listener();
  };
  return {
    get: () => camera,
    jumpTo: (next) => {
      flight = null;
      camera = next;
      publish();
    },
    fly: (to, durationMs = FLIGHT_MS, now = performance.now()) => {
      flight = { from: camera, to, startedAt: now, durationMs };
      publish();
    },
    isFlying: () => flight !== null,
    step: (now) => {
      if (!flight) return false;
      const at = flightAt(flight, now);
      camera = at.camera;
      if (at.done) flight = null;
      publish();
      return !at.done;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
