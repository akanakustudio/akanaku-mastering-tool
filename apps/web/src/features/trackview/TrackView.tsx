// Transport + waveform for one track (shared by the single and album screens; detailed design 15, 16.3).
import { useEffect, useRef, useState } from "react";
import { Mode, type ModeValue } from "../../audio/layout";
import type { Player } from "../../audio/player";
import type { Analysis, Pyramid } from "../../workers/protocol";
import { Waveform, type DiffKind, type Layout, type Source } from "../waveform/Waveform";

export type TrackData = { frames: number; sampleRate: number; before: Analysis; peaks: Pyramid };
export type RenderData = { after: Analysis; peaks: { after: Pyramid; diff: Pyramid }; gainDelta: Float32Array };

const MODE_LABEL: Record<ModeValue, string> = { [Mode.BEFORE]: "Before", [Mode.AFTER]: "After", [Mode.DELTA]: "差分" };
const LAYOUTS: { id: Layout; label: string }[] = [
  { id: "single", label: "切り替え" },
  { id: "overlay", label: "重ね" },
  { id: "stacked", label: "上下に並べる" },
];

export function clock(sec: number) {
  const m = Math.floor(sec / 60);
  return `${m}:${(sec - m * 60).toFixed(1).padStart(4, "0")}`;
}

export function TrackView({
  track,
  rendered,
  player,
  busy,
  active = true,
}: {
  track: TrackData;
  rendered: RenderData | null;
  player: Player | null;
  busy: boolean;
  /** Inactive views (hidden tab) ignore keyboard shortcuts. */
  active?: boolean;
}) {
  const [mode, setMode] = useState<ModeValue>(Mode.AFTER);
  const [playing, setPlaying] = useState(false);
  const [loudnessMatch, setLoudnessMatch] = useState(true);
  const [mono, setMono] = useState(false);
  const [layout, setLayout] = useState<Layout>("stacked");
  const [diffKind, setDiffKind] = useState<DiffKind>("gain");
  const [stacked, setStacked] = useState<Record<Source, boolean>>({ before: true, after: true, diff: true });
  const timeRef = useRef<HTMLSpanElement>(null);

  // A new player starts in After mode with the current mono setting.
  useEffect(() => {
    player?.setMode(mode);
    player?.setMono(mono);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player]);

  // Loudness-matched comparison (detailed design 12.3): Before and Delta are scaled to After's loudness.
  useEffect(() => {
    if (!player || !rendered) return;
    const g = loudnessMatch ? 10 ** ((rendered.after.lufs - track.before.lufs) / 20) : 1;
    player.setGains(g, g);
  }, [player, track, rendered, loudnessMatch]);

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
      if (player && timeRef.current) timeRef.current.textContent = clock(player.position / track.sampleRate);
      if (player && player.playing !== playing) setPlaying(player.playing);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [player, playing, track.sampleRate]);

  // Keyboard shortcuts (basic design 10.6).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!active) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || e.metaKey || e.ctrlKey || e.altKey) return;
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

  return (
    <>
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
    </>
  );
}

export function MeterTable({ before, after }: { before: Analysis; after?: Analysis }) {
  const fmt = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : "-∞");
  const rows: [string, keyof Analysis][] = [
    ["ラウドネス（LUFS）", "lufs"],
    ["True Peak（dBTP）", "truePeak"],
    ["PLR（dB）", "plr"],
    ["盛り上がり部の音量 L95", "l95"],
    ["ラウドネスレンジ LRA（LU）", "lra"],
  ];
  return (
    <table className="meters">
      <thead>
        <tr>
          <th />
          <th>Before</th>
          <th>After</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, k]) => (
          <tr key={k}>
            <th scope="row">{label}</th>
            <td>{fmt(before[k] as number)}</td>
            <td>{after ? fmt(after[k] as number) : "…"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
