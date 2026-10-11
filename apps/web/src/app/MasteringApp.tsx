// Single-track mastering screen (MVP of S-02/S-03/S-05: basic design 10, detailed design 16).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Player } from "../audio/player";
import { DEFAULT_SETTINGS, regionLoudness } from "../features/settings/settings";
import { SettingsControls, ToneCurve } from "../features/settings/SettingsControls";
import { MeterTable, TrackView } from "../features/trackview/TrackView";
import { WorkerClient } from "../orchestrator/workerClient";
import { autosaver, clearWorkspace, deleteRendered, deleteSources, loadSource, loadWorkspace, storeSource } from "../storage/workspace";
import type { ChainStats, DspMethods, LoadResult, MasterSettings, RenderReport, RenderResult } from "../workers/protocol";
import { runMainThreadChecks, type CheckResult } from "./envCheck";
import "./MasteringApp.css";

const STAGE_LABEL: Record<string, string> = {
  cleanup: "ノイズ除去",
  tone: "音色・コンプ・ステレオ",
  limiter: "音圧調整",
  verify: "ピークの確認",
  display: "波形の準備",
  encode: "書き出し",
};

/** Region rendered first after a change: from 1 s before the playhead, 20 s long (detailed design 8.1). */
const REGION_BEFORE_S = 1;
const REGION_LENGTH_S = 20;

type Track = Omit<LoadResult, "audio"> & { name: string };
type Rendered = Omit<RenderResult, "audio">;
type Status = { kind: "idle" } | { kind: "busy"; label: string } | { kind: "provisional"; label: string } | { kind: "error"; message: string };

const fmt = (v: number, digits = 1) => (Number.isFinite(v) ? v.toFixed(digits) : "-∞");
const newWorker = () => new WorkerClient<DspMethods>(new Worker(new URL("../workers/dsp.worker.ts", import.meta.url), { type: "module" }));
const isCancel = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "E-CANCEL";

/** Rendered After is kept here so a restored session opens without rendering again. */
const SINGLE_AFTER = "single/after.f32";

/** Saved single-track session (IndexedDB "workspace"/"single"). */
type SavedSingle = {
  sourceId: string;
  name: string;
  settings: MasterSettings;
  exportRate: number;
  exportBits: 16 | 24;
  rendered?: { settingsJson: string; report: RenderReport; stats: ChainStats };
};
const save = autosaver("single");

