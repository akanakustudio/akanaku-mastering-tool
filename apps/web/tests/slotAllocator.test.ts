import { describe, expect, it } from "vitest";
import { SLOT_FRAMES, createChunkPool, slotOffset } from "../src/audio/layout";
import { SlotAllocator } from "../src/audio/slotAllocator";

describe("SlotAllocator", () => {
  it("publishes new data in a spare slot and keeps the old one until the epoch advances twice", () => {
    const pool = createChunkPool(3 * SLOT_FRAMES, 1);
    pool.table.set([0, 1, 2]);
    let epoch = 10;
    const alloc = new SlotAllocator(pool, () => epoch);

    expect(alloc.replace(1, (l, r) => (l.fill(0.5), r.fill(-0.5)))).toBe(true);
    expect(pool.table[1]).toBe(3);
    expect(pool.slots[slotOffset(3, 0)]).toBe(0.5);
    expect(pool.slots[slotOffset(3, 1) + SLOT_FRAMES - 1]).toBe(-0.5);

    // Old slot 1 may still be read by the worklet: no spare until two epochs have passed.
    epoch = 11;
    expect(alloc.replace(2, () => {})).toBe(false);
    epoch = 12;
    expect(alloc.replace(2, () => {})).toBe(true);
    expect(pool.table[2]).toBe(1);
  });

  it("never hands out a slot that the table still points to", () => {
    const pool = createChunkPool(8 * SLOT_FRAMES, 4);
    pool.table.set([0, 1, 2, 3, 4, 5, 6, 7]);
    let epoch = 0;
    const alloc = new SlotAllocator(pool, () => epoch);
    for (let i = 0; i < 500; i++) {
      epoch++;
      const sec = i % 8;
      alloc.replace(sec, () => {});
      const live = new Set(pool.table);
      expect(live.size).toBe(8);
    }
  });
});
