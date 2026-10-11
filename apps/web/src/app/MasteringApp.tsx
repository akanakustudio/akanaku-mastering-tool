// Single-track mastering screen (MVP of S-02/S-03/S-05: basic design 10, detailed design 16).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Player } from "../audio/player";
import { MeterTable, TrackView } from "../features/trackview/TrackView";
import { WorkerClient } from "../orchestrator/workerClient";
import type { DspMethods, LoadResult, MasterSettings, RenderResult } from "../workers/protocol";
import { runMainThreadChecks, type CheckResult } from "./envCheck";
import "./MasteringApp.css";

const DEFAULT_SETTINGS: MasterSettings = { cleanup: 0.5, tone: 0, width: 1, monoBelowHz: 120, targetLufs: -14, ceilingDbtp: -1 };

const LOUDNESS_PRESETS = [
  { lufs: -14, label: "Streaming（-14 LUFS）" },
  { lufs: -16, label: "Apple Music（-16 LUFS）" },
  { lufs: -10, label: "Loud（-10 LUFS）" },
  { lufs: -17, label: "Dynamic（-17 LUFS）" },
];

const STAGE_LABEL: Record<string, string> = {
  cleanup: "ノイズ除去",
  tone: "音色・ステレオ",
  limiter: "音圧調整",
  verify: "ピークの確認",
  display: "波形の準備",
  encode: "書き出し",
};

type Track = Omit<LoadResult, "audio"> & { name: string };
type Rendered = Omit<RenderResult, "audio">;
type Status = { kind: "idle" } | { kind: "busy"; label: string } | { kind: "error"; message: string };

const fmt = (v: number, digits = 1) => (Number.isFinite(v) ? v.toFixed(digits) : "-∞");

