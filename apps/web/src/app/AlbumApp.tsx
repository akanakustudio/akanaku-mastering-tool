// Album screen (S-04 / S-05 MVP; basic design 7, detailed design 10, 16.4, 16.5).
import { useEffect, useMemo, useRef, useState } from "react";
import { Player } from "../audio/player";
import { anchorId, initialOrder, l95Goal, titleFromFileName } from "../features/album/plan";
import { DEFAULT_SETTINGS } from "../features/settings/settings";
import { SettingsControls, Slider } from "../features/settings/SettingsControls";
import { MeterTable, TrackView, clock, type RenderData, type TrackData } from "../features/trackview/TrackView";
import { WorkerClient } from "../orchestrator/workerClient";
import type { Analysis, DspMethods, MasterSettings, RenderReport } from "../workers/protocol";
import "./AlbumApp.css";

const AUDIO_EXT = /\.(wav|wave|aif|aiff|flac|mp3|m4a|mp4|aac|caf)$/i;
const STAGE_LABEL: Record<string, string> = { cleanup: "ノイズ除去", tone: "音色・コンプ・ステレオ", limiter: "音圧調整", verify: "ピークの確認", store: "保存", zip: "ZIP の作成" };

type Result = { after: Analysis; report: RenderReport; version: number; offsetDb: number; goal: number; anchor: boolean };
type AlbumTrack = {
  id: string;
  file: File;
  title: string;
  frames: number;
  sampleRateIn: number;
  before?: Analysis;
  gapAfterSec: number;
  offsetDb: number;
  state: "analyzing" | "ready" | "rendering" | "error";
  error?: string;
  result?: Result;
};
type View = { id: string; track: TrackData; rendered: RenderData | null };

const fmt = (v: number | undefined, d = 1) => (v === undefined ? "…" : Number.isFinite(v) ? v.toFixed(d) : "-∞");
const errorText = (e: unknown) => (typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e));

