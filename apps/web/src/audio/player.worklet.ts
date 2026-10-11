// Player AudioWorkletProcessor (detailed design 12.4).
// Reads Before/After from shared chunk pools, mixes the selected mode, and handles mode
// crossfades, loop wrap, seek fades and mono. No allocation happens inside process().
import { Ctl, F32, Mode, SLOT_FRAMES, slotOffset } from "./layout";
import { MODE_XFADE_FRAMES, SHORT_FADE_FRAMES, equalGainTable, equalPowerTable, mixMode } from "./mix";
import { afterSample } from "./testSignals";

// AudioWorkletGlobalScope is not part of the DOM lib.
declare const sampleRate: number;
declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new (options: { processorOptions: PlayerOptions }) => AudioWorkletProcessor): void;

type PoolView = { slots: Float32Array; table: Int32Array };
export type PlayerOptions = { ctl: Int32Array; f32: Float32Array; before: PoolView; after: PoolView };

type Seek = "none" | "fadeOut" | "fadeIn";
type Ramp = "none" | "in" | "out";

class PlayerProcessor extends AudioWorkletProcessor {
  private ctl: Int32Array;
  private f32: Float32Array;
  private before: PoolView;
  private after: PoolView;

  private pos = 0;
  private mode: number = Mode.AFTER;
  private prevMode: number = Mode.AFTER;
  private xfadeLeft = 0; // frames remaining in the mode crossfade
  // Before/After are the same song, so mode switches use an equal-gain crossfade.
  private readonly modeFade = equalGainTable(MODE_XFADE_FRAMES);
  private readonly shortFade = equalPowerTable(SHORT_FADE_FRAMES);
  // Fades from/to silence (play, pause, end of track): smooth sin² ramp.
  private readonly runFade = equalGainTable(SHORT_FADE_FRAMES);

  /** Whether audio is flowing; lags Ctl.PLAYING by the length of the stop fade. */
  private running = false;
  private runRamp: Ramp = "none";
  private runStep = 0;

  private seek: Seek = "none";
  private seekTarget = 0;
  private seekStep = 0;

  private lastL = 0;
  private lastR = 0;

  // Per-sample read results, kept as fields so reads do not allocate.
  private b0 = 0;
  private b1 = 0;
  private a0 = 0;
  private a1 = 0;

  constructor(options: { processorOptions: PlayerOptions }) {
    super();
    const o = options.processorOptions;
    this.ctl = o.ctl;
    this.f32 = o.f32;
    this.before = o.before;
    this.after = o.after;
    this.mode = this.prevMode = Atomics.load(this.ctl, Ctl.MODE);
  }

