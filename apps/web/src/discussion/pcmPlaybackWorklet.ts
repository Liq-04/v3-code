import { PcmPlaybackQueue } from "./pcmPlaybackQueue";

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class PcmPlaybackProcessor extends AudioWorkletProcessor {
  private readonly queue = new PcmPlaybackQueue(sampleRate, (event) =>
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePorts do not accept a target origin
    this.port.postMessage(event),
  );

  constructor() {
    super();
    this.port.onmessage = ({ data }: MessageEvent<Int16Array | "flush">) => {
      if (data === "flush") this.queue.flush();
      else this.queue.push(data);
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    const channel = output?.[0];
    if (!output || !channel) return true;
    this.queue.render(channel);
    for (let c = 1; c < output.length; c++) output[c]!.set(channel);
    return true;
  }
}

registerProcessor("t3-pcm-playback", PcmPlaybackProcessor);
