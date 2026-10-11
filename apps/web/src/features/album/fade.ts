// Fade-in / fade-out applied after mastering, before dither (detailed design 10.5).

/** Smooth S-shaped gain 0..1 (sin²), so fades start and end without a corner. */
const curve = (t: number) => Math.sin(Math.min(1, Math.max(0, t)) * (Math.PI / 2)) ** 2;

/** Applies fades in place to planar stereo audio at `sampleRate`. */
export function applyFades(left: Float32Array, right: Float32Array, fadeInSec: number, fadeOutSec: number, sampleRate: number) {
  const n = left.length;
  const fin = Math.min(n, Math.round(fadeInSec * sampleRate));
  for (let i = 0; i < fin; i++) {
    const g = curve(i / fin);
    left[i] *= g;
    right[i] *= g;
  }
  const fout = Math.min(n, Math.round(fadeOutSec * sampleRate));
  for (let k = 0; k < fout; k++) {
    const i = n - fout + k;
    const g = curve(1 - (k + 1) / fout);
    left[i] *= g;
    right[i] *= g;
  }
}
