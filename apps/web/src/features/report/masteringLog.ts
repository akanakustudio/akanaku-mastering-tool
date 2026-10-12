// Mastering log written next to exported audio: what was done to each original file, in order,
// with the actual values (shared by the single and album exports; also used inside the worker).
import type { Analysis, ChainStats, MasterSettings, RenderReport } from "../../workers/protocol";

export const LOG_TXT = "mastering-log.txt";
export const LOG_JSON = "mastering-log.json";

export type Levels = { lufs: number; truePeak: number; plr: number; l95: number; lra: number };

export type TrackLog = {
  no?: number;
  title: string;
  source: { fileName: string; sizeBytes: number; sha256: string; sampleRateIn: number; channelsIn: number; durationSec: number };
  before: Levels;
  settings: MasterSettings;
  report: RenderReport;
  stats?: Pick<ChainStats, "makeupDb" | "bandLevelsDb">;
  after: Levels;
  album?: { role: "anchor" | "track"; goalL95?: number; offsetDb: number; gapAfterSec: number; fadeInSec: number; fadeOutSec: number; albumToneMaxDb?: number };
  /** Filled in when the file is written. */
  output?: { fileName: string; truePeakDbtp: number };
};

export type MasteringLog = {
  format: "akmaster-log";
  version: 1;
  tool: { name: string; engineVersion: string };
  exportedAt: string;
  export: { sampleRate: number; bits: 16 | 24; dither: string; ceilingDbtp: number };
  album?: {
    title: string;
    keepDifference: number;
    harmonize: number;
    anchorTitle: string;
    totalSec: number;
    continuousFile?: string;
    cueFile?: string;
  };
  tracks: TrackLog[];
};

export const levelsOf = (a: Analysis): Levels => ({ lufs: a.lufs, truePeak: a.truePeak, plr: a.plr, l95: a.l95, lra: a.lra });

export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const n1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : "-∞");
const signed = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const clock = (sec: number) => `${Math.floor(sec / 60)}:${(sec % 60).toFixed(1).padStart(4, "0")}`;
const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;
const hz = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10_000 ? 0 : 1)} kHz` : `${Math.round(f)} Hz`);
const levels = (l: Levels) => `${n1(l.lufs)} LUFS ／ True Peak ${n1(l.truePeak)} dBTP ／ PLR ${n1(l.plr)} dB ／ L95 ${n1(l.l95)} LUFS ／ LRA ${n1(l.lra)} LU`;

function localTime(iso: string) {
  const d = new Date(iso);
  const p = (x: number) => String(x).padStart(2, "0");
  const tz = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}（UTC${tz >= 0 ? "+" : "-"}${p(Math.floor(Math.abs(tz) / 60))}:${p(Math.abs(tz) % 60)}）`;
}

function toneLines(t: TrackLog): string[] {
  const { toneCurve, toneFreqs } = t.report;
  const lines: string[] = [];
  if (!toneCurve.length || toneCurve.every((v) => Math.abs(v) < 0.05)) return ["補正なし"];
  let cut = 0,
    cutAt = 0,
    boost = 0,
    boostAt = 0;
  toneCurve.forEach((v, i) => {
    if (v < cut) [cut, cutAt] = [v, toneFreqs[i]];
    if (v > boost) [boost, boostAt] = [v, toneFreqs[i]];
  });
  lines.push(`最大カット ${cut.toFixed(1)} dB（${hz(cutAt)}）、最大ブースト ${signed(boost)} dB（${boost > 0 ? hz(boostAt) : "なし"}）`);
  const pts = toneCurve.map((v, i) => [toneFreqs[i], v] as const).filter(([, v]) => Math.abs(v) >= 0.3);
  if (pts.length) lines.push(`補正カーブ（±0.3 dB 以上の点）：${pts.map(([f, v]) => `${hz(f)} ${signed(v)}`).join("、")}`);
  return lines;
}

