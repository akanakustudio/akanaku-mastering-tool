import { SLOT_FRAMES, slotOffset, type ChunkPool } from "./layout";

/**
 * Replaces one second of a chunk pool without the worklet ever seeing a half-written slot
 * (detailed design 12.5): write into a spare slot, publish it with Atomics.store, and only
 * recycle the old slot after the worklet's epoch has advanced twice.
 */
export class SlotAllocator {
  private free: number[] = [];
  private retired: { slot: number; epoch: number }[] = [];

  constructor(
    private pool: ChunkPool,
    private epoch: () => number,
  ) {
    for (let s = pool.seconds; s < pool.slotCount; s++) this.free.push(s);
  }

  get spareCount() {
    return this.free.length;
  }

  /**
   * Publishes new contents for second `sec`. `write` fills the new slot's left/right channels.
   * Returns false if no spare slot is available yet (the caller retries later).
   */
  replace(sec: number, write: (left: Float32Array, right: Float32Array) => void): boolean {
    this.reclaim();
    const slot = this.free.pop();
    if (slot === undefined) return false;
    const left = this.pool.slots.subarray(slotOffset(slot, 0), slotOffset(slot, 0) + SLOT_FRAMES);
    const right = this.pool.slots.subarray(slotOffset(slot, 1), slotOffset(slot, 1) + SLOT_FRAMES);
    write(left, right);
    const old = Atomics.exchange(this.pool.table, sec, slot);
    this.retired.push({ slot: old, epoch: this.epoch() });
    return true;
  }

  private reclaim() {
    const now = this.epoch();
    this.retired = this.retired.filter((r) => {
      if (now - r.epoch < 2) return true;
      this.free.push(r.slot);
      return false;
    });
  }
}
