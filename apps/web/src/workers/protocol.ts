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
  /** `storePath`: also keep the rendered audio in OPFS so the work can be restored instantly. */
  render: { params: { settings: MasterSettings; cancel?: CancelToken; storePath?: string }; result: RenderResult };
  /** Loads the source into this worker's engine only (for region renders). */
  loadSource: { params: { bytes: ArrayBuffer; name: string }; result: Record<string, never> };
  renderRegion: {
    params: { settings: MasterSettings; start: number; end: number; regionLufsGoal: number; stats: ChainStats; cancel?: CancelToken };
    result: { left: Float32Array; right: Float32Array; offset: number };
  };
  exportWav: { params: { sampleRate: number; bits: 16 | 24 }; result: { bytes: ArrayBuffer } };
  // Album (detailed design 10). Rendered audio is stored in OPFS under album/<key>.f32.
  analyzeFile: { params: { file: File }; result: FileInfo };
  renderToStore: { params: { file: File; settings: MasterSettings; key: string }; result: { after: Analysis; report: RenderReport } };
  /** `key` is a path under OPFS album/ unless `path` gives the full OPFS path. */
  openStored: { params: { file: File; key: string; path?: string; ceilingDbtp: number }; result: { load: LoadResult; render: RenderResult } };
  exportAlbum: { params: ExportAlbumParams; result: { files: string[]; zip: string | null } };
  /** Reads a stored album render (After) back, e.g. for continuous playback. */
  readStored: { params: { key: string }; result: StereoData };
  /** Album tone harmonisation (detailed design 10.3); spectra/result are POINTS values per track, concatenated. */
  albumTonePlan: { params: { spectra: Float32Array; toneMatch: number; amount: number }; result: Float32Array };
}

export type FileInfo = { frames: number; sampleRateIn: number; channelsIn: number; analysis: Analysis; spectrum: number[] };

export type ExportAlbumParams = {
  tracks: { key: string; title: string; gapAfterSec: number; fadeInSec: number; fadeOutSec: number }[];
  albumTitle: string;
  sampleRate: number;
  bits: 16 | 24;
  ceilingDbtp: number;
  perTrack: boolean;
  continuous: boolean;
  zip: boolean;
};

/** A render is cancelled when `sab[0]` no longer equals `gen` (detailed design 13.3). */
export type CancelToken = { sab: Int32Array; gen: number };

/** Mirrors akdsp::master::MasterSettings. */
export type MasterSettings = {
  cleanup: number; // 0..1
  toneMatch: number; // 0..1, automatic tone correction
  tone: number; // -1..1
  multiband: boolean;
  punch: number; // 0..1
  width: number; // 0..1.5
  monoBelowHz: number;
  targetLufs: number;
  /** "integrated" for singles and the album anchor, "l95" for the other album tracks. */
  targetMode?: "integrated" | "l95";
  ceilingDbtp: number;
  /** Album tone correction (detailed design 10.3), dB at the 61 tone points. */
  albumTone?: number[];
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
  toneCurve: number[];
  toneFreqs: number[];
  bandGainReductionDb: [number, number, number];
};

/** Full-render statistics reused by region renders (akdsp::master::ChainStats). */
export type ChainStats = { toneDeviation: number[]; bandLevelsDb: number[]; makeupDb: number[]; limiterGainDb: number };

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
  stats?: ChainStats;
  audio: StereoData;
  peaks: { after: Pyramid; diff: Pyramid };
  gainDelta: Float32Array;
};

export type SelfTestResult = {
  rmsDbfs: number;
  peakDbfs: number;
  opfs: { ok: boolean; detail: string };
};
