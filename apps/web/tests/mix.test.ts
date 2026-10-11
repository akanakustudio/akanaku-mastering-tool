import { describe, expect, it } from "vitest";
import { Mode } from "../src/audio/layout";
import { MODE_XFADE_FRAMES, equalGainTable, equalPowerTable, mixMode } from "../src/audio/mix";
import { afterSample, beforeSample } from "../src/audio/testSignals";

describe("equalPowerTable", () => {
  it("keeps fade-in² + fade-out² = 1 across the crossfade", () => {
    const t = equalPowerTable(MODE_XFADE_FRAMES);
    for (let i = 0; i <= MODE_XFADE_FRAMES; i++) {
      expect(t[i] ** 2 + t[MODE_XFADE_FRAMES - i] ** 2).toBeCloseTo(1, 6);
    }
    expect(t[0]).toBe(0);
    expect(t[MODE_XFADE_FRAMES]).toBeCloseTo(1, 7);
  });
});

describe("equalGainTable", () => {
  it("keeps fade-in + fade-out = 1 and starts/ends with zero slope", () => {
    const t = equalGainTable(MODE_XFADE_FRAMES);
    expect(t[0]).toBe(0);
    expect(t[MODE_XFADE_FRAMES]).toBeCloseTo(1, 7);
    expect(t[1] - t[0]).toBeLessThan(1e-4);
    expect(t[MODE_XFADE_FRAMES] - t[MODE_XFADE_FRAMES - 1]).toBeLessThan(1e-4);
  });
});

describe("mixMode", () => {
  it("implements the output formulas of detailed design 12.3", () => {
    expect(mixMode(Mode.BEFORE, 0.5, 0.9, 2, 3)).toBe(1);
    expect(mixMode(Mode.AFTER, 0.5, 0.9, 2, 3)).toBe(0.9);
    expect(mixMode(Mode.DELTA, 0.5, 0.9, 2, 3)).toBeCloseTo(0.9 - 1.5);
  });
});

// T-PLAY-01: a Before→After switch must not create a step larger than 1.1× the signals' own steps.
describe("T-PLAY-01 mode crossfade discontinuity", () => {
  it.each([
    ["Before→After", Mode.BEFORE, Mode.AFTER],
    ["After→Delta", Mode.AFTER, Mode.DELTA],
    ["Delta→Before", Mode.DELTA, Mode.BEFORE],
  ])("%s", (_, from, to) => {
    const sr = 48_000;
    const fade = equalGainTable(MODE_XFADE_FRAMES);
    const gB = 1.8;
    const out = (n: number, m: number) => mixMode(m, beforeSample(n, 0, sr), afterSample(n, 0, sr), gB, gB);

    let steadyMax = 0;
    for (let n = 1; n < sr; n++) {
      for (const m of [from, to]) steadyMax = Math.max(steadyMax, Math.abs(out(n, m) - out(n - 1, m)));
    }

    // Switch at many phases of the signal; the crossfade starts on the first sample of the switch.
    let switchMax = 0;
    for (let start = 1000; start < sr; start += 997) {
      let prev = out(start - 1, from);
      for (let k = 0; k < MODE_XFADE_FRAMES; k++) {
        const n = start + k;
        const y = fade[k] * out(n, to) + (1 - fade[k]) * out(n, from);
        switchMax = Math.max(switchMax, Math.abs(y - prev));
        prev = y;
      }
    }
    expect(switchMax / steadyMax).toBeLessThanOrEqual(1.1);
  });
});

// Why the mode switch does not use equal-power: on correlated material it swells the level.
describe("equal-power on correlated signals", () => {
  it("bumps the level by about +3 dB at the midpoint", () => {
    const t = equalPowerTable(MODE_XFADE_FRAMES);
    const mid = MODE_XFADE_FRAMES / 2;
    expect(20 * Math.log10(t[mid] + t[MODE_XFADE_FRAMES - mid])).toBeCloseTo(3.01, 1);
  });
});
