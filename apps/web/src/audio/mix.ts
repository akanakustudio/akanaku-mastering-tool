// Pure mixing math shared by the worklet and unit tests (detailed design 12.3, 12.4).
import { Mode } from "./layout";

/** Mode switch crossfade: 10 ms at 48 kHz. */
export const MODE_XFADE_FRAMES = 480;
/** Loop wrap crossfade and seek fade: 5 ms. */
export const SHORT_FADE_FRAMES = 240;

/**
 * Equal-gain fade-in, table[i] = sin²(i / n · π/2); the matching fade-out is 1 − table[i].
 * Use it between correlated signals (Before/After of the same song, two renders of the same
 * region): the gains always sum to 1, so there is no level bump mid-fade.
 */
export function equalGainTable(n: number): Float32Array {
  const t = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) t[i] = Math.sin((i / n) * (Math.PI / 2)) ** 2;
  return t;
}

/**
 * Equal-power fade-in, table[i] = sin(i / n · π/2); fade-out uses table[n − i].
 * Use it between unrelated signals (loop tail → loop head), where powers rather than
 * amplitudes add up. On correlated signals it bumps the level by up to +3 dB.
 */
export function equalPowerTable(n: number): Float32Array {
  const t = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) t[i] = Math.sin((i / n) * (Math.PI / 2));
  return t;
}

/** Output of one mode for one sample (detailed design 12.3). */
export function mixMode(mode: number, before: number, after: number, gainBefore: number, gainDelta: number): number {
  if (mode === Mode.BEFORE) return gainBefore * before;
  if (mode === Mode.DELTA) return after - gainDelta * before;
  return after;
}
