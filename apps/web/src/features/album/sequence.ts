// Continuous album playback (detailed design 12.6, simplified): one player whose sources are
// swapped track by track, with the next track preloaded from OPFS while the current one plays.
// Keeping one AudioContext avoids Safari's need for a new user gesture per track.
import { Mode } from "../../audio/layout";
import { Player } from "../../audio/player";
import type { WorkerClient } from "../../orchestrator/workerClient";
import type { DspMethods, StereoData } from "../../workers/protocol";
import { applyFades } from "./fade";

const SR = 48_000;
const PRELOAD_BEFORE_END_S = 20;

export type SeqItem = { key: string; frames: number; gapAfterSec: number; fadeInSec: number; fadeOutSec: number };
export type SeqState = { playing: boolean; index: number; position: number; inGap: boolean };

export class AlbumSequence {
  private player: Player;
  private index = 0;
  private stopped = true;
  private inGap = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private next: { index: number; data: Promise<StereoData> } | null = null;
  private gen = 0;

  constructor(
    private worker: WorkerClient<DspMethods>,
    private items: SeqItem[],
    private onState: (s: SeqState) => void,
  ) {
    const empty = new Float32Array(0);
    this.player = new Player({ left: empty, right: empty }, { left: empty, right: empty }, Math.max(...items.map((i) => i.frames)));
  }

  /** Call from a click handler: the AudioContext is created before anything is awaited. */
  async playFrom(index: number, frame: number) {
    const gen = ++this.gen;
    const started = this.player.start();
    this.player.pause();
    this.stopped = false;
    this.inGap = false;
    const data = await this.fetch(index);
    await started;
    if (gen !== this.gen) return;
    await new Promise((r) => setTimeout(r, 20)); // let the pause fade finish
    this.player.load(data, data);
    this.player.setMode(Mode.AFTER);
    this.player.seek(Math.max(0, Math.min(frame, this.items[index].frames - 1)));
    this.player.play();
    this.index = index;
    this.next = null;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(gen), 50);
  }

  get analyser() {
    return this.player.analyser;
  }

    stop() {
    this.gen++;
    this.stopped = true;
    this.inGap = false;
    clearInterval(this.timer);
    this.player.pause();
    this.emit();
  }

  async close() {
    this.stop();
    await this.player.close();
  }

  private fetch(index: number): Promise<StereoData> {
    const it = this.items[index];
    return this.worker.call("readStored", { key: it.key }).then((d) => {
      applyFades(d.left, d.right, it.fadeInSec, it.fadeOutSec, SR);
      return d;
    });
  }

  private emit() {
    this.onState({ playing: !this.stopped, index: this.index, position: this.player.position, inGap: this.inGap });
  }

  private tick(gen: number) {
    if (gen !== this.gen || this.stopped || this.inGap) return;
    const it = this.items[this.index];
    const pos = this.player.position;
    const last = this.index + 1 >= this.items.length;
    if (!last && !this.next && it.frames - pos < PRELOAD_BEFORE_END_S * SR) {
      this.next = { index: this.index + 1, data: this.fetch(this.index + 1) };
    }
    this.emit();
    if (this.player.playing || pos < it.frames - 1) return;
    // The track ended.
    if (last) {
      this.stop();
      return;
    }
    this.inGap = true;
    const next = this.next ?? { index: this.index + 1, data: this.fetch(this.index + 1) };
    this.emit();
    setTimeout(async () => {
      const data = await next.data;
      if (gen !== this.gen) return;
      this.player.load(data, data);
      this.player.play();
      this.index = next.index;
      this.next = null;
      this.inGap = false;
      this.emit();
    }, it.gapAfterSec * 1000);
  }
}
