// Shared-memory layout between the main thread and the player worklet (detailed design 12.2).

export const SAMPLE_RATE = 48_000;
/** One slot holds one second of stereo audio. */
export const SLOT_FRAMES = SAMPLE_RATE;
/** Spare slots per pool for region swaps (detailed design 12.2). */
export const SPARE_SLOTS = 16;

export const Mode = { BEFORE: 0, AFTER: 1, DELTA: 2 } as const;
export type ModeValue = (typeof Mode)[keyof typeof Mode];

/** Int32 control block. Frame positions fit in int32 for tracks up to ~12 hours at 48 kHz. */
export const Ctl = {
  PLAYING: 0, // requested state; the worklet fades out before going silent and clears it at track end
  MODE: 1,
  POSITION: 2, // written by the worklet each quantum
  SEEK: 3, // -1 = no request; the worklet resets it after handling
  LOOP_START: 4, // -1 = no loop
  LOOP_END: 5,
  MONO: 6,
  EPOCH: 7, // incremented by the worklet every quantum
  MODE_SEQ: 8, // incremented by the main thread with each mode request
  MODE_APPLIED_SEQ: 9, // MODE_SEQ the worklet last applied
  MODE_APPLIED_FRAME: 10, // context frame at which it was applied
  VERIFY: 11, // 1 = compare After samples against the reference signal (P0 tests)
  VERIFY_ERRORS: 12,
  VERIFIED_FRAMES: 13,
  SLOT_ERRORS: 14,
  TOTAL_FRAMES: 15,
} as const;
export const CTL_LENGTH = 16;

/** Float32 block: gains (written by main) and diagnostics (written by the worklet). */
export const F32 = {
  GAIN_BEFORE: 0,
  GAIN_DELTA: 1,
  MAX_STEP_SWITCH: 2, // largest |y[n] - y[n-1]| during mode crossfades
  MAX_STEP_STEADY: 3, // largest |y[n] - y[n-1]| outside them
  MAX_STEP_TRANSPORT: 4, // largest |y[n] - y[n-1]| while fading in/out on play, pause and track end
} as const;
export const F32_LENGTH = 8;

export type ChunkPool = { slots: Float32Array; table: Int32Array; slotCount: number; seconds: number };

export function createChunkPool(totalFrames: number, spare = SPARE_SLOTS): ChunkPool {
  const seconds = Math.ceil(totalFrames / SLOT_FRAMES);
  const slotCount = seconds + spare;
  return {
    slots: new Float32Array(new SharedArrayBuffer(slotCount * 2 * SLOT_FRAMES * 4)),
    table: new Int32Array(new SharedArrayBuffer(seconds * 4)),
    slotCount,
    seconds,
  };
}

/** Start of channel `ch` of `slot` within `pool.slots`. */
export const slotOffset = (slot: number, ch: number) => (slot * 2 + ch) * SLOT_FRAMES;

/** Copy planar stereo audio into slots 0..seconds-1 and point the table at them. */
export function fillPool(pool: ChunkPool, left: Float32Array, right: Float32Array) {
  for (let sec = 0; sec < pool.seconds; sec++) {
    const from = sec * SLOT_FRAMES;
    const to = Math.min(from + SLOT_FRAMES, left.length);
    pool.slots.set(left.subarray(from, to), slotOffset(sec, 0));
    pool.slots.set(right.subarray(from, to), slotOffset(sec, 1));
    pool.table[sec] = sec;
  }
}
