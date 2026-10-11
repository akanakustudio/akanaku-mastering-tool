import { useEffect, useState } from "react";
import { WorkerClient } from "../orchestrator/workerClient";
import type { DspMethods } from "../workers/protocol";
import { runMainThreadChecks, type CheckResult } from "./envCheck";
import { PlaybackTest } from "./PlaybackTest";
import "./App.css";

const STATUS_ICON = { ok: "✓", warn: "!", error: "✗" } as const;

// P0 environment check screen. Becomes the startup check of S-01 later (detailed design 16.0).
export function App() {
  const [checks, setChecks] = useState<CheckResult[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const results = await runMainThreadChecks();
      if (!cancelled) setChecks(results);
      const worker = await runWorkerChecks();
      if (!cancelled) setChecks([...results, ...worker]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="env">
      <h1>akanaku mastering</h1>
      <p className="sub">P0 環境チェック（{browserName(navigator.userAgent)}）</p>
      <table>
        <tbody>
          {checks.map((c) => (
            <tr key={c.id} className={c.status}>
              <td className="icon" aria-label={c.status}>
                {STATUS_ICON[c.status]}
              </td>
              <th scope="row">{c.label}</th>
              <td>{c.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {checks.length === 0 && <p>確認しています…</p>}
      <PlaybackTest />
    </main>
  );
}

/** Chrome and Edge also put "Safari" in their UA, and Safari's own version is in "Version/". */
export function browserName(ua: string): string {
  const pick = (re: RegExp, name: string) => {
    const m = ua.match(re);
    return m ? `${name} ${m[1]}` : null;
  };
  return (
    pick(/Edg\/([\d.]+)/, "Edge") ??
    pick(/Chrome\/([\d.]+)/, "Chrome") ??
    pick(/Firefox\/([\d.]+)/, "Firefox") ??
    pick(/Version\/([\d.]+).*Safari\//, "Safari") ??
    "不明なブラウザ"
  );
}

async function runWorkerChecks(): Promise<CheckResult[]> {
  const worker = new Worker(new URL("../workers/dsp.worker.ts", import.meta.url), { type: "module" });
  const dsp = new WorkerClient<DspMethods>(worker);
  try {
    const { engineVersion, simd } = await dsp.call("init", undefined);
    const t = await dsp.call("selfTest", undefined);
    const levelsOk = Math.abs(t.rmsDbfs + 3.0103) < 0.01 && Math.abs(t.peakDbfs) < 0.01;
    return [
      {
        id: "wasm",
        label: "DSP エンジン（WASM）",
        status: simd ? "ok" : "warn",
        detail: `akdsp ${engineVersion} を Worker で読み込み・SIMD ${simd ? "有効" : "無効"}`,
      },
      {
        id: "dsp",
        label: "DSP の動作確認",
        status: levelsOk ? "ok" : "error",
        detail: `1 kHz 正弦波：RMS ${t.rmsDbfs.toFixed(2)} dBFS（期待値 -3.01）、ピーク ${t.peakDbfs.toFixed(2)} dBFS（期待値 0.00）`,
      },
      { id: "opfs-write", label: "OPFS の書き込み（Worker）", status: t.opfs.ok ? "ok" : "error", detail: t.opfs.detail },
    ];
  } catch (e) {
    const message = typeof e === "object" && e && "message" in e ? String(e.message) : String(e);
    return [{ id: "wasm", label: "DSP エンジン（WASM）", status: "error", detail: message }];
  } finally {
    worker.terminate();
  }
}
