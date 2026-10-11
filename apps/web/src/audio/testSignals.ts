// Deterministic P0 test signals. The worklet recomputes `afterSample` to verify that every
// After sample it reads is intact, so slot swaps that corrupt even one sample are caught.

const TAU = 2 * Math.PI;

/** "Unprocessed" signal: two detuned tones with a slow tremolo, about -12 dBFS. */
export function beforeSample(n: number, ch: number, sr: number): number {
  const t = n / sr;
  const trem = 0.75 + 0.25 * Math.sin(TAU * 0.5 * t);
  return trem * (0.2 * Math.sin(TAU * 220 * t) + 0.12 * Math.sin(TAU * (330.5 + ch) * t));
}

/** "Processed" signal: louder and saturated, like a limiter's output. */
export function afterSample(n: number, ch: number, sr: number): number {
  return Math.fround(0.9 * Math.tanh(3 * beforeSample(n, ch, sr)));
}

export function renderTestSignal(frames: number, sr: number, fn: (n: number, ch: number, sr: number) => number) {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let n = 0; n < frames; n++) {
    left[n] = fn(n, 0, sr);
    right[n] = fn(n, 1, sr);
  }
  return { left, right };
}
