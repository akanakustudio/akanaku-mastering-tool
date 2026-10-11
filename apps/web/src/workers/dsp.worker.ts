// DSP worker: loads the Rust/WASM engine and runs jobs off the main thread
// (detailed design 3.1, 18.3).
import init, { Engine, engine_version, peak_dbfs, rms_dbfs, simd_enabled } from "../wasm/pkg/akdsp_wasm.js";
import type { DspMethods, FromWorker, LoadResult, Pyramid, Req, RenderResult, SelfTestResult } from "./protocol";

/** Peak pyramid levels sent to the waveform view (detailed design 11.1). */
const PYRAMID_BINS = [256, 1024, 4096, 16384];

let ready: Promise<unknown> | null = null;
let engine: Engine | null = null;
let currentId = 0;

const post = (msg: FromWorker, transfer: Transferable[] = []) => self.postMessage(msg, { transfer });
const progress = (stage: string, fraction: number) => post({ kind: "progress", id: currentId, stage, fraction });

function pyramid(which: string): Pyramid {
  const out: Pyramid = {};
  for (const bin of PYRAMID_BINS) out[bin] = engine!.peaks(which, bin);
  return out;
}

const buffers = (p: Pyramid) => Object.values(p).map((a) => a.buffer);

type Handler<K extends keyof DspMethods> = (p: DspMethods[K]["params"]) => Promise<{ result: DspMethods[K]["result"]; transfer?: Transferable[] }>;

const handlers: { [K in keyof DspMethods]: Handler<K> } = {
  async init() {
    ready ??= init({ module_or_path: new URL("../wasm/pkg/akdsp_wasm_bg.wasm", import.meta.url) });
    await ready;
    return { result: { engineVersion: engine_version(), simd: simd_enabled() } };
  },

  async selfTest() {
    await handlers.init();
    // 1 s of a full-scale 1 kHz sine: expect RMS -3.01 dBFS, peak 0 dBFS.
    const x = new Float32Array(48_000);
    for (let n = 0; n < x.length; n++) x[n] = Math.sin((2 * Math.PI * 1000 * n) / 48_000);
    const result: SelfTestResult = { rmsDbfs: rms_dbfs(x), peakDbfs: peak_dbfs(x), opfs: await opfsSyncAccessCheck() };
    return { result };
  },

  async load({ bytes, name }) {
    await handlers.init();
    engine?.free();
    engine = new Engine();
    const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : undefined;
    const info = engine.load(new Uint8Array(bytes), ext);
    const audio = { left: engine.channel("before", 0), right: engine.channel("before", 1) };
    const peaks = pyramid("before");
    const result: LoadResult = { ...info, audio, peaks };
    return { result, transfer: [audio.left.buffer, audio.right.buffer, ...buffers(peaks)] };
  },

  async render({ settings }) {
    if (!engine) throw new Error("音源が読み込まれていません");
    const info = engine.render(settings, progress);
    progress("display", 0);
    const audio = { left: engine.channel("after", 0), right: engine.channel("after", 1) };
    const peaks = { after: pyramid("after"), diff: pyramid("diff") };
    const gainDelta = engine.gain_delta();
    const result: RenderResult = { ...info, audio, peaks, gainDelta };
    return { result, transfer: [audio.left.buffer, audio.right.buffer, ...buffers(peaks.after), ...buffers(peaks.diff), gainDelta.buffer] };
  },

  async exportWav({ sampleRate, bits }) {
    if (!engine) throw new Error("音源が読み込まれていません");
    progress("encode", 0);
    const bytes = engine.export_wav(sampleRate, bits);
    return { result: { bytes: bytes.buffer as ArrayBuffer }, transfer: [bytes.buffer] };
  },
};

// The project compiles against the DOM lib, which leaves out this worker-only API.
type SyncAccessHandle = {
  read(buffer: Uint8Array, options: { at: number }): number;
  write(buffer: Uint8Array, options: { at: number }): number;
  flush(): void;
  close(): void;
};
type SyncFileHandle = FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncAccessHandle> };

/** Safari can only write OPFS through sync access handles inside a worker (detailed design 3.1). */
async function opfsSyncAccessCheck(): Promise<{ ok: boolean; detail: string }> {
  const name = `selftest-${crypto.randomUUID()}.bin`;
  try {
    const root = await navigator.storage.getDirectory();
    const file = (await root.getFileHandle(name, { create: true })) as SyncFileHandle;
    const handle = await file.createSyncAccessHandle();
    try {
      const data = new Uint8Array(1 << 20).map((_, i) => i & 0xff);
      handle.write(data, { at: 0 });
      handle.flush();
      const back = new Uint8Array(data.length);
      handle.read(back, { at: 0 });
      const same = back.every((v, i) => v === data[i]);
      return { ok: same, detail: same ? "1 MB の書き込み・読み込みに成功" : "読み込んだ内容が一致しない" };
    } finally {
      handle.close();
      await root.removeEntry(name);
    }
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}

self.addEventListener("message", async (ev: MessageEvent<Req>) => {
  const { id, method, params } = ev.data;
  const handler = handlers[method as keyof DspMethods] as Handler<keyof DspMethods> | undefined;
  if (!handler) {
    post({ kind: "res", id, ok: false, error: { code: "E-RND-001", message: `unknown method: ${method}` } });
    return;
  }
  currentId = id;
  try {
    const { result, transfer } = await handler(params as never);
    post({ kind: "res", id, ok: true, result }, transfer);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const code = /^E-[A-Z]+-\d+/.exec(message)?.[0] ?? "E-RND-001";
    post({ kind: "res", id, ok: false, error: { code, message } });
  }
});
