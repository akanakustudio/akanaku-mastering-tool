// Album screen (S-04 / S-05 MVP; basic design 7, detailed design 10, 16.4, 16.5).
import { useEffect, useMemo, useRef, useState } from "react";
import { Player } from "../audio/player";
import { anchorId, initialOrder, l95Goal, titleFromFileName } from "../features/album/plan";
import { AlbumSequence, type SeqState } from "../features/album/sequence";
import { TIMELINE_HEIGHT, Timeline, type TimelineItem } from "../features/album/Timeline";
import { DEFAULT_SETTINGS } from "../features/settings/settings";
import { SettingsControls, Slider } from "../features/settings/SettingsControls";
import { MeterTable, TrackView, clock, type RenderData, type TrackData } from "../features/trackview/TrackView";
import { WorkerClient } from "../orchestrator/workerClient";
import { exportProject, importProject } from "../features/project/project";
import { ProjectPanel } from "../features/project/ProjectPanel";
import { autosaver, clearWorkspace, deleteRendered, deleteSources, loadSource, loadWorkspace, saveWorkspace, storeSource } from "../storage/workspace";
import type { Analysis, DspMethods, MasterSettings, RenderReport } from "../workers/protocol";
import "./AlbumApp.css";

const AUDIO_EXT = /\.(wav|wave|aif|aiff|flac|mp3|m4a|mp4|aac|caf)$/i;
const STAGE_LABEL: Record<string, string> = { cleanup: "ノイズ除去", tone: "音色・コンプ・ステレオ", limiter: "音圧調整", verify: "ピークの確認", store: "保存", zip: "ZIP の作成" };

type Result = {
  after: Analysis;
  report: RenderReport;
  version: number;
  offsetDb: number;
  goal: number;
  anchor: boolean;
  /** Track set the album tone plan was computed for (sorted ids). */
  planKey?: string;
  /** Largest album tone correction applied to this track, dB. */
  albumToneMaxDb?: number;
  /** Timeline peaks of the render: [min, max, rms] per 0.1 s. */
  afterPeaks?: number[];
};
type AlbumTrack = {
  id: string;
  file: File;
  title: string;
  frames: number;
  sampleRateIn: number;
  before?: Analysis;
  /** Average spectrum of the unprocessed track (album tone harmonisation, 10.3). */
  spectrum?: number[];
  /** Timeline peaks of the unprocessed track: [min, max, rms] per 0.1 s. */
  beforePeaks?: number[];
  gapAfterSec: number;
  fadeInSec: number;
  fadeOutSec: number;
  offsetDb: number;
  state: "analyzing" | "ready" | "rendering" | "error";
  error?: string;
  result?: Result;
};
type View = { id: string; track: TrackData; rendered: RenderData | null };

/** Saved album session (IndexedDB "workspace"/"album"); song files are stored under the track id. */
type SavedAlbum = {
  albumTitle: string;
  common: MasterSettings;
  keep: number;
  harmonize?: number;
  anchorChoice: string;
  version: number;
  exportRate: number;
  exportBits: 16 | 24;
  perTrack: boolean;
  continuous: boolean;
  tracks: (Omit<AlbumTrack, "file" | "state" | "error"> & { name: string })[];
};
const save = autosaver("album");

const HEIGHT_KEY = "akmaster.timelineHeight";
function readNumber(key: string, fallback: number) {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}
/** Rounds timeline peaks to 4 decimals so the saved session stays small. */
const compact = (a: ArrayLike<number>) => Array.from(a, (v) => Math.round(v * 1e4) / 1e4);

const fmt = (v: number | undefined, d = 1) => (v === undefined ? "…" : Number.isFinite(v) ? v.toFixed(d) : "-∞");
const errorText = (e: unknown) => (typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e));

