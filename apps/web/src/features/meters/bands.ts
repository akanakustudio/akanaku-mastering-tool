// Band levels from AnalyserNode data for the spectrum display (pure; unit tested).

/** ISO 1/3-octave centre frequencies 20 Hz - 20 kHz (31 bands) and octave centres (10 bands). */
export const THIRD_OCTAVE = [20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000];
export const OCTAVE = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/**
 * Sums the power of the FFT bins inside each band (`fraction`: 3 for 1/3 octave, 1 for octave)
 * and returns dB. `binsDb` is AnalyserNode.getFloatFrequencyData output.
 */
export function bandLevels(binsDb: Float32Array, sampleRate: number, centres: number[], fraction: number, out: Float32Array) {
  const binHz = sampleRate / 2 / binsDb.length;
  const half = 2 ** (1 / (2 * fraction));
  for (let b = 0; b < centres.length; b++) {
    const lo = centres[b] / half;
    const hi = Math.min(centres[b] * half, sampleRate / 2);
    let k0 = Math.max(1, Math.floor(lo / binHz));
    const k1 = Math.min(binsDb.length - 1, Math.ceil(hi / binHz));
    if (k0 > k1) k0 = k1;
    let p = 0;
    for (let k = k0; k <= k1; k++) {
      const v = binsDb[k];
      if (v > -200) p += 10 ** (v / 10);
    }
    out[b] = p > 0 ? 10 * Math.log10(p) : -200;
  }
}

/** Ballistics: rises immediately, falls at `fallDbPerSec`; peaks hold `holdSec` then fall. */
export function ballistics(
  level: Float32Array,
  shown: Float32Array,
  peak: Float32Array,
  peakAge: Float32Array,
  dt: number,
  fallDbPerSec = 24,
  holdSec = 0.8,
  peakFallDbPerSec = 18,
) {
  for (let b = 0; b < level.length; b++) {
    shown[b] = level[b] >= shown[b] ? level[b] : Math.max(level[b], shown[b] - fallDbPerSec * dt);
    if (shown[b] >= peak[b]) {
      peak[b] = shown[b];
      peakAge[b] = 0;
    } else {
      peakAge[b] += dt;
      if (peakAge[b] > holdSec) peak[b] = Math.max(shown[b], peak[b] - peakFallDbPerSec * dt);
    }
  }
}
