import type { MasterSettings } from "../../workers/protocol";

/** Defaults shared by the single and album screens (akdsp::master::MasterSettings::default). */
export const DEFAULT_SETTINGS: MasterSettings = {
  cleanup: 0.5,
  toneMatch: 0.5,
  tone: 0,
  multiband: true,
  punch: 0.4,
  width: 1,
  monoBelowHz: 120,
  targetLufs: -14,
  ceilingDbtp: -1,
};

export const LOUDNESS_PRESETS = [
  { lufs: -14, label: "Streaming（-14 LUFS）" },
  { lufs: -16, label: "Apple Music（-16 LUFS）" },
  { lufs: -10, label: "Loud（-10 LUFS）" },
  { lufs: -17, label: "Dynamic（-17 LUFS）" },
];

/** Loudness of `[start, end)` frames from a 10 Hz short-term series (3 s windows), power-averaged. */
export function regionLoudness(shortTerm: number[], start: number, end: number, sampleRate: number): number {
  const first = Math.max(0, Math.floor((start / sampleRate - 1.5) / 0.1));
  const last = Math.min(shortTerm.length - 1, Math.ceil((end / sampleRate - 1.5) / 0.1));
  let sum = 0;
  let n = 0;
  for (let j = first; j <= last; j++) {
    if (Number.isFinite(shortTerm[j]) && shortTerm[j] > -70) {
      sum += 10 ** (shortTerm[j] / 10);
      n++;
    }
  }
  return n ? 10 * Math.log10(sum / n) : -70;
}
