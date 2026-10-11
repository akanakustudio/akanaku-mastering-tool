// Single-track mastering screen (MVP of S-02/S-03/S-05: basic design 10, detailed design 16).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Mode, type ModeValue } from "../audio/layout";
import { Player } from "../audio/player";
import { Waveform, type DiffKind, type Layout, type Source } from "../features/waveform/Waveform";
import { WorkerClient } from "../orchestrator/workerClient";
import type { Analysis, DspMethods, LoadResult, MasterSettings, RenderResult } from "../workers/protocol";
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

const MODE_LABEL: Record<ModeValue, string> = { [Mode.BEFORE]: "Before", [Mode.AFTER]: "After", [Mode.DELTA]: "差分" };
const LAYOUTS: { id: Layout; label: string }[] = [
  { id: "single", label: "切り替え" },
  { id: "overlay", label: "重ね" },
  { id: "stacked", label: "上下に並べる" },
];

type Track = Omit<LoadResult, "audio"> & { name: string };
type Rendered = Omit<RenderResult, "audio">;
type Status = { kind: "idle" } | { kind: "busy"; label: string } | { kind: "error"; message: string };

const fmt = (v: number, digits = 1) => (Number.isFinite(v) ? v.toFixed(digits) : "-∞");

export function MasteringApp() {
  const dsp = useMemo(() => new WorkerClient<DspMethods>(new Worker(new URL("../workers/dsp.worker.ts", import.meta.url), { type: "module" })), []);
  const [checks, setChecks] = useState<CheckResult[]>([]);
  const [track, setTrack] = useState<Track | null>(null);
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [player, setPlayer] = useState<Player | null>(null);
  const [settings, setSettings] = useState<MasterSettings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [mode, setMode] = useState<ModeValue>(Mode.AFTER);
  const [playing, setPlaying] = useState(false);
  const [loudnessMatch, setLoudnessMatch] = useState(true);
  const [mono, setMono] = useState(false);
  const [layout, setLayout] = useState<Layout>("stacked");
  const [diffKind, setDiffKind] = useState<DiffKind>("gain");
  const [stacked, setStacked] = useState<Record<Source, boolean>>({ before: true, after: true, diff: true });
  const [exportRate, setExportRate] = useState(44_100);
  const [exportBits, setExportBits] = useState<16 | 24>(24);
  const [dragging, setDragging] = useState(false);
  const timeRef = useRef<HTMLSpanElement>(null);
  const renderSeq = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    runMainThreadChecks().then(setChecks);
  }, []);
  const blocking = checks.filter((c) => c.status === "error");

  // Loudness-matched comparison (detailed design 12.3): Before and Delta are scaled to After's loudness.
  useEffect(() => {
    if (!player || !track || !rendered) return;
    const g = loudnessMatch ? 10 ** ((rendered.after.lufs - track.before.lufs) / 20) : 1;
    player.setGains(g, g);
  }, [player, track, rendered, loudnessMatch]);

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
      setPlaying(false);
      setMode(Mode.AFTER);
      firstRender.current = true;
      await runRender(settings, p);
    } catch (e) {
      setStatus({ kind: "error", message: errorText(e) });
    }
  };

  const togglePlay = async () => {
    if (!player) return;
    await player.start();
    if (player.playing) player.pause();
    else player.play();
    setPlaying(player.playing);
  };
  const chooseMode = (m: ModeValue) => {
    player?.setMode(m);
    setMode(m);
  };

  // Playhead time and play state, read from shared memory every frame.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (player && timeRef.current) timeRef.current.textContent = clock(player.position / 48_000);
      if (player && player.playing !== playing) setPlaying(player.playing);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [player, playing]);

  // Keyboard shortcuts (basic design 10.6).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "SELECT" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === "Space") {
        e.preventDefault();
        void togglePlay();
      } else if (e.key === "1") chooseMode(Mode.BEFORE);
      else if (e.key === "2") chooseMode(Mode.AFTER);
      else if (e.key === "3") chooseMode(Mode.DELTA);
      else if (e.key === "t" || e.key === "`") chooseMode(mode === Mode.AFTER ? Mode.BEFORE : Mode.AFTER);
      else if (e.key === "m") setLoudnessMatch((v) => !v);
      else if (e.key === "v") setLayout((l) => LAYOUTS[(LAYOUTS.findIndex((x) => x.id === l) + 1) % LAYOUTS.length].id);
      else if (e.key === "d") setDiffKind((k) => (k === "gain" ? "signal" : "gain"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

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
          <section className="transport">
            <button className="play" onClick={togglePlay} disabled={!player}>
              {playing ? "■ 停止" : "▶ 再生"}
            </button>
            <span className="segmented" role="radiogroup" aria-label="再生モード">
              {([Mode.BEFORE, Mode.AFTER, Mode.DELTA] as ModeValue[]).map((m, i) => (
                <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? "on" : ""} onClick={() => chooseMode(m)} title={`キー ${i + 1}`}>
                  {MODE_LABEL[m]}
                </button>
              ))}
            </span>
            <label title="キー M">
              <input type="checkbox" checked={loudnessMatch} onChange={() => setLoudnessMatch(!loudnessMatch)} /> 音量を合わせて比較
            </label>
            <label>
              <input
                type="checkbox"
                checked={mono}
                onChange={() => {
                  player?.setMono(!mono);
                  setMono(!mono);
                }}
              />{" "}
              モノラル
            </label>
            <span className="time">
              <span ref={timeRef}>0:00.0</span> / {clock(track.frames / track.sampleRate)}
            </span>
          </section>

          <section className="view-controls">
            <span className="segmented" role="radiogroup" aria-label="波形の表示方法">
              {LAYOUTS.map((l) => (
                <button key={l.id} role="radio" aria-checked={layout === l.id} className={layout === l.id ? "on" : ""} onClick={() => setLayout(l.id)} title="キー V">
                  {l.label}
                </button>
              ))}
            </span>
            {layout !== "single" && (
              <span className="checks">
                {(layout === "stacked" ? (["before", "after", "diff"] as Source[]) : (["diff"] as Source[])).map((s) => (
                  <label key={s}>
                    <input type="checkbox" checked={stacked[s]} onChange={() => setStacked({ ...stacked, [s]: !stacked[s] })} /> {{ before: "Before", after: "After", diff: "差分" }[s]}
                  </label>
                ))}
              </span>
            )}
            <span className="segmented" role="radiogroup" aria-label="差分の表し方">
              <button role="radio" aria-checked={diffKind === "gain"} className={diffKind === "gain" ? "on" : ""} onClick={() => setDiffKind("gain")} title="キー D">
                差分：音量の変化
              </button>
              <button role="radio" aria-checked={diffKind === "signal"} className={diffKind === "signal" ? "on" : ""} onClick={() => setDiffKind("signal")} title="キー D">
                差分：信号
              </button>
            </span>
            {layout === "single" && <span className="note">「切り替え」は再生モード（Before / After / 差分）に連動します</span>}
          </section>

          <Waveform
            totalFrames={track.frames}
            sampleRate={track.sampleRate}
            before={track.peaks}
            after={rendered?.peaks.after ?? null}
            diff={rendered?.peaks.diff ?? null}
            gainDelta={rendered?.gainDelta ?? null}
            player={player}
            mode={mode}
            layout={layout}
            diffKind={diffKind}
            stacked={stacked}
            busy={busy}
          />

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
              <table className="meters">
                <thead>
                  <tr>
                    <th />
                    <th>Before</th>
                    <th>After</th>
                  </tr>
                </thead>
                <tbody>
                  <MeterRow label="ラウドネス（LUFS）" b={track.before} a={rendered?.after} k="lufs" />
                  <MeterRow label="True Peak（dBTP）" b={track.before} a={rendered?.after} k="truePeak" />
                  <MeterRow label="PLR（dB）" b={track.before} a={rendered?.after} k="plr" />
                  <MeterRow label="盛り上がり部の音量 L95" b={track.before} a={rendered?.after} k="l95" />
                  <MeterRow label="ラウドネスレンジ LRA（LU）" b={track.before} a={rendered?.after} k="lra" />
                </tbody>
              </table>
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

function MeterRow({ label, b, a, k }: { label: string; b: Analysis; a?: Analysis; k: keyof Analysis }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{fmt(b[k] as number)}</td>
      <td>{a ? fmt(a[k] as number) : "…"}</td>
    </tr>
  );
}

function clock(sec: number) {
  const m = Math.floor(sec / 60);
  return `${m}:${(sec - m * 60).toFixed(1).padStart(4, "0")}`;
}

function errorText(e: unknown) {
  if (typeof e === "object" && e && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
