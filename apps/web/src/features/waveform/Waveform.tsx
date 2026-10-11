// Waveform view: Before / After / Diff, switched or shown together (basic design 9, detailed design 15).
import { useCallback, useEffect, useRef, useState } from "react";
import { Mode, type ModeValue } from "../../audio/layout";
import type { Player } from "../../audio/player";
import type { Pyramid } from "../../workers/protocol";
import "./Waveform.css";

export type Layout = "single" | "overlay" | "stacked";
export type DiffKind = "signal" | "gain";
export type Source = "before" | "after" | "diff";

const BINS = [256, 1024, 4096, 16384];
const GAIN_RANGE_DB = 12;
const GAIN_DELTA_HOP = 480; // 100 Hz at 48 kHz
const HEIGHT = 280;

type Props = {
  totalFrames: number;
  sampleRate: number;
  before: Pyramid;
  after: Pyramid | null;
  diff: Pyramid | null;
  gainDelta: Float32Array | null;
  player: Player | null;
  mode: ModeValue;
  layout: Layout;
  diffKind: DiffKind;
  stacked: Record<Source, boolean>;
  busy: boolean;
};

type Lane = { kind: Source | "overlay"; y: number; h: number };

const sourceOfMode = (m: ModeValue): Source => (m === Mode.BEFORE ? "before" : m === Mode.DELTA ? "diff" : "after");

function lanes(layout: Layout, mode: ModeValue, stacked: Record<Source, boolean>): Lane[] {
  if (layout === "single") return [{ kind: sourceOfMode(mode), y: 0, h: HEIGHT }];
  if (layout === "overlay") {
    if (!stacked.diff) return [{ kind: "overlay", y: 0, h: HEIGHT }];
    const h = Math.round(HEIGHT * 0.68);
    return [
      { kind: "overlay", y: 0, h },
      { kind: "diff", y: h, h: HEIGHT - h },
    ];
  }
  const shown = (["before", "after", "diff"] as Source[]).filter((s) => stacked[s]);
  const kinds = shown.length ? shown : (["after"] as Source[]);
  const h = HEIGHT / kinds.length;
  return kinds.map((kind, i) => ({ kind, y: i * h, h }));
}

