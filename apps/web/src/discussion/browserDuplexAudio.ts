import type { DuplexAudio } from "@t3tools/client-runtime/discussion";

import captureWorkletUrl from "../speech/pcmWorklet.ts?worker&url";
import playbackWorkletUrl from "./pcmPlaybackWorklet.ts?worker&url";

const FRAME_SAMPLES = 1_600;

function toFrame(pcm: Float32Array): { pcm: Int16Array<ArrayBuffer>; level: number } {
  const frame = new Int16Array(pcm.length);
  let energy = 0;
  for (let i = 0; i < pcm.length; i++) {
    const sample = Math.max(-1, Math.min(1, pcm[i]!));
    energy += sample * sample;
    frame[i] = Math.round(sample * 0x7fff);
  }
  return { pcm: frame, level: pcm.length === 0 ? 0 : Math.sqrt(energy / pcm.length) };
}

/**
 * One AudioContext for the microphone and the agent's voice. Call it inside the click or key
 * press that starts the call, so the browser lets the context play.
 */
export function createBrowserDuplexAudio(input: { readonly microphoneId: string }): DuplexAudio {
  const context = new AudioContext();
  void context.resume();
  let stream: MediaStream | undefined;
  let capture: AudioWorkletNode | undefined;
  let playback: AudioWorkletNode | undefined;
  let playing = false;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    capture?.disconnect();
    capture?.port.close();
    playback?.disconnect();
    playback?.port.close();
    stream?.getTracks().forEach((track) => track.stop());
    void context.close();
  };

  return {
    start: async ({ onFrame, onPlaybackLevel, onError }) => {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
        throw new Error(
          "The microphone needs HTTPS. Open this environment over HTTPS or in the desktop app.",
        );
      const media = await navigator.mediaDevices.getUserMedia({
        audio: {
          // The agent's voice plays from the same device; headphones remove the rest.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          ...(input.microphoneId ? { deviceId: { exact: input.microphoneId } } : {}),
        },
      });
      if (closed) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = media;
      await Promise.all([
        context.audioWorklet.addModule(captureWorkletUrl),
        context.audioWorklet.addModule(playbackWorkletUrl),
      ]);
      if (closed) return;
      const captureNode = new AudioWorkletNode(context, "t3-pcm-capture", {
        channelCount: 1,
        processorOptions: { chunkSamples: FRAME_SAMPLES, maxSamples: 0 },
      });
      capture = captureNode;
      captureNode.port.onmessage = ({ data }: MessageEvent<Float32Array | number | string>) => {
        if (!(data instanceof Float32Array)) return;
        const frame = toFrame(data);
        onFrame(frame.pcm, frame.level);
      };
      captureNode.onprocessorerror = () => onError("Microphone processing failed.");
      for (const track of media.getTracks())
        track.addEventListener("ended", () => onError("The microphone disconnected."), {
          once: true,
        });
      context.createMediaStreamSource(media).connect(captureNode);
      // The capture processor emits silence, which keeps the graph running.
      captureNode.connect(context.destination);

      const playbackNode = new AudioWorkletNode(context, "t3-pcm-playback", {
        numberOfInputs: 0,
        outputChannelCount: [2],
      });
      playback = playbackNode;
      playbackNode.port.onmessage = ({ data }: MessageEvent<number | "playing" | "idle">) => {
        if (data === "playing" || data === "idle") {
          playing = data === "playing";
          if (!playing) onPlaybackLevel(0);
          return;
        }
        onPlaybackLevel(data);
      };
      playbackNode.connect(context.destination);
      await context.resume();
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePorts do not accept a target origin
      captureNode.port.postMessage("start");
    },
    play: (pcm) => {
      playback?.port.postMessage(pcm, [pcm.buffer]);
    },
    flush: () => {
      playing = false;
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePorts do not accept a target origin
      playback?.port.postMessage("flush");
    },
    isPlaying: () => playing,
    close,
  };
}
