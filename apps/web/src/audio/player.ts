// Main-thread controller for the player worklet (detailed design 12).
import workletUrl from "./player.worklet.ts?worker&url";
import { CTL_LENGTH, Ctl, F32, F32_LENGTH, Mode, SAMPLE_RATE, SLOT_FRAMES, SPARE_SLOTS, createChunkPool, fillPool, type ChunkPool, type ModeValue } from "./layout";
import type { PlayerOptions } from "./player.worklet";
import { SlotAllocator } from "./slotAllocator";

type Stereo = { left: Float32Array; right: Float32Array };

export class Player {
  readonly ctl = new Int32Array(new SharedArrayBuffer(CTL_LENGTH * 4));
  readonly f32 = new Float32Array(new SharedArrayBuffer(F32_LENGTH * 4));
  readonly before: ChunkPool;
  readonly after: ChunkPool;
  readonly afterSlots: SlotAllocator;
  private ctx: AudioContext | null = null;

  constructor(before: Stereo, after: Stereo) {
    const frames = before.left.length;
    this.before = createChunkPool(frames);
    // Enough spare slots to replace the whole After track after a full render.
    this.after = createChunkPool(frames, Math.ceil(frames / SLOT_FRAMES) + SPARE_SLOTS);
    fillPool(this.before, before.left, before.right);
    fillPool(this.after, after.left, after.right);
    this.ctl[Ctl.TOTAL_FRAMES] = frames;
    this.ctl[Ctl.MODE] = Mode.AFTER;
    this.ctl[Ctl.SEEK] = -1;
    this.ctl[Ctl.LOOP_START] = -1;
    this.ctl[Ctl.LOOP_END] = -1;
    this.f32[F32.GAIN_BEFORE] = 1;
    this.f32[F32.GAIN_DELTA] = 1;
    this.afterSlots = new SlotAllocator(this.after, () => Atomics.load(this.ctl, Ctl.EPOCH));
  }

  get context() {
    return this.ctx;
  }

  get totalFrames() {
    return this.ctl[Ctl.TOTAL_FRAMES];
  }

  /** Must be called from a user gesture (autoplay policy, detailed design 12.1). */
  async start() {
    if (this.ctx) return this.ctx.resume();
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
    await ctx.audioWorklet.addModule(workletUrl);
    const processorOptions: PlayerOptions = {
      ctl: this.ctl,
      f32: this.f32,
      before: { slots: this.before.slots, table: this.before.table },
      after: { slots: this.after.slots, table: this.after.table },
    };
    const node = new AudioWorkletNode(ctx, "akanaku-player", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions,
    });
    node.connect(ctx.destination);
    this.ctx = ctx;
  }

  play() {
    if (Atomics.load(this.ctl, Ctl.POSITION) >= this.totalFrames && Atomics.load(this.ctl, Ctl.LOOP_START) < 0) this.seek(0);
    Atomics.store(this.ctl, Ctl.PLAYING, 1);
  }
  pause() {
    Atomics.store(this.ctl, Ctl.PLAYING, 0);
  }
  get playing() {
    return Atomics.load(this.ctl, Ctl.PLAYING) === 1;
  }
  get position() {
    return Atomics.load(this.ctl, Ctl.POSITION);
  }

  seek(frame: number) {
    Atomics.store(this.ctl, Ctl.SEEK, Math.max(0, Math.min(frame, this.totalFrames - 1)));
  }

  setMode(mode: ModeValue) {
    Atomics.add(this.ctl, Ctl.MODE_SEQ, 1);
    Atomics.store(this.ctl, Ctl.MODE, mode);
  }
  get mode() {
    return Atomics.load(this.ctl, Ctl.MODE) as ModeValue;
  }

  setLoop(range: [number, number] | null) {
    Atomics.store(this.ctl, Ctl.LOOP_END, range ? Math.min(range[1], this.totalFrames) : -1);
    Atomics.store(this.ctl, Ctl.LOOP_START, range ? range[0] : -1);
  }

  setMono(on: boolean) {
    Atomics.store(this.ctl, Ctl.MONO, on ? 1 : 0);
  }

  /** Loudness Match / Delta gain-match gains (detailed design 12.3), linear. */
  setGains(before: number, delta: number) {
    this.f32[F32.GAIN_BEFORE] = before;
    this.f32[F32.GAIN_DELTA] = delta;
  }

  /**
   * Swaps in a new After render second by second while playing (detailed design 12.5).
   * The new data is the same length as the old one.
   */
  async replaceAfter(after: Stereo) {
    for (let sec = 0; sec < this.after.seconds; sec++) {
      const from = sec * SLOT_FRAMES;
      const to = Math.min(from + SLOT_FRAMES, after.left.length);
      const write = (l: Float32Array, r: Float32Array) => {
        l.set(after.left.subarray(from, to));
        r.set(after.right.subarray(from, to));
        if (to - from < SLOT_FRAMES) {
          l.fill(0, to - from);
          r.fill(0, to - from);
        }
      };
      while (!this.afterSlots.replace(sec, write)) await new Promise((r) => setTimeout(r, 5));
    }
  }

  async close() {
    this.pause();
    await this.ctx?.close();
    this.ctx = null;
  }
}