function css(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

type View = { start: number; fpp: number };

export function Waveform(p: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);
  const [view, setView] = useState<View>({ start: 0, fpp: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;

  const fit = useCallback(() => setView({ start: 0, fpp: Math.max(1, p.totalFrames / width) }), [p.totalFrames, width]);

  useEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, Math.floor(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(fit, [fit]);

  const clampView = useCallback(
    (v: View): View => {
      const fpp = Math.min(Math.max(v.fpp, 8), Math.max(8, p.totalFrames / width));
      const start = Math.min(Math.max(0, v.start), Math.max(0, p.totalFrames - fpp * width));
      return { start, fpp };
    },
    [p.totalFrames, width],
  );

  // Wheel: Cmd/Ctrl (or pinch) zooms around the cursor, otherwise scrolls (detailed design 15.2).
  useEffect(() => {
    const el = overlayRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      const x = e.offsetX;
      if (e.ctrlKey || e.metaKey) {
        const fpp = v.fpp * Math.exp(e.deltaY * 0.002);
        const anchor = v.start + x * v.fpp;
        setView(clampView({ fpp, start: anchor - x * fpp }));
      } else {
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        setView(clampView({ ...v, start: v.start + d * v.fpp }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [clampView]);

  const laneList = lanes(p.layout, p.mode, p.stacked);

  // Static layer.
  useEffect(() => {
    const canvas = baseRef.current!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = HEIGHT * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${HEIGHT}px`;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, HEIGHT);
    const colors = { before: css("--neutral-wave"), after: css("--accent"), boost: css("--boost"), cut: css("--cut"), text: css("--text-muted"), border: css("--border") };
    const playing = sourceOfMode(p.mode);
    const alpha = (s: Source) => (s === playing ? 1 : 0.55);
    const { start, fpp } = view;

    for (const lane of laneList) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, lane.y, width, lane.h);
      ctx.clip();
      ctx.strokeStyle = colors.border;
      ctx.beginPath();
      ctx.moveTo(0, lane.y + lane.h / 2 + 0.5);
      ctx.lineTo(width, lane.y + lane.h / 2 + 0.5);
      ctx.stroke();

      const pending = (lane.kind === "after" || lane.kind === "diff") && !p.after;
      if (lane.kind === "before" || lane.kind === "overlay") {
        drawPyramid(ctx, p.before, start, fpp, width, lane, colors.before, lane.kind === "overlay" ? (playing === "before" ? 0.9 : 0.5) : alpha("before"), 1);
      }
      if ((lane.kind === "after" || lane.kind === "overlay") && p.after) {
        drawPyramid(ctx, p.after, start, fpp, width, lane, colors.after, lane.kind === "overlay" ? (playing === "after" ? 0.75 : 0.4) : alpha("after"), 1);
      }
      let label = { before: "Before（処理前）", after: "After（処理後）", overlay: "Before ＋ After（重ね表示）", diff: "" }[lane.kind];
      if (lane.kind === "diff" && p.after) {
        if (p.diffKind === "signal" && p.diff) {
          const scale = drawPyramid(ctx, p.diff, start, fpp, width, lane, colors.boost, alpha("diff"), "auto");
          label = `差分：信号（After − Before、音量合わせ済み）×${scale.toFixed(1)}`;
        } else if (p.gainDelta) {
          drawGainDelta(ctx, p.gainDelta, start, fpp, width, lane, colors.boost, colors.cut, alpha("diff"));
          label = `差分：音量の変化（±${GAIN_RANGE_DB} dB、上＝増・下＝減）`;
        }
      }
      if (pending) {
        ctx.fillStyle = colors.text;
        ctx.font = "12px var(--font-ui)";
        ctx.fillText("マスタリング中…", width / 2 - 40, lane.y + lane.h / 2 - 6);
      }
      ctx.fillStyle = colors.text;
      ctx.font = "12px var(--font-ui)";
      const isPlaying = lane.kind === playing || (lane.kind === "overlay" && playing !== "diff");
      ctx.fillText(`${isPlaying ? "▶ " : ""}${label}`, 8, lane.y + 16);
      ctx.restore();
      if (lane.y > 0) {
        ctx.fillStyle = colors.border;
        ctx.fillRect(0, lane.y, width, 1);
      }
    }
  }, [p.before, p.after, p.diff, p.gainDelta, p.diffKind, p.mode, view, width, laneList.map((l) => `${l.kind}${l.y}`).join()]);

  // Playhead (redrawn every frame from shared memory, outside React state).
  useEffect(() => {
    const canvas = overlayRef.current!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = HEIGHT * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${HEIGHT}px`;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const color = css("--text");
    let raf = 0;
    const tick = () => {
      ctx.clearRect(0, 0, width, HEIGHT);
      const player = p.player;
      if (player) {
        const v = viewRef.current;
        const pos = player.position;
        // Follow the playhead page by page while playing (detailed design 15.2).
        if (player.playing && (pos > v.start + v.fpp * width * 0.9 || pos < v.start)) {
          setView(clampView({ ...v, start: pos - v.fpp * width * 0.1 }));
        }
        const x = (pos - v.start) / v.fpp;
        if (x >= 0 && x <= width) {
          ctx.fillStyle = color;
          ctx.fillRect(Math.round(x), 0, 1, HEIGHT);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [p.player, width, clampView]);

  const onClick = (e: React.MouseEvent) => {
    if (!p.player) return;
    p.player.seek(Math.round(view.start + e.nativeEvent.offsetX * view.fpp));
  };
  const zoom = (factor: number) => setView((v) => clampView({ fpp: v.fpp * factor, start: v.start + (v.fpp - v.fpp * factor) * (width / 2) }));
  const secs = (f: number) => (f / p.sampleRate).toFixed(1);

  return (
    <div className="waveform">
      <div className="waveform-canvas" ref={wrapRef} style={{ height: HEIGHT }}>
        <canvas ref={baseRef} />
        <canvas ref={overlayRef} className="overlay" onClick={onClick} aria-label="波形。クリックで再生位置を移動、⌘＋スクロールで拡大縮小" />
        {p.busy && <div className="waveform-busy" />}
      </div>
      <div className="waveform-footer">
        <span>
          表示範囲 {secs(view.start)}〜{secs(view.start + view.fpp * width)} 秒
        </span>
        <span className="zoom">
          <button onClick={() => zoom(0.5)} aria-label="拡大">
            ＋
          </button>
          <button onClick={() => zoom(2)} aria-label="縮小">
            −
          </button>
          <button onClick={fit}>全体</button>
        </span>
      </div>
    </div>
  );
}

/** Draws one pyramid lane. `scale` = 1 for audio, "auto" to fit the view. Returns the scale used. */
function drawPyramid(
  ctx: CanvasRenderingContext2D,
  pyr: Pyramid,
  start: number,
  fpp: number,
  width: number,
  lane: Lane,
  color: string,
  alpha: number,
  scale: number | "auto",
): number {
  const bin = [...BINS].reverse().find((b) => b <= fpp) ?? BINS[0];
  const data = pyr[bin];
  if (!data) return 1;
  const nBins = data.length / 3;
  const cols: { mn: number; mx: number; rms: number }[] = [];
  let peak = 1e-9;
  for (let x = 0; x < width; x++) {
    const f0 = start + x * fpp;
    const b0 = Math.floor(f0 / bin);
    const b1 = Math.max(b0 + 1, Math.ceil((f0 + fpp) / bin));
    if (b0 >= nBins) break;
    let mn = 0,
      mx = 0,
      sq = 0,
      n = 0;
    for (let b = b0; b < Math.min(b1, nBins); b++) {
      mn = Math.min(mn, data[3 * b]);
      mx = Math.max(mx, data[3 * b + 1]);
      sq += data[3 * b + 2] ** 2;
      n++;
    }
    const rms = Math.sqrt(sq / Math.max(1, n));
    cols.push({ mn, mx, rms });
    peak = Math.max(peak, -mn, mx);
  }
  const k = scale === "auto" ? 1 / (peak * 1.1) : scale;
  const mid = lane.y + lane.h / 2;
  const amp = (lane.h / 2) * 0.92 * k;
  ctx.globalAlpha = alpha * 0.55;
  ctx.fillStyle = color;
  cols.forEach((c, x) => ctx.fillRect(x, mid - c.mx * amp, 1, Math.max(1, (c.mx - c.mn) * amp)));
  ctx.globalAlpha = alpha;
  cols.forEach((c, x) => ctx.fillRect(x, mid - c.rms * amp, 1, Math.max(1, 2 * c.rms * amp)));
  ctx.globalAlpha = 1;
  return k;
}

function drawGainDelta(ctx: CanvasRenderingContext2D, g: Float32Array, start: number, fpp: number, width: number, lane: Lane, boost: string, cut: string, alpha: number) {
  const mid = lane.y + lane.h / 2;
  const amp = (lane.h / 2) * 0.9;
  ctx.globalAlpha = alpha;
  for (let x = 0; x < width; x++) {
    const i0 = Math.floor((start + x * fpp) / GAIN_DELTA_HOP);
    const i1 = Math.max(i0 + 1, Math.ceil((start + (x + 1) * fpp) / GAIN_DELTA_HOP));
    let s = 0,
      n = 0;
    for (let i = i0; i < Math.min(i1, g.length); i++) {
      if (!Number.isNaN(g[i])) {
        s += g[i];
        n++;
      }
    }
    if (!n) continue;
    const v = Math.max(-1, Math.min(1, s / n / GAIN_RANGE_DB));
    ctx.fillStyle = v >= 0 ? boost : cut;
    if (v >= 0) ctx.fillRect(x, mid - v * amp, 1, Math.max(1, v * amp));
    else ctx.fillRect(x, mid, 1, Math.max(1, -v * amp));
  }
  ctx.globalAlpha = 1;
}
