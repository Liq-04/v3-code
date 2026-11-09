const SOURCE_RATE = 24_000;
/** Buffered before a reply starts, so one late network chunk does not cut a word. */
const PREBUFFER_SAMPLES = SOURCE_RATE * 0.08;
/** A reply shorter than the prebuffer still plays once nothing more arrives. */
const PREBUFFER_WAIT_SECONDS = 0.1;

export type PcmPlaybackEvent = "playing" | "idle" | number;

/**
 * Plays 24 kHz Int16 chunks back to back at the output rate; `flush` drops everything at once, for
 * a user cutting in. Reports "playing" and "idle" on changes and the output level about 20 times a
 * second while playing.
 */
export class PcmPlaybackQueue {
  private queue: Float32Array[] = [];
  private queued = 0;
  private offset = 0;
  private position = 0;
  private playing = false;
  private waited = 0;
  private levelEnergy = 0;
  private levelSamples = 0;

  constructor(
    private readonly sampleRate: number,
    private readonly report: (event: PcmPlaybackEvent) => void,
  ) {}

  push(pcm: Int16Array) {
    const chunk = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) chunk[i] = pcm[i]! / 0x8000;
    this.queue.push(chunk);
    this.queued += chunk.length;
  }

  flush() {
    this.queue = [];
    this.queued = 0;
    this.offset = 0;
    this.position = 0;
    this.setPlaying(false);
  }

  private setPlaying(playing: boolean) {
    if (playing === this.playing) return;
    this.playing = playing;
    this.waited = 0;
    this.levelEnergy = 0;
    this.levelSamples = 0;
    this.report(playing ? "playing" : "idle");
  }

  /** The source sample at `index` past the read head, or null past the end of the queue. */
  private sample(index: number): number | null {
    let chunkIndex = 0;
    let at = this.offset + index;
    while (chunkIndex < this.queue.length && at >= this.queue[chunkIndex]!.length) {
      at -= this.queue[chunkIndex]!.length;
      chunkIndex++;
    }
    return chunkIndex < this.queue.length ? this.queue[chunkIndex]![at]! : null;
  }

  private advance(samples: number) {
    this.offset += samples;
    this.queued -= samples;
    while (this.queue.length > 0 && this.offset >= this.queue[0]!.length) {
      this.offset -= this.queue[0]!.length;
      this.queue.shift();
    }
  }

  /** Fills `channel`, which arrives silent, with what is due. */
  render(channel: Float32Array) {
    if (!this.playing && this.queued > 0) {
      this.waited += channel.length / this.sampleRate;
      if (this.queued >= PREBUFFER_SAMPLES || this.waited >= PREBUFFER_WAIT_SECONDS)
        this.setPlaying(true);
    }
    if (!this.playing) return;
    const step = SOURCE_RATE / this.sampleRate;
    for (let i = 0; i < channel.length; i++) {
      const whole = Math.floor(this.position);
      const current = this.sample(whole);
      if (current === null) {
        this.advance(this.queued);
        this.position = 0;
        this.setPlaying(false);
        break;
      }
      const next = this.sample(whole + 1) ?? current;
      const value = current + (next - current) * (this.position - whole);
      channel[i] = value;
      this.levelEnergy += value * value;
      this.levelSamples++;
      this.position += step;
      const consumed = Math.floor(this.position);
      if (consumed > 0) {
        this.advance(consumed);
        this.position -= consumed;
      }
    }
    if (this.levelSamples >= this.sampleRate / 20) {
      this.report(Math.min(1, Math.sqrt(this.levelEnergy / this.levelSamples) * 4));
      this.levelEnergy = 0;
      this.levelSamples = 0;
    }
  }
}