function trackText(t: TrackLog, log: MasteringLog): string {
  const s = t.settings;
  const r = t.report;
  const L: string[] = [];
  const head = t.no !== undefined ? `[${String(t.no).padStart(2, "0")}] ${t.title}` : t.title;
  L.push(head, "-".repeat(Math.min(60, head.length * 2)));
  const src = t.source;
  L.push(`元のファイル：${src.fileName}`);
  L.push(`  ${src.sampleRateIn / 1000} kHz・${src.channelsIn === 1 ? "モノラル" : "ステレオ"}・${mb(src.sizeBytes)}・${clock(src.durationSec)}`);
  L.push(`  SHA-256：${src.sha256}`);
  L.push(`処理前：${levels(t.before)}`);
  if (t.album) {
    L.push(
      t.album.role === "anchor"
        ? `アルバムでの役割：基準曲（曲全体のラウドネスを ${n1(s.targetLufs)} LUFS に合わせる）`
        : `アルバムでの役割：盛り上がり部（L95）を ${n1(t.album.goalL95 ?? s.targetLufs)} LUFS に合わせる`,
    );
    if (t.album.offsetDb) L.push(`  曲ごとの音量の補正：${signed(t.album.offsetDb)} dB`);
  }
  L.push("処理の内容（この順に適用）：");
  let k = 0;
  const step = (title: string, ...detail: string[]) => {
    k++;
    L.push(`  ${k}. ${title}`);
    for (const d of detail) L.push(`     ${d}`);
  };
  step("読み込み", src.sampleRateIn === 48_000 ? "48 kHz のまま内部形式（32 bit 浮動小数点）に変換" : `${src.sampleRateIn / 1000} kHz → 48 kHz にサンプルレート変換し、内部形式（32 bit 浮動小数点）に変換`);
  step(
    `ノイズ除去（Cleanup）${pct(s.cleanup)}`,
    s.cleanup > 0
      ? `4〜16 kHz を倍音・アタック・ノイズ的成分に分け、ノイズ的成分（ザラザラ・サ行）を ${(-10 * s.cleanup).toFixed(1)} dB、アタック成分（タ行など）を ${(-3.5 * s.cleanup).toFixed(1)} dB。倍音成分はそのまま`
      : "なし",
  );
  const album = s.albumTone && s.albumTone.some((v) => Math.abs(v) >= 0.05);
  step(
    `自動トーン補正 ${pct(s.toneMatch)}${album ? `＋アルバムの音色そろえ（最大 ±${(t.album?.albumToneMaxDb ?? 0).toFixed(1)} dB）` : ""}`,
    "リニアフェーズ EQ。周波数の出っ張り・へこみを曲自身の大まかな傾向に向けてならす（4 kHz より上は下げるだけ）",
    ...toneLines(t),
  );
  step(
    `音色（Warm ⇔ Bright）${s.tone > 0 ? "+" : ""}${Math.round(s.tone * 100)}`,
    s.tone === 0 ? "なし" : `6 kHz のハイシェルフ ${signed(2 * s.tone)} dB、200 Hz のローシェルフ ${signed(-s.tone)} dB`,
  );
  if (s.multiband) {
    const [gl, gm, gh] = r.bandGainReductionDb.map(Math.abs);
    const mk = t.stats?.makeupDb;
    step(
      `マルチバンドコンプ（低 〜150 Hz ／ 中 150 Hz〜3 kHz ／ 高 3 kHz〜）パンチ ${pct(s.punch)}`,
      `平均リダクション：低 ${gl.toFixed(1)} ／ 中 ${gm.toFixed(1)} ／ 高 ${gh.toFixed(1)} dB`,
      ...(mk ? [`メイクアップ（帯域ごとの平均レベルを保つ）：低 ${signed(mk[0])} ／ 中 ${signed(mk[1])} ／ 高 ${signed(mk[2])} dB`] : []),
    );
  } else {
    step("マルチバンドコンプ", "なし");
  }
  step(`ステレオ：広がり ${pct(s.width)}`, s.monoBelowHz > 0 ? `${s.monoBelowHz} Hz 以下をモノラル化` : "低音のモノラル化なし");
  step(
    `True Peak リミッター（上限 ${n1(s.ceilingDbtp)} dBTP、4 倍オーバーサンプリング）`,
    `目標：${s.targetMode === "l95" ? `盛り上がり部（L95）${n1(s.targetLufs)} LUFS` : `曲全体 ${n1(s.targetLufs)} LUFS`}`,
    `入力ゲイン ${signed(r.appliedGainDb)} dB、最大リダクション ${Math.abs(r.maxGainReductionDb).toFixed(1)} dB、平均リダクション ${Math.abs(r.meanGainReductionDb).toFixed(2)} dB（調整 ${r.iterations} 回）`,
    r.truePeakTrimDb < 0 ? `上限を確実に守るための追加の音量調整 ${r.truePeakTrimDb.toFixed(2)} dB` : "追加の音量調整なし",
  );
  if (t.album && (t.album.fadeInSec > 0 || t.album.fadeOutSec > 0)) {
    step("フェード", `イン ${t.album.fadeInSec} 秒 ／ アウト ${t.album.fadeOutSec} 秒（なめらかな S 字カーブ）`);
  }
  const e = log.export;
  step(
    `書き出し：WAV ${e.sampleRate / 1000} kHz ／ ${e.bits} bit`,
    e.sampleRate === 48_000 ? "サンプルレート変換なし" : `48 kHz → ${e.sampleRate / 1000} kHz にサンプルレート変換（変換後に True Peak を再確認）`,
    `ディザ：${e.dither}`,
    ...(t.output ? [`書き出したファイルの True Peak：${t.output.truePeakDbtp.toFixed(2)} dBTP`] : []),
  );
  L.push(`処理後（48 kHz の時点）：${levels(t.after)}`);
  if (t.output) L.push(`出力ファイル：${t.output.fileName}`);
  if (t.album && t.album.gapAfterSec > 0) L.push(`次の曲までの曲間：${t.album.gapAfterSec} 秒`);
  return L.join("\n");
}

