import { expect, it, vi } from "vite-plus/test";

import { PcmPlaybackQueue, type PcmPlaybackEvent } from "./pcmPlaybackQueue";

it("plays chunks back to back and drops them at once on flush", () => {
  const report = vi.fn<(event: PcmPlaybackEvent) => void>();
  // The source rate, so output samples are the input samples.
  const player = new PcmPlaybackQueue(24_000, report);
  const render = () => {
    const block = new Float32Array(128);
    player.render(block);
    return block;
  };

  player.push(new Int16Array(1_000).fill(0x4000));
  player.push(new Int16Array(1_000).fill(-0x4000));
  const played = Array.from({ length: 16 }, render).flatMap((block) => [...block]);
  expect(played.slice(0, 1_000).every((sample) => sample === 0.5)).toBe(true);
  expect(played.slice(1_000, 2_000).every((sample) => sample === -0.5)).toBe(true);
  expect(played.slice(2_000).every((sample) => sample === 0)).toBe(true);
  expect(report).toHaveBeenCalledWith("playing");
  expect(report).toHaveBeenCalledWith("idle");

  player.push(new Int16Array(4_000).fill(0x4000));
  expect(render().some((sample) => sample !== 0)).toBe(true);
  player.flush();
  expect(render().every((sample) => sample === 0)).toBe(true);
  expect(report).toHaveBeenLastCalledWith("idle");
});