export function MasteringApp({ active = true }: { active?: boolean }) {
  // One worker renders whole tracks, the other quick regions (detailed design 13.3: P0 / P1 jobs).
  const dsp = useMemo(newWorker, []);
  const regionDsp = useMemo(newWorker, []);
  const cancel = useMemo(() => new Int32Array(new SharedArrayBuffer(4)), []);
  const [checks, setChecks] = useState<CheckResult[]>([]);
  const [track, setTrack] = useState<Track | null>(null);
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [player, setPlayer] = useState<Player | null>(null);
  const [settings, setSettings] = useState<MasterSettings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [exportRate, setExportRate] = useState(44_100);
  const [exportBits, setExportBits] = useState<16 | 24>(24);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // Last full render: its statistics and settings feed region renders.
  const last = useRef<{ stats: ChainStats; settings: MasterSettings; shortTerm: number[] } | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [savedRender, setSavedRender] = useState<SavedSingle["rendered"]>(undefined);

  useEffect(() => {
    runMainThreadChecks().then(setChecks);
  }, []);
  useEffect(() => {
    if (!active) player?.pause();
  }, [active, player]);
  const blocking = checks.filter((c) => c.status === "error");

  /**
   * Re-render after a change: cancel any running render, render ~20 s around the playhead so the
   * change can be heard within a second or so, then render the whole track (detailed design 4.5, 13.3).
   */
  const runRender = useCallback(
    async (s: MasterSettings, p: Player, frames: number) => {
      const gen = Atomics.add(cancel, 0, 1) + 1;
      const current = () => Atomics.load(cancel, 0) === gen;
      const token = { sab: cancel, gen };
      try {
        const prev = last.current;
        if (prev) {
          setStatus({ kind: "busy", label: "再生位置の付近を処理中…" });
          const start = Math.max(0, p.position - REGION_BEFORE_S * 48_000);
          const end = Math.min(frames, start + REGION_LENGTH_S * 48_000);
          const goal = regionLoudness(prev.shortTerm, start, end, 48_000) + (s.targetLufs - prev.settings.targetLufs);
          const r = await regionDsp.call("renderRegion", { settings: s, start, end, regionLufsGoal: goal, stats: prev.stats, cancel: token });
          if (!current()) return;
          await p.spliceAfter(r.offset, r.left, r.right);
          if (!current()) return;
        }
        const label = prev ? "試聴用に再生位置の付近だけ処理済み。全体を処理中" : "マスタリング中";
        setStatus({ kind: prev ? "provisional" : "busy", label: `${label}…` });
        const res = await dsp.call("render", { settings: s, cancel: token, storePath: SINGLE_AFTER }, [], (stage, f) => {
          if (current()) setStatus({ kind: prev ? "provisional" : "busy", label: `${label}：${STAGE_LABEL[stage] ?? stage}${f > 0 ? ` ${Math.round(f * 100)}%` : ""}…` });
        });
        if (!current()) return;
        await p.replaceAfter(res.audio);
        const { audio: _audio, ...rest } = res;
        last.current = { stats: res.stats!, settings: s, shortTerm: res.after.shortTerm };
        setSavedRender({ settingsJson: JSON.stringify(s), report: res.report, stats: res.stats! });
        setRendered(rest);
        setStatus({ kind: "idle" });
      } catch (e) {
        if (!isCancel(e) && current()) setStatus({ kind: "error", message: errorText(e) });
      }
    },
    [dsp, regionDsp, cancel],
  );

  // Re-render when settings change (short debounce: the region render keeps it responsive).
  const firstRender = useRef(true);
  useEffect(() => {
    if (!player || !track) return;
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const t = setTimeout(() => runRender(settings, player, track.frames), 150);
    return () => clearTimeout(t);
  }, [settings, player, track, runRender]);

  /** Opens a song. With `restore`, reuses the saved settings and (if still valid) the saved render. */
  const openFile = async (file: File, restore?: SavedSingle) => {
    Atomics.add(cancel, 0, 1); // stop renders of the previous file
    setStatus({ kind: "busy", label: restore ? "前回の作業を復元中…" : `${file.name} を読み込み中…` });
    try {
      const id = restore?.sourceId ?? crypto.randomUUID();
      if (!restore) {
        await storeSource(id, file);
        if (sourceId) await deleteSources([sourceId]);
        await deleteRendered([SINGLE_AFTER]);
      }
      const s = restore?.settings ?? settings;
      const bytes = await file.arrayBuffer();
      const copy = bytes.slice(0);
      await regionDsp.call("loadSource", { bytes: copy, name: file.name }, [copy]);
      await player?.close();
      last.current = null;
      setSourceId(id);
      setSavedRender(undefined);
      firstRender.current = true;

      const saved = restore?.rendered;
      if (saved && saved.settingsJson === JSON.stringify(s)) {
        try {
          const { load, render } = await dsp.call("openStored", { file, key: "", path: SINGLE_AFTER, ceilingDbtp: s.ceilingDbtp });
          const p = new Player(load.audio, render.audio);
          const { audio: _a, ...info } = load;
          const { audio: _b, ...rest } = render;
          last.current = { stats: saved.stats, settings: s, shortTerm: render.after.shortTerm };
          setTrack({ ...info, name: file.name });
          setRendered({ ...rest, report: saved.report, stats: saved.stats });
          setSavedRender(saved);
          setPlayer(p);
          setStatus({ kind: "idle" });
          return;
        } catch {
          // Saved render missing or unreadable: render again below.
        }
      }
      const res = await dsp.call("load", { bytes, name: file.name }, [bytes]);
      const p = new Player(res.audio, res.audio);
      const { audio: _audio, ...info } = res;
      setTrack({ ...info, name: file.name });
      setRendered(null);
      setPlayer(p);
      await runRender(s, p, info.frames);
    } catch (e) {
      setStatus({ kind: "error", message: errorText(e) });
    }
  };

  // Restore the previous session once (detailed design 19.4).
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    void (async () => {
      const saved = await loadWorkspace<SavedSingle>("single");
      if (!saved) return;
      const file = await loadSource(saved.sourceId);
      if (!file) {
        setStatus({ kind: "error", message: "前回の音源がブラウザ内に見つかりません（E-SRC-001）。もう一度ファイルを開いてください" });
        return;
      }
      setSettings(saved.settings);
      setExportRate(saved.exportRate);
      setExportBits(saved.exportBits);
      await openFile(new File([file], saved.name, { type: file.type }), saved);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autosave (detailed design 13.1).
  useEffect(() => {
    if (!track || !sourceId) return;
    save({ sourceId, name: track.name, settings, exportRate, exportBits, rendered: savedRender } satisfies SavedSingle);
  }, [track, sourceId, settings, exportRate, exportBits, savedRender]);

  const closeTrack = async () => {
    if (!confirm("この曲を閉じますか？（保存されている作業も消えます）")) return;
    Atomics.add(cancel, 0, 1);
    await player?.close();
    setPlayer(null);
    setTrack(null);
    setRendered(null);
    last.current = null;
    if (sourceId) await deleteSources([sourceId]);
    await deleteRendered([SINGLE_AFTER]);
    await clearWorkspace("single");
    setSourceId(null);
    setStatus({ kind: "idle" });
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
  const busy = status.kind === "busy" || status.kind === "provisional";

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
          {track && (
            <button onClick={closeTrack} disabled={busy}>
              閉じる
            </button>
          )}
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
          {status.kind === "busy" || status.kind === "provisional" ? status.label : status.kind === "error" ? status.message : track ? "準備完了" : ""}
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
          <p className="sub">読み込むと自動でマスタリングし、処理前と処理後を聴き比べられます。作業は自動で保存され、次に開いたときに復元されます。音源はこのブラウザの外には送信されません。</p>
          <p className="sub">
            <a href="#p0">P0 検証ページ</a>
          </p>
        </section>
      ) : (
        <main className="workspace">
          <TrackView track={track} rendered={rendered} player={player} busy={status.kind === "busy"} active={active} />

          <div className="panels">
            <section className="panel">
              <h2>調整</h2>
              <SettingsControls settings={settings} onChange={set} />
              <p className="sub">True Peak の上限：{settings.ceilingDbtp.toFixed(1)} dBTP</p>
              <button className="reset" onClick={() => setSettings(DEFAULT_SETTINGS)}>
                初期値に戻す
              </button>
            </section>

            <section className="panel">
              <h2>測定値</h2>
              <MeterTable before={track.before} after={rendered?.after} />
              {rendered && <ToneCurve report={rendered.report} />}
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

function errorText(e: unknown) {
  if (typeof e === "object" && e && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