  /** Reads Before/After at `pos` into b0/b1/a0/a1. Returns false if the slot table is broken. */
  private read(pos: number): boolean {
    const sec = (pos / SLOT_FRAMES) | 0;
    const off = pos - sec * SLOT_FRAMES;
    const sb = Atomics.load(this.before.table, sec);
    const sa = Atomics.load(this.after.table, sec);
    const maxB = this.before.slots.length / (2 * SLOT_FRAMES);
    const maxA = this.after.slots.length / (2 * SLOT_FRAMES);
    if (sb < 0 || sb >= maxB || sa < 0 || sa >= maxA) {
      this.b0 = this.b1 = this.a0 = this.a1 = 0;
      return false;
    }
    this.b0 = this.before.slots[slotOffset(sb, 0) + off];
    this.b1 = this.before.slots[slotOffset(sb, 1) + off];
    this.a0 = this.after.slots[slotOffset(sa, 0) + off];
    this.a1 = this.after.slots[slotOffset(sa, 1) + off];
    return true;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const outL = outputs[0][0];
    const outR = outputs[0][1];
    const ctl = this.ctl;

    const want = Atomics.load(ctl, Ctl.PLAYING) === 1;

    // While silent, seek immediately; there is nothing to fade.
    if (!this.running) {
      const seekReq = Atomics.load(ctl, Ctl.SEEK);
      if (seekReq >= 0) {
        this.pos = seekReq;
        Atomics.store(ctl, Ctl.SEEK, -1);
        Atomics.store(ctl, Ctl.POSITION, this.pos);
      }
    }

    // Starting or stopping playback fades in/out instead of cutting the waveform (no click).
    if (want && (!this.running || this.runRamp === "out")) {
      this.runStep = this.running ? SHORT_FADE_FRAMES - this.runStep : 0;
      this.running = true;
      this.runRamp = "in";
    } else if (!want && this.running && this.runRamp !== "out") {
      this.runStep = this.runRamp === "in" ? SHORT_FADE_FRAMES - this.runStep : 0;
      this.runRamp = "out";
    }

    if (!this.running) {
      outL.fill(0);
      outR.fill(0);
      Atomics.add(ctl, Ctl.EPOCH, 1);
      return true;
    }

    // Mode request: start a crossfade from whatever is currently audible.
    const requested = Atomics.load(ctl, Ctl.MODE);
    if (requested !== this.mode) {
      this.prevMode = this.xfadeLeft > 0 ? this.prevMode : this.mode;
      this.mode = requested;
      this.xfadeLeft = MODE_XFADE_FRAMES;
      Atomics.store(ctl, Ctl.MODE_APPLIED_FRAME, currentFrame);
      Atomics.store(ctl, Ctl.MODE_APPLIED_SEQ, Atomics.load(ctl, Ctl.MODE_SEQ));
    }

    const seekReq = Atomics.load(ctl, Ctl.SEEK);
    if (seekReq >= 0 && this.seek === "none") {
      this.seek = "fadeOut";
      this.seekTarget = seekReq;
      this.seekStep = 0;
      Atomics.store(ctl, Ctl.SEEK, -1);
    }

    const total = Atomics.load(ctl, Ctl.TOTAL_FRAMES);
    const loopStart = Atomics.load(ctl, Ctl.LOOP_START);
    const loopEnd = Atomics.load(ctl, Ctl.LOOP_END);
    const looping = loopStart >= 0 && loopEnd - loopStart > 2 * SHORT_FADE_FRAMES;
    const mono = Atomics.load(ctl, Ctl.MONO) === 1;
    const verify = Atomics.load(ctl, Ctl.VERIFY) === 1;
    const gB = this.f32[F32.GAIN_BEFORE];
    const gD = this.f32[F32.GAIN_DELTA];
    let verifyErrors = 0;
    let verified = 0;
    let slotErrors = 0;
    let maxStepSwitch = 0;
    let maxStepSteady = 0;
    let maxStepTransport = 0;

    for (let i = 0; i < outL.length; i++) {
      if (!this.running || (!looping && this.pos >= total)) {
        outL[i] = outR[i] = 0;
        this.running = false;
        this.runRamp = "none";
        continue;
      }

      // Fade out over the last frames of the track so playback ends without a click.
      if (!looping && this.runRamp !== "out" && this.pos >= total - SHORT_FADE_FRAMES) {
        this.runRamp = "out";
        this.runStep = SHORT_FADE_FRAMES - (total - this.pos);
        Atomics.store(ctl, Ctl.PLAYING, 0);
      }

      const inXfade = this.xfadeLeft > 0;
      const gNew = inXfade ? this.modeFade[MODE_XFADE_FRAMES - this.xfadeLeft] : 1;
      const gOld = 1 - gNew;

      if (!this.read(this.pos)) slotErrors++;
      let l = gNew * mixMode(this.mode, this.b0, this.a0, gB, gD);
      let r = gNew * mixMode(this.mode, this.b1, this.a1, gB, gD);
      if (inXfade) {
        l += gOld * mixMode(this.prevMode, this.b0, this.a0, gB, gD);
        r += gOld * mixMode(this.prevMode, this.b1, this.a1, gB, gD);
      }

      // Verify the raw After samples just read (only while nothing else is fading).
      const steady = !inXfade && this.seek === "none" && this.runRamp === "none";
      if (verify && steady) {
        if (this.a0 !== afterSample(this.pos, 0, sampleRate) || this.a1 !== afterSample(this.pos, 1, sampleRate)) verifyErrors++;
        verified++;
      }

      // Loop wrap: crossfade the loop tail into the loop head over SHORT_FADE_FRAMES.
      let nextPos = this.pos + 1;
      if (looping && this.pos >= loopEnd - SHORT_FADE_FRAMES) {
        const k = this.pos - (loopEnd - SHORT_FADE_FRAMES);
        if (!this.read(loopStart + k)) slotErrors++;
        let hl = gNew * mixMode(this.mode, this.b0, this.a0, gB, gD);
        let hr = gNew * mixMode(this.mode, this.b1, this.a1, gB, gD);
        if (inXfade) {
          hl += gOld * mixMode(this.prevMode, this.b0, this.a0, gB, gD);
          hr += gOld * mixMode(this.prevMode, this.b1, this.a1, gB, gD);
        }
        const fin = this.shortFade[k];
        const fout = this.shortFade[SHORT_FADE_FRAMES - k];
        l = fout * l + fin * hl;
        r = fout * r + fin * hr;
        if (k + 1 >= SHORT_FADE_FRAMES) nextPos = loopStart + SHORT_FADE_FRAMES;
      }

      // Seek: fade out, jump, fade in.
      if (this.seek !== "none") {
        const g = this.seek === "fadeOut" ? this.shortFade[SHORT_FADE_FRAMES - this.seekStep] : this.shortFade[this.seekStep];
        l *= g;
        r *= g;
        this.seekStep++;
        if (this.seekStep >= SHORT_FADE_FRAMES) {
          if (this.seek === "fadeOut") {
            this.seek = "fadeIn";
            nextPos = this.seekTarget;
          } else {
            this.seek = "none";
          }
          this.seekStep = 0;
        }
      }

      if (mono) l = r = 0.5 * (l + r);

      const ramping = this.runRamp !== "none";
      if (ramping) {
        const g = this.runRamp === "in" ? this.runFade[this.runStep] : this.runFade[SHORT_FADE_FRAMES - this.runStep];
        l *= g;
        r *= g;
        this.runStep++;
        if (this.runStep >= SHORT_FADE_FRAMES) {
          if (this.runRamp === "out") this.running = false;
          this.runRamp = "none";
          this.runStep = 0;
        }
      }

      const step = Math.max(Math.abs(l - this.lastL), Math.abs(r - this.lastR));
      if (ramping) maxStepTransport = Math.max(maxStepTransport, step);
      else if (inXfade) maxStepSwitch = Math.max(maxStepSwitch, step);
      else if (steady) maxStepSteady = Math.max(maxStepSteady, step);
      this.lastL = l;
      this.lastR = r;

      outL[i] = l;
      outR[i] = r;
      if (inXfade) this.xfadeLeft--;
      this.pos = nextPos;
    }

    if (verifyErrors) Atomics.add(ctl, Ctl.VERIFY_ERRORS, verifyErrors);
    if (verified) Atomics.add(ctl, Ctl.VERIFIED_FRAMES, verified);
    if (slotErrors) Atomics.add(ctl, Ctl.SLOT_ERRORS, slotErrors);
    // Running maxima; the main thread resets them by writing 0.
    this.f32[F32.MAX_STEP_SWITCH] = Math.max(this.f32[F32.MAX_STEP_SWITCH], maxStepSwitch);
    this.f32[F32.MAX_STEP_STEADY] = Math.max(this.f32[F32.MAX_STEP_STEADY], maxStepSteady);
    this.f32[F32.MAX_STEP_TRANSPORT] = Math.max(this.f32[F32.MAX_STEP_TRANSPORT], maxStepTransport);
    Atomics.store(ctl, Ctl.POSITION, this.pos);
    Atomics.add(ctl, Ctl.EPOCH, 1);
    return true;
  }
}

registerProcessor("akanaku-player", PlayerProcessor);