/** Human-readable log (Japanese). The JSON file holds the same `MasteringLog` object. */
export function formatLog(log: MasteringLog): string {
  const L: string[] = [];
  L.push(`${log.tool.name} マスタリング処理ログ`, "=".repeat(40));
  L.push(`書き出し日時：${localTime(log.exportedAt)}`);
  L.push(`処理エンジン：akdsp ${log.tool.engineVersion}`);
  L.push(`書き出し形式：WAV ${log.export.sampleRate / 1000} kHz ／ ${log.export.bits} bit、ディザ ${log.export.dither}、True Peak 上限 ${n1(log.export.ceilingDbtp)} dBTP`);
  L.push("元のファイルは変更していません。以下は各ファイルに適用した処理と、その前後の測定値です。");
  if (log.album) {
    const a = log.album;
    L.push("", `アルバム：${a.title}（${log.tracks.length} 曲・${clock(a.totalSec)}）`);
    L.push(`  基準曲：${a.anchorTitle}`);
    L.push(`  元の音量差を残す割合：${pct(a.keepDifference)}`);
    L.push(`  曲どうしの音色をそろえる強さ：${pct(a.harmonize)}`);
    L.push(`  曲順：${log.tracks.map((t) => `${String(t.no).padStart(2, "0")} ${t.title}`).join(" → ")}`);
    if (a.continuousFile) L.push(`  全曲をつないだファイル：${a.continuousFile}${a.cueFile ? `（CUE シート：${a.cueFile}）` : ""}`);
  }
  for (const t of log.tracks) L.push("", trackText(t, log));
  L.push("", "測定の基準：ラウドネスは ITU-R BS.1770-4（LUFS）、True Peak は 4 倍オーバーサンプリング、L95 は 3 秒ごとのラウドネスの 95 パーセンタイル。");
  return L.join("\n") + "\n";
}
