// P0-2 measurements (detailed design 22: P0-2, T-PLAY-01/02, T-PERF-03).
import { Ctl, F32, Mode, SAMPLE_RATE, SLOT_FRAMES } from "../audio/layout";
import { MODE_XFADE_FRAMES } from "../audio/mix";
import type { Player } from "../audio/player";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type SwitchResult = {
  count: number;
  /** Time from the request until the worklet started the crossfade (ms). */
  applyP50: number;
  applyP95: number;
  applyMax: number;
  baseLatencyMs: number | null;
  outputLatencyMs: number | null;
  /** applyMax + crossfade + base + output latency (ms). Compared against the 60 ms target. */
  worstAudibleMs: number | null;
  maxStepSwitch: number;
  maxStepSteady: number;
};

/** Toggles Before/After `count` times while playing and measures when each switch was applied. */
export async function measureSwitching(player: Player, count = 50, onProgress?: (i: number) => void): Promise<SwitchResult> {
  const ctx = player.context!;
  player.f32[F32.MAX_STEP_SWITCH] = 0;
  player.f32[F32.MAX_STEP_STEADY] = 0;
  const delays: number[] = [];
  for (let i = 0; i < count; i++) {
    await sleep(120 + Math.random() * 180);
    const requestedAt = ctx.currentTime;
    player.setMode(player.mode === Mode.AFTER ? Mode.BEFORE : Mode.AFTER);
    const seq = Atomics.load(player.ctl, Ctl.MODE_SEQ);
    while (Atomics.load(player.ctl, Ctl.MODE_APPLIED_SEQ) !== seq) await sleep(1);
    const appliedAt = Atomics.load(player.ctl, Ctl.MODE_APPLIED_FRAME) / SAMPLE_RATE;
    delays.push(Math.max(0, (appliedAt - requestedAt) * 1000));
    onProgress?.(i + 1);
  }
  player.setMode(Mode.AFTER);
  delays.sort((a, b) => a - b);
  const q = (p: number) => delays[Math.min(delays.length - 1, Math.floor(p * delays.length))];
  const base = Number.isFinite(ctx.baseLatency) ? ctx.baseLatency * 1000 : null;
  const out = Number.isFinite(ctx.outputLatency) && ctx.outputLatency > 0 ? ctx.outputLatency * 1000 : null;
  const xfadeMs = (MODE_XFADE_FRAMES / SAMPLE_RATE) * 1000;
  return {
    count,
    applyP50: q(0.5),
    applyP95: q(0.95),
    applyMax: delays[delays.length - 1],
    baseLatencyMs: base,
    outputLatencyMs: out,
    worstAudibleMs: base === null ? null : delays[delays.length - 1] + xfadeMs + base + (out ?? 0),
    maxStepSwitch: player.f32[F32.MAX_STEP_SWITCH],
    maxStepSteady: player.f32[F32.MAX_STEP_STEADY],
  };
}

export type SwapResult = {
  requested: number;
  swapped: number;
  waitedForSpare: number;
  verifiedFrames: number;
  verifyErrors: number;
  slotErrors: number;
  seconds: number;
};

/**
 * Replaces seconds around the playhead `count` times while After plays, writing the same
 * reference data into fresh slots. The worklet checks every After sample it reads against
 * the reference formula, so any torn or misplaced slot shows up as a verify error.
 */
export async function swapStress(
  player: Player,
  afterData: { left: Float32Array; right: Float32Array },
  count = 1000,
  intervalMs = 5,
  onProgress?: (i: number) => void,
): Promise<SwapResult> {
  const ctl = player.ctl;
  player.setMode(Mode.AFTER);
  await sleep(50); // let the mode crossfade finish before verifying
  Atomics.store(ctl, Ctl.VERIFY_ERRORS, 0);
  Atomics.store(ctl, Ctl.VERIFIED_FRAMES, 0);
  Atomics.store(ctl, Ctl.SLOT_ERRORS, 0);
  Atomics.store(ctl, Ctl.VERIFY, 1);
  const seconds = player.after.seconds;
  const t0 = performance.now();
  let swapped = 0;
  let waited = 0;
  for (let i = 0; i < count; i++) {
    const playSec = Math.floor(player.position / SLOT_FRAMES);
    // Mostly the second being played right now, sometimes its neighbours.
    const sec = Math.min(seconds - 1, Math.max(0, playSec + Math.floor(Math.random() * 4) - 1));
    const from = sec * SLOT_FRAMES;
    const to = Math.min(from + SLOT_FRAMES, afterData.left.length);
    let ok = player.afterSlots.replace(sec, (l, r) => {
      l.set(afterData.left.subarray(from, to));
      r.set(afterData.right.subarray(from, to));
    });
    while (!ok) {
      waited++;
      await sleep(1);
      ok = player.afterSlots.replace(sec, (l, r) => {
        l.set(afterData.left.subarray(from, to));
        r.set(afterData.right.subarray(from, to));
      });
    }
    swapped++;
    onProgress?.(i + 1);
    await sleep(intervalMs);
  }
  await sleep(300);
  Atomics.store(ctl, Ctl.VERIFY, 0);
  return {
    requested: count,
    swapped,
    waitedForSpare: waited,
    verifiedFrames: Atomics.load(ctl, Ctl.VERIFIED_FRAMES),
    verifyErrors: Atomics.load(ctl, Ctl.VERIFY_ERRORS),
    slotErrors: Atomics.load(ctl, Ctl.SLOT_ERRORS),
    seconds: (performance.now() - t0) / 1000,
  };
}