export function MasteringApp({ active = true }: { active?: boolean }) {
  const dsp = useMemo(() => new WorkerClient<DspMethods>(new Worker(new URL("../workers/dsp.worker.ts", import.meta.url), { type: "module" })), []);
  const [checks, setChecks] = useState<CheckResult[]>([]);
  const [track, setTrack] = useState<Track | null>(null);
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [player, setPlayer] = useState<Player | null>(null);
  const [settings, setSettings] = useState<MasterSettings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [exportRate, setExportRate] = useState(44_100);
  const [exportBits, setExportBits] = useState<16 | 24>(24);
  const [dragging, setDragging] = useState(false);
  const renderSeq = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    runMainThreadChecks().then(setChecks);
  }, []);
  useEffect(() => {
    if (!active) player?.pause();
  }, [active, player]);
  const blocking = checks.filter((c) => c.status === "error");

  const runRender = useCallback(
    async (s: MasterSettings, p: Player) => {
      const seq = ++renderSeq.current;
      setStatus({ kind: "busy", label: "マスタリング中…" });
      try {
        const res = await dsp.call("render", { settings: s }, [], (stage, f) => {
          if (seq === renderSeq.current) setStatus({ kind: "busy", label: `${STAGE_LABEL[stage] ?? stage}${f > 0 ? ` ${Math.round(f * 100)}%` : ""}…` });
        });
        if (seq !== renderSeq.current) return; // a newer render was requested meanwhile
        await p.replaceAfter(res.audio);
        const { audio: _audio, ...rest } = res;
        setRendered(rest);
        setStatus({ kind: "idle" });
      } catch (e) {
        if (seq === renderSeq.current) setStatus({ kind: "error", message: errorText(e) });
      }
    },
    [dsp],
  );

  // Re-render when settings change (debounced).
  const firstRender = useRef(true);
  useEffect(() => {
    if (!player) return;
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const t = setTimeout(() => runRender(settings, player), 400);
    return () => clearTimeout(t);
  }, [settings, player, runRender]);

  const openFile = async (file: File) => {
    setStatus({ kind: "busy", label: `${file.name} を読み込み中…` });
    try {
      const bytes = await file.arrayBuffer();
      const res = await dsp.call("load", { bytes, name: file.name }, [bytes]);
      await player?.close();
      const p = new Player(res.audio, res.audio);
      const { audio: _audio, ...info } = res;
      setTrack({ ...info, name: file.name });
      setRendered(null);
      setPlayer(p);
      firstRender.current = true;
      await runRender(settings, p);
    } catch (e) {
      setStatus({ kind: "error", message: errorText(e) });
    }
  };

  const exportWav = async () => {
    if (!track) return;
    setStatus({ kind: "busy", label: "書き出し中…" });
    try {
      const { bytes } = await dsp.call("exportWav", { sampleRate: exportRate, bits: exportBits });
      const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${track.name.replace(/\.[^.]+$/, "")} (akanaku master ${exportRate / 1000}k-${exportBits}bit).wav`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setStatus({ kind: "idle" });
    } catch (e) {
      setStatus({ kind: "error", message: errorText(e) });
    }
  };

  const set = (patch: Partial<MasterSettings>) => setSettings((s) => ({ ...s, ...patch }));
  const busy = status.kind === "busy";

  return (
    <div
      className={`app${dragging ? " dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const f = e.dataTransfer.files[0];
        if (f) void openFile(f);
      }}
    >
      <header className="app-header">
        <h1>akanaku mastering</h1>
        <div className="file">
          {track ? <span className="name">{track.name}</span> : <span className="hint">音源ファイルをドロップするか、選んでください</span>}
          <button onClick={() => fileInput.current?.click()} disabled={busy}>
            ファイルを開く
          </button>
          <input
            ref={fileInput}
            type="file"
            hidden
            accept="audio/*,.wav,.aif,.aiff,.flac,.mp3,.m4a"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void openFile(f);
              e.target.value = "";
            }}
          />
        </div>
        <span className={`status ${status.kind}`} role="status">
          {status.kind === "busy" ? status.label : status.kind === "error" ? status.message : track ? "準備完了" : ""}
        </span>
      </header>

      {blocking.length > 0 && (
        <div className="banner error">
          このブラウザでは使えません（E-BR-001）：{blocking.map((c) => `${c.label}（${c.detail}）`).join("、")}
        </div>
      )}
      {checks.find((c) => c.id === "origin" && c.status !== "ok") && <div className="banner warn">{checks.find((c) => c.id === "origin")!.detail}</div>}

      {!track ? (
        <section className="empty">
          <p>Suno で書き出した WAV（MP3・FLAC・AIFF・M4A も可）をここにドロップしてください。</p>
          <p className="sub">読み込むと自動でマスタリングし、処理前と処理後を聴き比べられます。音源はこのブラウザの外には送信されません。</p>
          <p className="sub">
            <a href="#p0">P0 検証ページ</a>
          </p>
        </section>
      ) : (
        <main className="workspace">
          <TrackView track={track} rendered={rendered} player={player} busy={busy} active={active} />

          <div className="panels">
            <section className="panel">
              <h2>調整</h2>
              <Slider label="ノイズ除去（Cleanup）" hint="シャリシャリ・ザラザラを抑える強さ" value={Math.round(settings.cleanup * 100)} min={0} max={100} step={5} unit="%" onChange={(v) => set({ cleanup: v / 100 })} />
              <Slider label="音色（Warm ⇔ Bright）" hint="マイナスで柔らかく、プラスで明るく" value={Math.round(settings.tone * 100)} min={-100} max={100} step={5} unit="" onChange={(v) => set({ tone: v / 100 })} />
              <Slider label="ステレオの広がり（Width）" hint="100% がそのまま" value={Math.round(settings.width * 100)} min={0} max={150} step={5} unit="%" onChange={(v) => set({ width: v / 100 })} />
              <label className="field">
                <span>低音のモノラル化</span>
                <select value={settings.monoBelowHz} onChange={(e) => set({ monoBelowHz: Number(e.target.value) })}>
                  <option value={0}>しない</option>
                  <option value={80}>80 Hz 以下</option>
                  <option value={120}>120 Hz 以下</option>
                  <option value={160}>160 Hz 以下</option>
                </select>
              </label>
              <label className="field">
                <span>音圧の目標（Loudness）</span>
                <select value={settings.targetLufs} onChange={(e) => set({ targetLufs: Number(e.target.value) })}>
                  {LOUDNESS_PRESETS.map((p) => (
                    <option key={p.lufs} value={p.lufs}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="sub">True Peak の上限：{settings.ceilingDbtp.toFixed(1)} dBTP</p>
              <button className="reset" onClick={() => setSettings(DEFAULT_SETTINGS)} disabled={busy}>
                初期値に戻す
              </button>
            </section>

            <section className="panel">
              <h2>測定値</h2>
              <MeterTable before={track.before} after={rendered?.after} />
              {rendered && (
                <p className="sub">
                  リミッター：入力ゲイン {rendered.report.appliedGainDb >= 0 ? "+" : ""}
                  {fmt(rendered.report.appliedGainDb)} dB、最大リダクション {fmt(rendered.report.maxGainReductionDb)} dB
                </p>
              )}
              <p className="sub">
                入力：{track.sampleRateIn / 1000} kHz・{track.channelsIn === 1 ? "モノラル" : "ステレオ"}
              </p>
            </section>

            <section className="panel">
              <h2>書き出し</h2>
              <label className="field">
                <span>サンプルレート</span>
                <select value={exportRate} onChange={(e) => setExportRate(Number(e.target.value))}>
                  <option value={44_100}>44.1 kHz（配信向け）</option>
                  <option value={48_000}>48 kHz</option>
                </select>
              </label>
              <label className="field">
                <span>ビット深度</span>
                <select value={exportBits} onChange={(e) => setExportBits(Number(e.target.value) as 16 | 24)}>
                  <option value={24}>24 bit</option>
                  <option value={16}>16 bit（ディザあり）</option>
                </select>
              </label>
              <button className="primary" onClick={exportWav} disabled={busy || !rendered}>
                WAV を書き出す
              </button>
            </section>
          </div>
          <p className="shortcuts">ショートカット：Space 再生/停止 ・ 1 / 2 / 3 Before / After / 差分 ・ T 切り替え ・ M 音量合わせ ・ V 表示方法 ・ D 差分の表し方 ・ ⌘＋スクロール 拡大縮小</p>
        </main>
      )}
    </div>
  );
}

function Slider(p: { label: string; hint: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void }) {
  return (
    <label className="slider">
      <span className="label">
        {p.label}
        <span className="value">
          {p.value > 0 && p.min < 0 ? "+" : ""}
          {p.value}
          {p.unit}
        </span>
      </span>
      <input type="range" min={p.min} max={p.max} step={p.step} value={p.value} onChange={(e) => p.onChange(Number(e.target.value))} />
      <span className="hint">{p.hint}</span>
    </label>
  );
}

function errorText(e: unknown) {
  if (typeof e === "object" && e && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
