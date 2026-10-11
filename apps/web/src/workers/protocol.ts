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
}

export type SelfTestResult = {
  rmsDbfs: number;
  peakDbfs: number;
  opfs: { ok: boolean; detail: string };
};
