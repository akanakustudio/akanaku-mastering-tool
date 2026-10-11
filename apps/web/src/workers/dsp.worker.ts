// DSP worker: loads the Rust/WASM engine and runs jobs off the main thread
// (detailed design 3.1, 18.3).
import { Unzip, UnzipPassThrough, Zip, ZipPassThrough } from "fflate";
import { applyFades } from "../features/album/fade";
import init, { Engine, album_tone_plan, analyze_file, encode_wav_planar, engine_version, peak_dbfs, rms_dbfs, simd_enabled, timeline_peaks } from "../wasm/pkg/akdsp_wasm.js";
import { clearDir, openSync, readStereo, writeStereo } from "./opfs";
import type { Analysis, CancelToken, DspMethods, FromWorker, LoadResult, Pyramid, Req, RenderResult, SelfTestResult } from "./protocol";
import { cueSheet, dataChunk, pcmHeader, safeFileName } from "./wav";

/** Peak pyramid levels sent to the waveform view (detailed design 11.1). */
const PYRAMID_BINS = [256, 1024, 4096, 16384];

let ready: Promise<unknown> | null = null;
let engine: Engine | null = null;
let currentId = 0;

const post = (msg: FromWorker, transfer: Transferable[] = []) => self.postMessage(msg, { transfer });
const progress = (stage: string, fraction: number) => post({ kind: "progress", id: currentId, stage, fraction });
/** Progress callback for the engine; returning false cancels the render. */
const progressUnless = (cancel?: CancelToken) => (stage: string, fraction: number) => {
  progress(stage, fraction);
  return !cancel || Atomics.load(cancel.sab, 0) === cancel.gen;
};

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
    const info = engine.load(new Uint8Array(bytes), extOf(name));
    const audio = { left: engine.channel("before", 0), right: engine.channel("before", 1) };
    const peaks = pyramid("before");
    const result: LoadResult = { ...info, audio, peaks };
    return { result, transfer: [audio.left.buffer, audio.right.buffer, ...buffers(peaks)] };
  },

  async loadSource({ bytes, name }) {
    await handlers.init();
    engine?.free();
    engine = new Engine();
    engine.load(new Uint8Array(bytes), extOf(name));
    return { result: {} };
  },

  async renderRegion({ settings, start, end, regionLufsGoal, stats, cancel }) {
    if (!engine) throw new Error("音源が読み込まれていません");
    const r = engine.render_region(settings, start, end, regionLufsGoal, stats, progressUnless(cancel));
    return { result: r, transfer: [r.left.buffer, r.right.buffer] };
  },

  async render({ settings, cancel, storePath }) {
    if (!engine) throw new Error("音源が読み込まれていません");
    const info = engine.render(settings, progressUnless(cancel));
    progress("display", 0);
    const audio = { left: engine.channel("after", 0), right: engine.channel("after", 1) };
    if (storePath) await writeStereo(storePath, audio.left, audio.right);
    const peaks = { after: pyramid("after"), diff: pyramid("diff") };
    const gainDelta = engine.gain_delta();
    const result: RenderResult = { ...info, audio, peaks, gainDelta };
    return { result, transfer: [audio.left.buffer, audio.right.buffer, ...buffers(peaks.after), ...buffers(peaks.diff), gainDelta.buffer] };
  },

  async analyzeFile({ file }) {
    await handlers.init();
    const result = analyze_file(new Uint8Array(await file.arrayBuffer()), extOf(file.name));
    return { result };
  },

  async renderToStore({ file, settings, key }) {
    await handlers.init();
    const e = new Engine();
    try {
      e.load(new Uint8Array(await file.arrayBuffer()), extOf(file.name));
      const info = e.render(settings, progressUnless());
      progress("store", 0);
      const left = e.channel("after", 0);
      const right = e.channel("after", 1);
      await writeStereo(`album/${key}.f32`, left, right);
      const peaks = timeline_peaks(left, right);
      return { result: { after: info.after, report: info.report, peaks }, transfer: [peaks.buffer] };
    } finally {
      e.free();
    }
  },

  async openStored({ file, key, path, ceilingDbtp }) {
    const { result: load, transfer: t1 = [] } = await handlers.load({ bytes: await file.arrayBuffer(), name: file.name });
    const stored = await readStereo(path ?? `album/${key}.f32`);
    const after: Analysis = engine!.adopt_after(stored.left, stored.right, ceilingDbtp);
    const audio = { left: engine!.channel("after", 0), right: engine!.channel("after", 1) };
    const peaks = { after: pyramid("after"), diff: pyramid("diff") };
    const gainDelta = engine!.gain_delta();
    const render: RenderResult = {
      after,
      report: { appliedGainDb: 0, iterations: 0, truePeakTrimDb: 0, meanGainReductionDb: 0, maxGainReductionDb: 0, toneCurve: [], toneFreqs: [], bandGainReductionDb: [0, 0, 0] },
      audio,
      peaks,
      gainDelta,
    };
    return {
      result: { load, render },
      transfer: [...t1, audio.left.buffer, audio.right.buffer, ...buffers(peaks.after), ...buffers(peaks.diff), gainDelta.buffer],
    };
  },

  async exportAlbum(p) {
    await handlers.init();
    await clearDir("export");
    const files: string[] = [];
    const bytesPerFrame = 2 * (p.bits / 8);
    const contName = `${safeFileName(p.albumTitle)}.wav`;
    const cont = p.continuous ? await openSync(`export/${contName}`) : null;
    let contBytes = 0;
    const starts: number[] = [];
    try {
      if (cont) cont.truncate(44); // header is written at the end
      for (const [i, t] of p.tracks.entries()) {
        progress(`export ${i + 1}/${p.tracks.length}`, i / p.tracks.length);
        const { left, right } = await readStereo(`album/${t.key}.f32`);
        applyFades(left, right, t.fadeInSec, t.fadeOutSec, 48_000);
        const wav = encode_wav_planar(left, right, p.sampleRate, p.bits, p.ceilingDbtp);
        if (p.perTrack) {
          const name = `${String(i + 1).padStart(2, "0")} ${safeFileName(t.title)}.wav`;
          const h = await openSync(`export/${name}`);
          h.truncate(0);
          h.write(wav, { at: 0 });
          h.flush();
          h.close();
          files.push(name);
        }
        if (cont) {
          const d = dataChunk(wav);
          starts.push(contBytes / bytesPerFrame);
          cont.write(wav.subarray(d.offset, d.offset + d.length), { at: 44 + contBytes });
          contBytes += d.length;
          if (i < p.tracks.length - 1 && t.gapAfterSec > 0) {
            const gap = new Uint8Array(Math.round(t.gapAfterSec * p.sampleRate) * bytesPerFrame);
            cont.write(gap, { at: 44 + contBytes });
            contBytes += gap.length;
          }
        }
      }
      if (cont) {
        cont.write(pcmHeader(contBytes, p.sampleRate, p.bits), { at: 0 });
        cont.flush();
        files.push(contName);
        const cueName = `${safeFileName(p.albumTitle)}.cue`;
        const cue = new TextEncoder().encode(cueSheet(contName, p.albumTitle, p.tracks.map((t) => t.title), starts, p.sampleRate));
        const h = await openSync(`export/${cueName}`);
        h.truncate(0);
        h.write(cue, { at: 0 });
        h.flush();
        h.close();
        files.push(cueName);
      }
    } finally {
      cont?.close();
    }

    let zip: string | null = null;
    if (p.zip) {
      progress("zip", 0);
      zip = `${safeFileName(p.albumTitle)}.zip`;
      const out = await openSync(`export/${zip}`);
      let at = 0;
      let failed: Error | null = null;
      const z = new Zip((err, chunk) => {
        if (err) failed = err;
        else {
          out.write(chunk, { at });
          at += chunk.length;
        }
      });
      try {
        for (const name of files) {
          const entry = new ZipPassThrough(name);
          z.add(entry);
          const h = await openSync(`export/${name}`, false);
          const size = h.getSize();
          const buf = new Uint8Array(8 << 20);
          for (let off = 0; off < size; off += buf.length) {
            const n = h.read(buf, { at: off });
            entry.push(buf.slice(0, n), off + n >= size);
          }
          if (size === 0) entry.push(new Uint8Array(0), true);
          h.close();
        }
        z.end();
        if (failed) throw failed;
        out.flush();
      } finally {
        out.close();
      }
    }
    return { result: { files, zip } };
  },

  async exportProject({ fileName, projectJson, sources, renders }) {
    progress("project", 0);
    const out = await openSync(`export/${fileName}`);
    out.truncate(0);
    let at = 0;
    let failed: Error | null = null;
    const zip = new Zip((err, chunk) => {
      if (err) failed = err;
      else {
        out.write(chunk, { at });
        at += chunk.length;
      }
    });
    try {
      const add = async (name: string, read: () => AsyncGenerator<Uint8Array>) => {
        const entry = new ZipPassThrough(name);
        zip.add(entry);
        let prev: Uint8Array | null = null;
        for await (const chunk of read()) {
          if (prev) entry.push(prev);
          prev = chunk;
        }
        entry.push(prev ?? new Uint8Array(0), true);
      };
      await add("project.json", async function* () {
        yield new TextEncoder().encode(projectJson);
      });
      for (const [i, s] of sources.entries()) {
        progress("project", i / (sources.length + renders.length));
        await add(`sources/${s.id}`, async function* () {
          const reader = s.file.stream().getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            yield value;
          }
        });
      }
      for (const path of renders) {
        await add(`renders/${path}`, async function* () {
          const h = await openSync(path, false);
          try {
            const size = h.getSize();
            const buf = new Uint8Array(8 << 20);
            for (let off = 0; off < size; off += buf.length) {
              const n = h.read(buf, { at: off });
              yield buf.slice(0, n);
            }
          } finally {
            h.close();
          }
        });
      }
      zip.end();
      if (failed) throw failed;
      out.flush();
    } finally {
      out.close();
    }
    return { result: { path: `export/${fileName}` } };
  },

  async importProject({ file }) {
    let projectJson = "";
    const parts = new Map<string, Uint8Array[]>();
    const renderHandles: { path: string; h: Awaited<ReturnType<typeof openSync>>; at: number }[] = [];
    const pending: Promise<void>[] = [];
    let renders = 0;
    const unzip = new Unzip((entry) => {
      const name = entry.name;
      if (name.startsWith("renders/")) {
        renders++;
        const path = name.slice("renders/".length);
        const slot = { path, h: null as unknown as Awaited<ReturnType<typeof openSync>>, at: 0 };
        const ready = openSync(path).then((h) => {
          h.truncate(0);
          slot.h = h;
        });
        pending.push(ready);
        renderHandles.push(slot);
        entry.ondata = (err, chunk) => {
          if (err) throw err;
          // Opened asynchronously: queue writes until the handle exists.
          const c = chunk.slice();
          pending.push(
            ready.then(() => {
              slot.h.write(c, { at: slot.at });
              slot.at += c.length;
            }),
          );
        };
      } else {
        const list: Uint8Array[] = [];
        parts.set(name, list);
        entry.ondata = (err, chunk) => {
          if (err) throw err;
          list.push(chunk.slice());
        };
      }
      entry.start();
    });
    unzip.register(UnzipPassThrough);
    const reader = file.stream().getReader();
    let read = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        unzip.push(new Uint8Array(0), true);
        break;
      }
      unzip.push(value);
      read += value.length;
      progress("import", read / file.size);
    }
    await Promise.all(pending);
    for (const r of renderHandles) {
      r.h.flush();
      r.h.close();
    }
    const json = parts.get("project.json");
    if (!json) throw new Error("E-IN-002: プロジェクトファイルではありません（project.json がありません）");
    projectJson = new TextDecoder().decode(await new Blob(json as BlobPart[]).arrayBuffer());
    const sources: { id: string; file: File }[] = [];
    for (const [name, list] of parts) {
      if (name.startsWith("sources/")) sources.push({ id: name.slice("sources/".length), file: new File(list as BlobPart[], name) });
    }
    return { result: { projectJson, sources, renders } };
  },

  async storedPeaks({ key }) {
    await handlers.init();
    const { left, right } = await readStereo(`album/${key}.f32`);
    const peaks = timeline_peaks(left, right);
    return { result: peaks, transfer: [peaks.buffer] };
  },

  async readStored({ key }) {
    const r = await readStereo(`album/${key}.f32`);
    return { result: r, transfer: [r.left.buffer, r.right.buffer] };
  },

  async albumTonePlan({ spectra, toneMatch, amount }) {
    await handlers.init();
    const result = album_tone_plan(spectra, toneMatch, amount);
    return { result, transfer: [result.buffer] };
  },

  async exportWav({ sampleRate, bits }) {
    if (!engine) throw new Error("音源が読み込まれていません");
    progress("encode", 0);
    const bytes = engine.export_wav(sampleRate, bits);
    return { result: { bytes: bytes.buffer as ArrayBuffer }, transfer: [bytes.buffer] };
  },
};

const extOf = (name: string) => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : undefined);

/** Safari can only write OPFS through sync access handles inside a worker (detailed design 3.1). */
async function opfsSyncAccessCheck(): Promise<{ ok: boolean; detail: string }> {
  const name = `selftest-${crypto.randomUUID()}.bin`;
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await openSync(name);
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
    const code = /^E-[A-Z]+(-\d+)?/.exec(message)?.[0] ?? "E-RND-001";
    post({ kind: "res", id, ok: false, error: { code, message } });
  }
});
