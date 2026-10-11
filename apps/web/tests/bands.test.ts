import { describe, expect, it } from "vitest";
import { THIRD_OCTAVE, ballistics, bandLevels } from "../src/features/meters/bands";

describe("bandLevels", () => {
  it("puts a tone's energy in its 1/3-octave band", () => {
    const n = 4096; // frequencyBinCount for fftSize 8192 at 48 kHz: 5.86 Hz per bin
    const bins = new Float32Array(n).fill(-200);
    const k = Math.round(1000 / (24_000 / n));
    bins[k] = -20;
    const out = new Float32Array(THIRD_OCTAVE.length);
    bandLevels(bins, 48_000, THIRD_OCTAVE, 3, out);
    const i1k = THIRD_OCTAVE.indexOf(1000);
    expect(out[i1k]).toBeCloseTo(-20, 5);
    expect(out[i1k - 1]).toBe(-200);
    expect(out[i1k + 1]).toBe(-200);
  });

  it("sums the power of the bins in a band", () => {
    const bins = new Float32Array(4096).fill(-200);
    const k = Math.round(1000 / (24_000 / 4096));
    bins[k] = -20;
    bins[k + 1] = -20;
    const out = new Float32Array(THIRD_OCTAVE.length);
    bandLevels(bins, 48_000, THIRD_OCTAVE, 3, out);
    expect(out[THIRD_OCTAVE.indexOf(1000)]).toBeCloseTo(-20 + 10 * Math.log10(2), 4);
  });
});

describe("ballistics", () => {
  it("rises at once, falls slowly, and holds the peak before it falls", () => {
    const level = new Float32Array([-10]);
    const shown = new Float32Array([-70]);
    const peak = new Float32Array([-70]);
    const age = new Float32Array(1);
    ballistics(level, shown, peak, age, 0.016);
    expect(shown[0]).toBe(-10);
    expect(peak[0]).toBe(-10);
    level[0] = -60;
    ballistics(level, shown, peak, age, 0.5);
    expect(shown[0]).toBeCloseTo(-22); // fell 24 dB/s × 0.5 s
    expect(peak[0]).toBe(-10); // still holding
    ballistics(level, shown, peak, age, 0.5);
    expect(peak[0]).toBeLessThan(-10); // hold over, falling
  });
});
