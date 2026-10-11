import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/features/settings/settings";
import { formatLog, sha256Hex, type MasteringLog, type TrackLog } from "../src/features/report/masteringLog";

const levels = (lufs: number) => ({ lufs, truePeak: lufs + 13, plr: 13, l95: lufs + 3, lra: 5 });

const track = (over: Partial<TrackLog> = {}): TrackLog => ({
  title: "テクスチャ",
  source: { fileName: "テクスチャ.wav", sizeBytes: 42_336_044, sha256: "ab".repeat(32), sampleRateIn: 44_100, channelsIn: 2, durationSec: 240 },
  before: levels(-11.2),
  settings: { ...DEFAULT_SETTINGS },
  report: {
    appliedGainDb: -2.6,
    iterations: 4,
    truePeakTrimDb: -0.02,
    meanGainReductionDb: 0.41,
    maxGainReductionDb: -3.2,
    toneCurve: [0, -1.4, 0.8, 0.1],
    toneFreqs: [100, 6300, 250, 1000],
    bandGainReductionDb: [-1.1, -0.7, -0.4],
  },
  stats: { makeupDb: [0.6, 0.4, 0.2], bandLevelsDb: [-20, -18, -24] },
  after: levels(-14),
  output: { fileName: "テクスチャ (akanaku master 44.1k-24bit).wav", truePeakDbtp: -1.04 },
  ...over,
});

const log = (tracks: TrackLog[], album?: MasteringLog["album"]): MasteringLog => ({
  format: "akmaster-log",
  version: 1,
  tool: { name: "akanaku mastering tool", engineVersion: "0.1.0" },
  exportedAt: "2026-10-12T03:04:05.000Z",
  export: { sampleRate: 44_100, bits: 24, dither: "なし（24 bit）", ceilingDbtp: -1 },
  album,
  tracks,
});

describe("formatLog", () => {
  it("lists the source, every processing step in order, and the before/after levels", () => {
    const text = formatLog(log([track()]));
    expect(text).toContain("元のファイル：テクスチャ.wav");
    expect(text).toContain(`SHA-256：${"ab".repeat(32)}`);
    expect(text).toContain("44.1 kHz → 48 kHz にサンプルレート変換");
    expect(text).toContain("処理前：-11.2 LUFS");
    expect(text).toContain("処理後（48 kHz の時点）：-14.0 LUFS");
    expect(text).toContain("ノイズ的成分（ザラザラ・サ行）を -5.0 dB");
    expect(text).toContain("最大カット -1.4 dB（6.3 kHz）");
    expect(text).toContain("メイクアップ（帯域ごとの平均レベルを保つ）：低 +0.6");
    expect(text).toContain("120 Hz 以下をモノラル化");
    expect(text).toContain("入力ゲイン -2.6 dB、最大リダクション 3.2 dB");
    expect(text).toContain("平均リダクション：低 1.1 ／ 中 0.7 ／ 高 0.4 dB");
    expect(text).toContain("書き出したファイルの True Peak：-1.04 dBTP");
    const order = ["1. 読み込み", "2. ノイズ除去", "3. 自動トーン補正", "4. 音色", "5. マルチバンドコンプ", "6. ステレオ", "7. True Peak リミッター", "8. 書き出し"];
    const at = order.map((s) => text.indexOf(s));
    expect(at.every((v) => v >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("states disabled steps as なし", () => {
    const text = formatLog(log([track({ settings: { ...DEFAULT_SETTINGS, cleanup: 0, multiband: false, monoBelowHz: 0 } })]));
    expect(text).toMatch(/ノイズ除去（Cleanup）0%\n\s+なし/);
    expect(text).toMatch(/マルチバンドコンプ\n\s+なし/);
    expect(text).toContain("低音のモノラル化なし");
  });

  it("adds the album header, roles, fades and gaps", () => {
    const a = track({ no: 1, album: { role: "anchor", offsetDb: 0, gapAfterSec: 2, fadeInSec: 0, fadeOutSec: 0 } });
    const b = track({
      no: 2,
      title: "青に変わる",
      settings: { ...DEFAULT_SETTINGS, targetMode: "l95", targetLufs: -11.5 },
      album: { role: "track", goalL95: -11.5, offsetDb: -0.5, gapAfterSec: 0, fadeInSec: 0, fadeOutSec: 3 },
    });
    const text = formatLog(log([a, b], { title: "STILL UNDER MY SKIN", keepDifference: 0.3, harmonize: 0.5, anchorTitle: "テクスチャ", totalSec: 482 }));
    expect(text).toContain("アルバム：STILL UNDER MY SKIN（2 曲・8:02.0）");
    expect(text).toContain("曲順：01 テクスチャ → 02 青に変わる");
    expect(text).toContain("[01] テクスチャ");
    expect(text).toContain("基準曲（曲全体のラウドネスを -14.0 LUFS に合わせる）");
    expect(text).toContain("盛り上がり部（L95）を -11.5 LUFS に合わせる");
    expect(text).toContain("曲ごとの音量の補正：-0.5 dB");
    expect(text).toContain("フェード");
    expect(text).toContain("アウト 3 秒");
    expect(text).toContain("次の曲までの曲間：2 秒");
  });
});

describe("sha256Hex", () => {
  it("hashes file contents", async () => {
    expect(await sha256Hex(new Blob(["abc"]))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