export function AlbumApp({ active }: { active: boolean }) {
  const batch = useMemo(() => new WorkerClient<DspMethods>(new Worker(new URL("../workers/dsp.worker.ts", import.meta.url), { type: "module" })), []);
  const viewer = useMemo(() => new WorkerClient<DspMethods>(new Worker(new URL("../workers/dsp.worker.ts", import.meta.url), { type: "module" })), []);
  const [tracks, setTracks] = useState<AlbumTrack[]>([]);
  const [common, setCommon] = useState<MasterSettings>(DEFAULT_SETTINGS);
  const [keep, setKeep] = useState(0.5);
  const [harmonize, setHarmonize] = useState(0.5);
  const [seqState, setSeqState] = useState<SeqState | null>(null);
  const [timelineView, setTimelineView] = useState<"after" | "before">("after");
  const [timelineHeight, setTimelineHeight] = useState(() => readNumber(HEIGHT_KEY, TIMELINE_HEIGHT.default));
  const [showLoudness, setShowLoudness] = useState(true);
  const [dbScale, setDbScale] = useState(false);
  const seq = useRef<AlbumSequence | null>(null);
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

  // Any change to the shared settings invalidates every rendered track (not when restoring them).
  const skipVersionBump = useRef(true);
  useEffect(() => {
    if (skipVersionBump.current) {
      skipVersionBump.current = false;
      return;
    }
    setVersion((v) => v + 1);
  }, [common, keep, harmonize, anchorChoice]);

  // Restore the previous album once (detailed design 19.4).
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    void (async () => {
      const saved = await loadWorkspace<SavedAlbum>("album");
      if (saved) {
        skipVersionBump.current = true;
        setAlbumTitle(saved.albumTitle);
        setCommon({ ...DEFAULT_SETTINGS, ...saved.common });
        setKeep(saved.keep);
        setHarmonize(saved.harmonize ?? 0.5);
        setAnchorChoice(saved.anchorChoice);
        setVersion(saved.version);
        setExportRate(saved.exportRate);
        setExportBits(saved.exportBits);
        setPerTrack(saved.perTrack);
        setContinuous(saved.continuous);
        const list: AlbumTrack[] = [];
        for (const t of saved.tracks) {
          const file = await loadSource(t.id);
          list.push({
            ...t,
            // Sessions saved before fades existed.
            fadeInSec: t.fadeInSec ?? 0,
            fadeOutSec: t.fadeOutSec ?? 0,
            file: file ? new File([file], t.name, { type: file.type }) : new File([], t.name),
            state: file && t.before ? "ready" : "error",
            error: file ? (t.before ? undefined : "解析されていません。削除して追加し直してください") : "音源がブラウザ内に見つかりません（E-SRC-001）",
          });
        }
        setTracks(list);
        if (list.length) setJob(null);
        // Sessions saved before timeline peaks were kept: make them in the background.
        for (const t of list) {
          try {
            if (t.result && !t.result.afterPeaks) {
              const peaks = compact(await batch.call("storedPeaks", { key: t.id }));
              setTracks((ts) => ts.map((x) => (x.id === t.id && x.result ? { ...x, result: { ...x.result, afterPeaks: peaks } } : x)));
            }
            if (t.before && !t.beforePeaks && t.file.size > 0) {
              const info = await batch.call("analyzeFile", { file: t.file });
              setTracks((ts) => ts.map((x) => (x.id === t.id ? { ...x, beforePeaks: compact(info.peaks), spectrum: x.spectrum ?? info.spectrum } : x)));
            }
          } catch {
            // Missing render or source: the timeline shows that track empty.
          }
        }
      }
      setRestored(true);
    })();
  }, []);

  const currentRecord = (): SavedAlbum => ({
    albumTitle,
    common,
    keep,
    harmonize,
    anchorChoice,
    version,
    exportRate,
    exportBits,
    perTrack,
    continuous,
    tracks: tracks.map(({ file, state: _s, error: _e, ...t }) => ({ ...t, name: file.name })),
  });

  // Autosave (detailed design 13.1).
  useEffect(() => {
    if (!restored) return;
    const value: SavedAlbum = {
      albumTitle,
      common,
      keep,
      harmonize,
      anchorChoice,
      version,
      exportRate,
      exportBits,
      perTrack,
      continuous,
      tracks: tracks.map(({ file, state: _s, error: _e, ...t }) => ({ ...t, name: file.name })),
    };
    save(value);
  }, [restored, albumTitle, common, keep, harmonize, anchorChoice, version, exportRate, exportBits, perTrack, continuous, tracks]);

  const closeAlbum = async () => {
    if (!confirm("アルバムを閉じますか？（保存されている曲と処理結果も消えます）")) return;
    await discardAlbum();
  };

  // Project file (detailed design 13.5).
  const saveProjectFile = async (includeRenders: boolean) => {
    const rec = currentRecord();
    try {
      setJob("プロジェクトファイルを作成中…");
      const ws = includeRenders ? rec : { ...rec, tracks: rec.tracks.map(({ result: _r, ...t }) => t) };
      const renders = includeRenders ? tracks.filter((t) => t.result).map((t) => `album/${t.id}.f32`) : [];
      await exportProject(
        batch,
        "album",
        ws,
        tracks.map((t) => ({ id: t.id, file: t.file })),
        renders,
        albumTitle,
        (f) => setJob(`プロジェクトファイルを作成中… ${Math.round(f * 100)}%`),
      );
    } catch (e) {
      setError(errorText(e));
    }
    setJob(null);
  };
  const loadProjectFile = async (file: File) => {
    if (tracks.length && !confirm("今のアルバムを、読み込むプロジェクトで置き換えます。よろしいですか？")) return;
    try {
      setJob("プロジェクトファイルを読み込み中…");
      await discardAlbum();
      const { project, sources } = await importProject(batch, file, "album", (f) => setJob(`プロジェクトファイルを読み込み中… ${Math.round(f * 100)}%`));
      for (const src of sources) await storeSource(src.id, src.file);
      await saveWorkspace("album", project.workspace);
      location.reload(); // restores from the saved workspace
    } catch (e) {
      setError(errorText(e));
      setJob(null);
    }
  };

  /** Removes all tracks and their saved data (no confirmation). */
  const discardAlbum = async () => {
    stopSequence();
    closeView();
    const ids = tracksRef.current.map((t) => t.id);
    setTracks([]);
    await deleteSources(ids);
    await deleteRendered(ids.map((id) => `album/${id}.f32`));
    await clearWorkspace("album");
  };

  const update = (id: string, patch: Partial<AlbumTrack>) => setTracks((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const ready = tracks.filter((t) => t.before);
  const anchor = anchorId(
    ready.map((t) => ({ id: t.id, l95Before: t.before!.l95, offsetDb: t.offsetDb })),
    anchorChoice,
  );
  // The album tone plan depends on every track, so adding or removing one makes all stale.
  const planKey = harmonize > 0 ? ready.map((t) => t.id).sort().join(",") : "";
  const isStale = (t: AlbumTrack) =>
    !t.result || t.result.version !== version || t.result.offsetDb !== t.offsetDb || t.result.anchor !== (t.id === anchor) || (t.result.planKey ?? "") !== planKey;
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
      fadeInSec: 0,
      fadeOutSec: 0,
      offsetDb: 0,
      state: "analyzing",
    }));
    setTracks((ts) => [...ts, ...added]);
    setError(null);
    for (const t of added) await storeSource(t.id, t.file);
    for (const [i, t] of added.entries()) {
      setJob(`解析中 ${i + 1}/${added.length}：${t.title}`);
      try {
        const info = await batch.call("analyzeFile", { file: t.file });
        update(t.id, { frames: info.frames, sampleRateIn: info.sampleRateIn, before: info.analysis, spectrum: info.spectrum, beforePeaks: compact(info.peaks), state: "ready" });
      } catch (e) {
        update(t.id, { state: "error", error: errorText(e) });
      }
    }
    setJob(null);
  };

  const renderTrack = async (t: AlbumTrack, settings: MasterSettings, label: string) => {
    if (view?.id === t.id) closeView();
    stopSequence();
    update(t.id, { state: "rendering" });
    const res = await batch.call("renderToStore", { file: t.file, settings, key: t.id }, [], (stage, f) =>
      setJob(`${label}：${STAGE_LABEL[stage] ?? stage}${f > 0 ? ` ${Math.round(f * 100)}%` : ""}`),
    );
    return res;
  };

  // Auto balance (detailed design 10.2 / 10.4): the anchor first, then every other track to its L95 goal.
  const balance = async () => {
    let list = tracksRef.current.filter((t) => t.before);
    const aId = anchor;
    if (!aId) return;
    setError(null);
    try {
      // Tracks saved before spectra were recorded: analyse them again.
      for (const t of list.filter((x) => !x.spectrum)) {
        setJob(`解析中：${t.title}`);
        const info = await batch.call("analyzeFile", { file: t.file });
        t.spectrum = info.spectrum;
        update(t.id, { spectrum: info.spectrum });
      }
      list = list.map((t) => ({ ...t }));
      // Album tone plan (detailed design 10.3).
      const tone = new Map<string, number[]>();
      if (harmonize > 0 && list.length > 1) {
        const P = list[0].spectrum!.length;
        const flat = new Float32Array(list.length * P);
        list.forEach((t, i) => flat.set(t.spectrum!, i * P));
        const plan = await viewer.call("albumTonePlan", { spectra: flat, toneMatch: common.toneMatch, amount: harmonize });
        list.forEach((t, i) => tone.set(t.id, Array.from(plan.subarray(i * P, (i + 1) * P))));
      }
      const toneMax = (id: string) => Math.max(0, ...(tone.get(id) ?? []).map(Math.abs));
      const a = list.find((t) => t.id === aId)!;
      let anchorAfter = a.result && !isStale(a) ? a.result.after : null;
      const todo = list.filter((t) => isStale(t) || !anchorAfter);
      let n = 0;
      if (!anchorAfter) {
        n++;
        const res = await renderTrack(
          a,
          { ...common, targetLufs: common.targetLufs + a.offsetDb, targetMode: "integrated", albumTone: tone.get(a.id) },
          `${n}/${todo.length} ${a.title}（基準曲）`,
        );
        anchorAfter = res.after;
        update(a.id, {
          state: "ready",
          result: { after: res.after, report: res.report, version, offsetDb: a.offsetDb, goal: common.targetLufs + a.offsetDb, anchor: true, planKey, albumToneMaxDb: toneMax(a.id), afterPeaks: compact(res.peaks) },
        });
      }
      for (const t of todo) {
        if (t.id === aId) continue;
        n++;
        const goal = l95Goal({ id: t.id, l95Before: t.before!.l95, offsetDb: t.offsetDb }, { id: a.id, l95Before: a.before!.l95, offsetDb: 0 }, anchorAfter.l95, keep);
        const res = await renderTrack(t, { ...common, targetLufs: goal, targetMode: "l95", albumTone: tone.get(t.id) }, `${n}/${todo.length} ${t.title}`);
        update(t.id, {
          state: "ready",
          result: { after: res.after, report: res.report, version, offsetDb: t.offsetDb, goal, anchor: false, planKey, albumToneMaxDb: toneMax(t.id), afterPeaks: compact(res.peaks) },
        });
      }
    } catch (e) {
      setError(errorText(e));
      setTracks((ts) => ts.map((t) => (t.state === "rendering" ? { ...t, state: "ready" } : t)));
    }
    setJob(null);
  };

  // Continuous playback and transition checks (detailed design 10.5 / 12.6).
  const stopSequence = () => {
    seq.current?.stop();
  };
  const playAlbum = (index: number, frame: number) => {
    void player?.pause();
    const items = tracksRef.current.map((t) => ({ key: t.id, frames: t.frames, gapAfterSec: t.gapAfterSec, fadeInSec: t.fadeInSec, fadeOutSec: t.fadeOutSec }));
    void seq.current?.close();
    seq.current = new AlbumSequence(viewer, items, setSeqState);
    void seq.current.playFrom(index, frame).catch((e) => setError(errorText(e)));
  };
  useEffect(() => {
    if (!active) stopSequence();
  }, [active]);

  const closeView = () => {
    void player?.close();
    setPlayer(null);
    setView(null);
  };

  const openView = async (t: AlbumTrack) => {
    if (!t.before || t.state === "rendering") return;
    stopSequence();
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
    void deleteSources([id]);
    void deleteRendered([`album/${id}.f32`]);
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
          tracks: tracks.map((t) => ({ key: t.id, title: t.title, gapAfterSec: t.gapAfterSec, fadeInSec: t.fadeInSec, fadeOutSec: t.fadeOutSec })),
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

  const timelineItems = useMemo<TimelineItem[]>(
    () =>
      tracks.map((t) => ({
        id: t.id,
        title: t.title,
        frames: t.frames,
        gapAfterSec: t.gapAfterSec,
        fadeInSec: t.fadeInSec,
        fadeOutSec: t.fadeOutSec,
        peaks: timelineView === "after" ? (t.result?.afterPeaks ?? null) : (t.beforePeaks ?? null),
        shortTerm: timelineView === "after" ? (t.result?.after.shortTerm ?? null) : (t.before?.shortTerm ?? null),
      })),
    [tracks, timelineView],
  );
  const changeTimelineHeight = (h: number) => {
    setTimelineHeight(h);
    try {
      localStorage.setItem(HEIGHT_KEY, String(h)); // per-viewer convenience
    } catch {
      // storage unavailable: fine
    }
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
          {tracks.length > 0 && (
            <button onClick={closeAlbum} disabled={busy}>
              アルバムを閉じる
            </button>
          )}
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

      {tracks.length === 0 && (
        <div className="workspace">
          <ProjectPanel busy={busy} hasWork={false} onExport={saveProjectFile} onImport={loadProjectFile} />
        </div>
      )}
      {tracks.length === 0 ? (
        <section className="empty">
          <p>アルバムの曲をまとめてドロップしてください（WAV / MP3 / FLAC / AIFF / M4A）。</p>
          <p className="sub">ファイル名の先頭に番号（例：01、✦12）があれば、その順に並べます。あとで行のドラッグや ↑↓ で並べ替えられます。作業は自動で保存され、次に開いたときに復元されます。</p>
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
                label="曲どうしの音色をそろえる"
                hint="アルバム全体の平均的な音色に、各曲を少し寄せる（最大 ±2 dB、4 kHz より上は下げるだけ）"
                value={Math.round(harmonize * 100)}
                min={0}
                max={100}
                step={10}
                unit="%"
                onChange={(v) => setHarmonize(v / 100)}
              />
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
                  <th>フェード（入 / 出）</th>
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
                      {t.result?.albumToneMaxDb ? <span className="sub"> 音色 ±{t.result.albumToneMaxDb.toFixed(1)}</span> : null}
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
                    <td className="gapcell">
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
                          <button onClick={() => playAlbum(i, Math.max(0, t.frames - 10 * 48_000))} disabled={busy || !allDone} title="この曲の最後の 10 秒から、次の曲へのつながりを聴く">
                            ▶ つなぎ目
                          </button>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="gapcell">
                      <input
                        type="number"
                        className="small"
                        min={0}
                        max={20}
                        step={0.5}
                        value={t.fadeInSec}
                        onChange={(e) => update(t.id, { fadeInSec: Number(e.target.value) })}
                        aria-label="フェードイン（秒）"
                      />{" "}
                      /{" "}
                      <input
                        type="number"
                        className="small"
                        min={0}
                        max={20}
                        step={0.5}
                        value={t.fadeOutSec}
                        onChange={(e) => update(t.id, { fadeOutSec: Number(e.target.value) })}
                        aria-label="フェードアウト（秒）"
                      />{" "}
                      秒
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

          <section className="panel">
            <h2>通して聴く</h2>
            <div className="playback-row">
              {seqState?.playing ? (
                <button onClick={stopSequence}>■ 停止</button>
              ) : (
                <button className="primary" onClick={() => playAlbum(0, 0)} disabled={busy || !allDone}>
                  ▶ 最初から
                </button>
              )}
              <span className="now">
                {seqState?.playing
                  ? `${String(seqState.index + 1).padStart(2, "0")} ${tracks[seqState.index]?.title ?? ""}　${seqState.inGap ? "（曲間）" : clock(seqState.position / 48_000)}`
                  : allDone
                    ? "タイムラインをクリックすると、その位置から再生します"
                    : "「自動バランス」で全曲を処理すると、通して聴けます"}
              </span>
            </div>
            <div className="timeline-options">
              <span className="segmented" role="radiogroup" aria-label="タイムラインに表示する音">
                {(["after", "before"] as const).map((v) => (
                  <button key={v} role="radio" aria-checked={timelineView === v} className={timelineView === v ? "on" : ""} onClick={() => setTimelineView(v)}>
                    {v === "after" ? "After（処理後）" : "Before（処理前）"}
                  </button>
                ))}
              </span>
              <label>
                <input type="checkbox" checked={showLoudness} onChange={() => setShowLoudness(!showLoudness)} /> ラウドネスの推移（3 秒ごと）
              </label>
              <label>
                <input type="checkbox" checked={dbScale} onChange={() => setDbScale(!dbScale)} /> 縦軸を dB で表示
              </label>
              <label>
                高さ{" "}
                <input
                  type="range"
                  min={TIMELINE_HEIGHT.min}
                  max={TIMELINE_HEIGHT.max}
                  step={10}
                  value={timelineHeight}
                  onChange={(e) => changeTimelineHeight(Number(e.target.value))}
                  aria-label="タイムラインの高さ"
                />
              </label>
            </div>
            <Timeline
              items={timelineItems}
              state={seqState}
              onSeek={(i, f) => allDone && !busy && playAlbum(i, f)}
              canPlay={allDone && !busy}
              height={timelineHeight}
              onHeightChange={changeTimelineHeight}
              showFades={timelineView === "after"}
              showLoudness={showLoudness}
              dbScale={dbScale}
              referenceLufs={timelineView === "after" ? common.targetLufs : null}
              color={timelineView}
            />
            <p className="sub">
              全曲を同じ縦の目盛りで表示しているので、曲どうしの音量差がそのまま見えます。下の帯のオレンジの線は 3 秒ごとのラウドネス（点線は基準曲の目標）。下端をドラッグすると高さを変えられます。曲間・フェードの変更はすぐ反映されます。
            </p>
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
          <ProjectPanel busy={busy} hasWork={allDone || tracks.some((t) => t.before)} onExport={saveProjectFile} onImport={loadProjectFile} />
        </main>
      )}
    </div>
  );
}
