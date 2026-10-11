// DSP worker: loads the Rust/WASM engine and runs jobs off the main thread
// (detailed design 3.1, 18.3).
import init, { engine_version, peak_dbfs, rms_dbfs, simd_enabled } from "../wasm/pkg/akdsp_wasm.js";
import type { DspMethods, FromWorker, Req, SelfTestResult } from "./protocol";

let ready: Promise<unknown> | null = null;

const handlers: { [K in keyof DspMethods]: (p: DspMethods[K]["params"]) => Promise<DspMethods[K]["result"]> } = {
  async init() {
    ready ??= init({ module_or_path: new URL("../wasm/pkg/akdsp_wasm_bg.wasm", import.meta.url) });
    await ready;
    return { engineVersion: engine_version(), simd: simd_enabled() };
  },

  async selfTest(): Promise<SelfTestResult> {
    await handlers.init();
    // 1 s of a full-scale 1 kHz sine: expect RMS -3.01 dBFS, peak 0 dBFS.
    const x = new Float32Array(48_000);
    for (let n = 0; n < x.length; n++) x[n] = Math.sin((2 * Math.PI * 1000 * n) / 48_000);
    return { rmsDbfs: rms_dbfs(x), peakDbfs: peak_dbfs(x), opfs: await opfsSyncAccessCheck() };
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
  const post = (msg: FromWorker) => self.postMessage(msg);
  const handler = handlers[method as keyof DspMethods] as ((p: unknown) => Promise<unknown>) | undefined;
  if (!handler) {
    post({ kind: "res", id, ok: false, error: { code: "E-RND-001", message: `unknown method: ${method}` } });
    return;
  }
  try {
    post({ kind: "res", id, ok: true, result: await handler(params) });
  } catch (e) {
    post({ kind: "res", id, ok: false, error: { code: "E-RND-001", message: String(e) } });
  }
});
