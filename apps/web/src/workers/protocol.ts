// Main thread <-> Worker message protocol (detailed design 18.3).

export type AppError = { code: string; message: string };

export type Req = { kind: "req"; id: number; method: string; params: unknown };
export type Res =
  | { kind: "res"; id: number; ok: true; result: unknown }
  | { kind: "res"; id: number; ok: false; error: AppError };
export type Progress = { kind: "progress"; id: number; stage: string; fraction: number };
export type Log = { kind: "log"; level: "debug" | "info" | "warn" | "error"; msg: string; ctx?: object };

export type FromWorker = Res | Progress | Log;

/** Methods of dsp.worker.ts and their params/result types. */
export interface DspMethods {
  init: { params: void; result: { engineVersion: string; simd: boolean } };
  selfTest: { params: void; result: SelfTestResult };
  load: { params: { bytes: ArrayBuffer; name: string }; result: LoadResult };
  render: { params: { settings: MasterSettings }; result: RenderResult };
  exportWav: { params: { sampleRate: number; bits: 16 | 24 }; result: { bytes: ArrayBuffer } };
}

/** Mirrors akdsp::master::MasterSettings. */
export type MasterSettings = {
  cleanup: number; // 0..1
  tone: number; // -1..1
  width: number; // 0..1.5
  monoBelowHz: number;
  targetLufs: number;
  ceilingDbtp: number;
};

/** Mirrors akdsp::analysis::Analysis. */
export type Analysis = {
  lufs: number;
  truePeak: number;
  samplePeak: number;
  plr: number;
  l95: number;
  lra: number;
  shortTerm: number[];
};

export type RenderReport = {
  appliedGainDb: number;
  iterations: number;
  truePeakTrimDb: number;
  meanGainReductionDb: number;
  maxGainReductionDb: number;
};

export type StereoData = { left: Float32Array; right: Float32Array };
/** Peak pyramid: bin size (frames) -> [min, max, rms] per bin. */
export type Pyramid = Record<number, Float32Array>;

export type LoadResult = {
  sampleRateIn: number;
  channelsIn: number;
  frames: number;
  sampleRate: number;
  before: Analysis;
  audio: StereoData;
  peaks: Pyramid;
};

export type RenderResult = {
  after: Analysis;
  report: RenderReport;
  audio: StereoData;
  peaks: { after: Pyramid; diff: Pyramid };
  gainDelta: Float32Array;
};

export type SelfTestResult = {
  rmsDbfs: number;
  peakDbfs: number;
  opfs: { ok: boolean; detail: string };
};