export function AlbumApp({ active }: { active: boolean }) {
  const batch = useMemo(() => new WorkerClient<DspMethods>(new Worker(new URL("../workers/dsp.worker.ts", import.meta.url), { type: "module" })), []);
  const viewer = useMemo(() => new WorkerClient<DspMethods>(new Worker(new URL("../workers/dsp.worker.ts", import.meta.url), { type: "module" })), []);
  const [tracks, setTracks] = useState<AlbumTrack[]>([]);
  const [common, setCommon] = useState<MasterSettings>(DEFAULT_SETTINGS);
  const [keep, setKeep] = useState(0.5);
  const [anchorChoice, setAnchorChoice] = useState<string>("auto");
  const [version, setVersion] = useState(1);
  const [job, setJob] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [player, setPlayer] = useState<Player | null>(null);
  const [viewBusy, setViewBusy] = useState(false);
  const [albumTitle, setAlbumTitle] = useState("Album");
  const [exportRate, setExportRate] = useState(44_100);
  const [exportBits, setExportBits] = useState<16 | 24>(24);
  const [perTrack, setPerTrack] = useState(true);
  const [continuous, setContinuous] = useState(true);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;

  useEffect(() => {
    if (!active) player?.pause();
  }, [active, player]);

  // Any change to the shared settings invalidates every rendered track.
  const firstCommon = useRef(true);
  useEffect(() => {
    if (firstCommon.current) {
      firstCommon.current = false;
      return;
    }
    setVersion((v) => v + 1);
  }, [common, keep, anchorChoice]);

  const update = (id: string, patch: Partial<AlbumTrack>) => setTracks((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const ready = tracks.filter((t) => t.before);
  const anchor = anchorId(
    ready.map((t) => ({ id: t.id, l95Before: t.before!.l95, offsetDb: t.offsetDb })),
    anchorChoice,
  );
  const isStale = (t: AlbumTrack) => !t.result || t.result.version !== version || t.result.offsetDb !== t.offsetDb || t.result.anchor !== (t.id === anchor);
  const allDone = tracks.length > 0 && tracks.every((t) => t.before && !isStale(t));

  const addFiles = async (list: FileList | File[]) => {
    const files = initialOrder([...list].filter((f) => AUDIO_EXT.test(f.name)));
    if (!files.length) return;
    const added: AlbumTrack[] = files.map((file) => ({
      id: crypto.randomUUID(),
      file,
      title: titleFromFileName(file.name),
      frames: 0,
      sampleRateIn: 0,
      gapAfterSec: 2,
      offsetDb: 0,
      state: "analyzing",
    }));
    setTracks((ts) => [...ts, ...added]);
    setError(null);
    for (const [i, t] of added.entries()) {
      setJob(`解析中 ${i + 1}/${added.length}：${t.title}`);
      try {
        const info = await batch.call("analyzeFile", { file: t.file });
        update(t.id, { frames: info.frames, sampleRateIn: info.sampleRateIn, before: info.analysis, state: "ready" });
      } catch (e) {
        update(t.id, { state: "error", error: errorText(e) });
      }
    }
    setJob(null);
  };

  const renderTrack = async (t: AlbumTrack, settings: MasterSettings, label: string) => {
    if (view?.id === t.id) closeView();
    update(t.id, { state: "rendering" });
    const res = await batch.call("renderToStore", { file: t.file, settings, key: t.id }, [], (stage, f) =>
      setJob(`${label}：${STAGE_LABEL[stage] ?? stage}${f > 0 ? ` ${Math.round(f * 100)}%` : ""}`),
    );
    return res;
  };

  // Auto balance (detailed design 10.2 / 10.4): the anchor first, then every other track to its L95 goal.
  const balance = async () => {
    const list = tracksRef.current.filter((t) => t.before);
    const aId = anchor;
    if (!aId) return;
    const a = list.find((t) => t.id === aId)!;
    setError(null);
    try {
      let anchorAfter = a.result && !isStale(a) ? a.result.after : null;
      const todo = list.filter((t) => isStale(t) || !anchorAfter);
      let n = 0;
      if (!anchorAfter) {
        n++;
        const res = await renderTrack(a, { ...common, targetLufs: common.targetLufs + a.offsetDb, targetMode: "integrated" }, `${n}/${todo.length} ${a.title}（基準曲）`);
        anchorAfter = res.after;
        update(a.id, { state: "ready", result: { ...res, version, offsetDb: a.offsetDb, goal: common.targetLufs + a.offsetDb, anchor: true } });
      }
      for (const t of todo) {
        if (t.id === aId) continue;
        n++;
        const goal = l95Goal({ id: t.id, l95Before: t.before!.l95, offsetDb: t.offsetDb }, { id: a.id, l95Before: a.before!.l95, offsetDb: 0 }, anchorAfter.l95, keep);
        const res = await renderTrack(t, { ...common, targetLufs: goal, targetMode: "l95" }, `${n}/${todo.length} ${t.title}`);
        update(t.id, { state: "ready", result: { ...res, version, offsetDb: t.offsetDb, goal, anchor: false } });
      }
    } catch (e) {
      setError(errorText(e));
      setTracks((ts) => ts.map((t) => (t.state === "rendering" ? { ...t, state: "ready" } : t)));
    }
    setJob(null);
  };

  const closeView = () => {
    void player?.close();
    setPlayer(null);
    setView(null);
  };

  const openView = async (t: AlbumTrack) => {
    if (!t.before || t.state === "rendering") return;
    setViewBusy(true);
    await player?.close();
    setPlayer(null);
    try {
      if (t.result && !isStale(t)) {
        const { load, render } = await viewer.call("openStored", { file: t.file, key: t.id, ceilingDbtp: common.ceilingDbtp });
        const p = new Player(load.audio, render.audio);
        setPlayer(p);
        setView({ id: t.id, track: load, rendered: render });
      } else {
        const load = await viewer.call("load", { bytes: await t.file.arrayBuffer(), name: t.file.name });
        setPlayer(new Player(load.audio, load.audio));
        setView({ id: t.id, track: load, rendered: null });
      }
    } catch (e) {
      setError(errorText(e));
    }
    setViewBusy(false);
  };

  const moveTo = (from: number, to: number) =>
    setTracks((ts) => {
      if (from === to || to < 0 || to >= ts.length) return ts;
      const next = [...ts];
      const [t] = next.splice(from, 1);
      next.splice(to, 0, t);
      return next;
    });
  const move = (i: number, d: -1 | 1) => moveTo(i, i + d);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const remove = (id: string) => {
    if (view?.id === id) closeView();
    setTracks((ts) => ts.filter((t) => t.id !== id));
  };

  const exportAlbum = async () => {
    setError(null);
    type DirPicker = (o: { mode: "readwrite" }) => Promise<FileSystemDirectoryHandle>;
    const picker = (window as unknown as { showDirectoryPicker?: DirPicker }).showDirectoryPicker;
    let dirHandle: FileSystemDirectoryHandle | null = null;
    if (picker) {
      try {
        dirHandle = await picker({ mode: "readwrite" });
      } catch {
        return; // cancelled
      }
    }
    try {
      setJob("書き出し中…");
      const res = await batch.call(
        "exportAlbum",
        {
          tracks: tracks.map((t) => ({ key: t.id, title: t.title, gapAfterSec: t.gapAfterSec })),
          albumTitle,
          sampleRate: exportRate,
          bits: exportBits,
          ceilingDbtp: common.ceilingDbtp,
          perTrack,
          continuous,
          zip: !dirHandle,
        },
        [],
        (stage, f) => setJob(`${stage.startsWith("export") ? `書き出し ${stage.slice(7)}` : (STAGE_LABEL[stage] ?? stage)}${f > 0 ? ` ${Math.round(f * 100)}%` : ""}`),
      );
      const exportDir = await (await navigator.storage.getDirectory()).getDirectoryHandle("export");
      if (dirHandle) {
        for (const name of res.files) {
          setJob(`保存中：${name}`);
          const file = await (await exportDir.getFileHandle(name)).getFile();
          const w = await (await dirHandle.getFileHandle(name, { create: true })).createWritable();
          await file.stream().pipeTo(w);
        }
      } else if (res.zip) {
        const file = await (await exportDir.getFileHandle(res.zip)).getFile();
        const url = URL.createObjectURL(file);
        const a = document.createElement("a");
        a.href = url;
        a.download = res.zip;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    } catch (e) {
      setError(errorText(e));
    }
    setJob(null);
  };

  const totalSec = tracks.reduce((s, t, i) => s + t.frames / 48_000 + (i < tracks.length - 1 ? t.gapAfterSec : 0), 0);
  const busy = job !== null;
  const set = (patch: Partial<MasterSettings>) => setCommon((s) => ({ ...s, ...patch }));
  const scale = (l: number) => `${Math.max(0, Math.min(100, ((l + 24) / 20) * 100))}%`; // -24..-4 LUFS

  return (
    <div
      className={`app album${dragging ? " dragging" : ""}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return; // row reordering is handled by the table
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(false);
        void addFiles(e.dataTransfer.files);
      }}
    >
      <header className="app-header">
        <h1>アルバム</h1>
        <div className="file">
          <input className="album-title" value={albumTitle} onChange={(e) => setAlbumTitle(e.target.value)} aria-label="アルバム名" />
          <span className="hint">
            {tracks.length} 曲・{clock(totalSec)}
          </span>
          <button onClick={() => fileInput.current?.click()} disabled={busy}>
            曲を追加
          </button>
          <input
            ref={fileInput}
            type="file"
            hidden
            multiple
            accept="audio/*,.wav,.aif,.aiff,.flac,.mp3,.m4a"
            onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
        <span className={`status ${error ? "error" : busy ? "busy" : ""}`} role="status">
          {error ?? job ?? (allDone ? "準備完了" : tracks.length ? "「自動バランス」で全曲を処理してください" : "")}
        </span>
      </header>

      {tracks.length === 0 ? (
        <section className="empty">
          <p>アルバムの曲をまとめてドロップしてください（WAV / MP3 / FLAC / AIFF / M4A）。</p>
          <p className="sub">ファイル名の先頭に番号（例：01、✦12）があれば、その順に並べます。あとで ↑↓ で並べ替えられます。</p>
        </section>
      ) : (
        <main className="workspace">
          <div className="album-top">
            <section className="panel">
              <h2>アルバム共通の設定</h2>
              <SettingsControls settings={common} onChange={set} loudnessLabel="基準曲の音圧" />
              <label className="field">
                <span>基準曲</span>
                <select value={anchorChoice} onChange={(e) => setAnchorChoice(e.target.value)}>
                  <option value="auto">自動（盛り上がり部が一番大きい曲）</option>
                  {ready.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                </select>
              </label>
              <Slider
                label="元の音量差を残す割合"
                hint="0%：全曲の盛り上がり部を同じ大きさに ／ 100%：元の差をそのまま"
                value={Math.round(keep * 100)}
                min={0}
                max={100}
                step={10}
                unit="%"
                onChange={(v) => setKeep(v / 100)}
              />
              <button className="primary" onClick={balance} disabled={busy || ready.length === 0}>
                {allDone ? "自動バランス（済み）" : "自動バランス（全曲を処理）"}
              </button>
              <p className="sub">1 曲あたり 10〜20 秒かかります。設定を変えたら、もう一度押してください（変更のあった曲だけ処理し直します）。</p>
            </section>

            <section className="panel balance">
              <h2>盛り上がり部の音量（L95）</h2>
              <div className="bars">
                {tracks.map((t, i) => (
                  <div key={t.id} className="bar-row" title={`${t.title}：Before ${fmt(t.before?.l95)} / After ${fmt(t.result?.after.l95)} LUFS`}>
                    <span className="no">{String(i + 1).padStart(2, "0")}</span>
                    <span className="track">
                      {t.before && <span className="bar before" style={{ width: scale(t.before.l95) }} />}
                      {t.result && <span className={`bar after${isStale(t) ? " stale" : ""}`} style={{ width: scale(t.result.after.l95) }} />}
                    </span>
                    <span className="val">{fmt(t.result?.after.l95 ?? t.before?.l95)}</span>
                  </div>
                ))}
              </div>
              <p className="sub legend">
                <span className="swatch before" /> Before <span className="swatch after" /> After（-24〜-4 LUFS）
              </p>
            </section>
          </div>

          <section className="panel">
            <h2>曲順・曲間・音量</h2>
            <table className="tracks">
              <thead>
                <tr>
                  <th>#</th>
                  <th>曲名</th>
                  <th>長さ</th>
                  <th>Before LUFS / L95</th>
                  <th>After LUFS / L95 / TP</th>
                  <th>音量の補正</th>
                  <th>曲間</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tracks.map((t, i) => (
                  <tr
                    key={t.id}
                    className={`${view?.id === t.id ? "selected" : ""}${dragFrom === i ? " dragging-row" : ""}`}
                    draggable={!busy}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", String(i));
                      setDragFrom(i);
                    }}
                    onDragOver={(e) => {
                      if (dragFrom === null) return;
                      e.preventDefault();
                      if (dragFrom !== i) {
                        moveTo(dragFrom, i);
                        setDragFrom(i);
                      }
                    }}
                    onDragEnd={() => setDragFrom(null)}
                  >
                    <td className="order" title="ドラッグして並べ替え">
                      <span className="grip" aria-hidden>
                        ⋮⋮
                      </span>
                      <button onClick={() => move(i, -1)} disabled={busy || i === 0} aria-label="上へ">
                        ↑
                      </button>
                      <span>{String(i + 1).padStart(2, "0")}</span>
                      <button onClick={() => move(i, 1)} disabled={busy || i === tracks.length - 1} aria-label="下へ">
                        ↓
                      </button>
                    </td>
                    <td>
                      <input className="title" value={t.title} onChange={(e) => update(t.id, { title: e.target.value })} aria-label="曲名" />
                      {t.id === anchor && <span className="badge">基準曲</span>}
                      {t.state === "error" && <span className="badge error">{t.error}</span>}
                    </td>
                    <td className="num">{t.frames ? clock(t.frames / 48_000) : "…"}</td>
                    <td className="num">
                      {fmt(t.before?.lufs)} / {fmt(t.before?.l95)}
                    </td>
                    <td className={`num${t.result && isStale(t) ? " stale" : ""}`}>
                      {t.state === "rendering" ? "処理中…" : t.result ? `${fmt(t.result.after.lufs)} / ${fmt(t.result.after.l95)} / ${fmt(t.result.after.truePeak)}` : "—"}
                    </td>
                    <td>
                      <input
                        type="number"
                        className="small"
                        min={-6}
                        max={6}
                        step={0.5}
                        value={t.offsetDb}
                        onChange={(e) => update(t.id, { offsetDb: Number(e.target.value) })}
                        aria-label="音量の補正（dB）"
                      />{" "}
                      dB
                    </td>
                    <td>
                      {i < tracks.length - 1 ? (
                        <>
                          <input
                            type="number"
                            className="small"
                            min={0}
                            max={10}
                            step={0.5}
                            value={t.gapAfterSec}
                            onChange={(e) => update(t.id, { gapAfterSec: Number(e.target.value) })}
                            aria-label="次の曲までの間隔（秒）"
                          />{" "}
                          秒
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="actions">
                      <button onClick={() => openView(t)} disabled={!t.before || t.state === "rendering" || viewBusy}>
                        聴く
                      </button>
                      <button onClick={() => remove(t.id)} disabled={busy} aria-label="削除">
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="sub">曲順：行をドラッグするか ↑↓ で並べ替えます。音量の補正：この曲だけ大きく（＋）・小さく（−）したいときに使います。変えたら「自動バランス」を押してください。</p>
          </section>

          {view && (
            <section className="panel">
              <h2>
                {tracks.find((t) => t.id === view.id)?.title}
                {!view.rendered && <span className="sub">（未処理のため Before のみ）</span>}
              </h2>
              <TrackView track={view.track} rendered={view.rendered} player={player} busy={viewBusy} active={active} />
              <MeterTable before={view.track.before} after={view.rendered?.after} />
            </section>
          )}

          <section className="panel export">
            <h2>アルバムの書き出し</h2>
            <div className="export-row">
              <label className="field">
                <span>サンプルレート</span>
                <select value={exportRate} onChange={(e) => setExportRate(Number(e.target.value))}>
                  <option value={44_100}>44.1 kHz</option>
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
              <label>
                <input type="checkbox" checked={perTrack} onChange={() => setPerTrack(!perTrack)} /> 曲ごとのファイル
              </label>
              <label>
                <input type="checkbox" checked={continuous} onChange={() => setContinuous(!continuous)} /> 全曲を1つにつないだファイル＋CUE
              </label>
              <button className="primary" onClick={exportAlbum} disabled={busy || !allDone || (!perTrack && !continuous)}>
                アルバムを書き出す
              </button>
            </div>
            <p className="sub">
              {"showDirectoryPicker" in window ? "保存先のフォルダーを選んで、そこに直接書き出します。" : "このブラウザでは ZIP ファイルとしてダウンロードします。"}
              {!allDone && " 先に「自動バランス」で全曲を処理してください。"}
            </p>
          </section>
        </main>
      )}
    </div>
  );
}
