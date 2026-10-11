// Startup checks (detailed design 16.0).

export const EXPECTED_ORIGIN = "http://localhost:5173";

export type CheckStatus = "ok" | "warn" | "error";
export type CheckResult = { id: string; label: string; status: CheckStatus; detail: string };

// Smallest module using a SIMD instruction (i8x16.splat + i8x16.popcnt).
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

const MIN_FREE_BYTES = 2 * 1024 ** 3;

export async function runMainThreadChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const add = (id: string, label: string, status: CheckStatus, detail: string) =>
    results.push({ id, label, status, detail });

  add(
    "isolation",
    "クロスオリジン分離（SharedArrayBuffer）",
    globalThis.crossOriginIsolated ? "ok" : "error",
    globalThis.crossOriginIsolated ? "有効" : "無効：COOP/COEP ヘッダーが付いていません（npm start で起動してください）",
  );

  add(
    "simd",
    "WebAssembly SIMD",
    WebAssembly.validate(SIMD_PROBE) ? "ok" : "error",
    WebAssembly.validate(SIMD_PROBE) ? "対応" : "非対応：最新の Chrome / Edge / Safari を使ってください",
  );

  const hasWorklet = typeof AudioContext !== "undefined" && "audioWorklet" in AudioContext.prototype;
  add("worklet", "AudioWorklet", hasWorklet ? "ok" : "error", hasWorklet ? "対応" : "非対応");

  const hasOpfs = typeof navigator.storage?.getDirectory === "function";
  add("opfs", "OPFS（ブラウザ内ファイルシステム）", hasOpfs ? "ok" : "error", hasOpfs ? "対応（書き込みは Worker のテストで確認）" : "非対応");

  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    const free = quota - usage;
    const persisted = await navigator.storage.persisted();
    add(
      "storage",
      "ストレージの空き",
      free >= MIN_FREE_BYTES ? "ok" : "warn",
      `空き ${formatBytes(free)}（使用 ${formatBytes(usage)} / 上限 ${formatBytes(quota)}）・永続化 ${persisted ? "許可済み" : "未許可"}`,
    );
  } catch (e) {
    add("storage", "ストレージの空き", "warn", `取得できません：${String(e)}`);
  }

  add(
    "origin",
    "起動 URL",
    location.origin === EXPECTED_ORIGIN ? "ok" : "warn",
    location.origin === EXPECTED_ORIGIN
      ? location.origin
      : `${location.origin} で開いています。保存したデータは ${EXPECTED_ORIGIN} でしか見えません（W-BR-002）`,
  );

  return results;
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}
