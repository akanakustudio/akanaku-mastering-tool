import { describe, expect, it } from "vitest";
import { applyFades } from "../src/features/album/fade";

describe("applyFades", () => {
  it("fades in from silence and out to silence with a smooth curve", () => {
    const n = 48_000;
    const l = new Float32Array(n).fill(1);
    const r = new Float32Array(n).fill(-1);
    applyFades(l, r, 0.25, 0.5, 48_000);
    expect(l[0]).toBe(0);
    expect(l[6000]).toBeCloseTo(0.5, 2); // halfway through the 0.25 s fade-in
    expect(l[12_000]).toBe(1);
    expect(l[n - 1]).toBeCloseTo(0, 6);
    expect(r[n - 12_000]).toBeCloseTo(-0.5, 2); // halfway through the 0.5 s fade-out
    for (let i = 1; i < 12_000; i++) expect(l[i]).toBeGreaterThanOrEqual(l[i - 1]);
  });

  it("leaves audio untouched without fades", () => {
    const l = new Float32Array([0.1, 0.2, 0.3]);
    applyFades(l, l, 0, 0, 48_000);
    expect(Array.from(l)).toEqual([0.1, 0.2, 0.3].map(Math.fround));
  });
});
