// Album timeline: every track's waveform to scale with gaps, on one shared amplitude axis so the
// album's level balance can be seen at a glance; optional short-term loudness curves; playhead;
// click to play from there; adjustable height.
import { useEffect, useRef, useState } from "react";
import { TIMELINE_BIN } from "../../workers/protocol";
import type { SeqState } from "./sequence";

const SR = 48_000;
const BIN_SEC = TIMELINE_BIN / SR;
const DB_FLOOR = -48;
/** Loudness lane range (LUFS) and its share of the height. */
const LUFS_RANGE: [number, number] = [-30, -4];
const LOUDNESS_LANE = 0.36;
export const TIMELINE_HEIGHT = { min: 60, max: 360, default: 140 };

export type TimelineItem = {
  id: string;
  title: string;
  frames: number;
  gapAfterSec: number;
  fadeInSec: number;
  fadeOutSec: number;
  /** [min, max, rms] per 0.1 s; null while unknown. */
  peaks: number[] | null;
  /** Short-term loudness, 10 Hz. */
  shortTerm: number[] | null;
  /** Shown as Before because it has not been processed yet (drawn grey). */
  unprocessed?: boolean;
};

type Props = {
  items: TimelineItem[];
  state: SeqState | null;
  onSeek: (index: number, frame: number) => void;
  canPlay: boolean;
  height: number;
  onHeightChange: (h: number) => void;
  /** Apply the tracks' fades to the drawing (they apply to playback and export). */
  showFades: boolean;
  showLoudness: boolean;
  dbScale: boolean;
  /** Dashed reference line for the loudness curves, LUFS. */
  referenceLufs: number | null;
  color: "after" | "before";
};

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const fadeGain = (t: number, len: number, fin: number, fout: number) => {
  let g = 1;
  if (fin > 0 && t < fin) g *= Math.sin((t / fin) * (Math.PI / 2)) ** 2;
  if (fout > 0 && t > len - fout) g *= Math.sin((Math.max(0, len - t) / fout) * (Math.PI / 2)) ** 2;
  return g;
};

function layout(items: TimelineItem[], width: number) {
  const total = items.reduce((s, t, i) => s + t.frames / SR + (i < items.length - 1 ? t.gapAfterSec : 0), 0) || 1;
  const pxPerSec = width / total;
  let acc = 0;
  return {
    pxPerSec,
    segs: items.map((t, i) => {
      const start = acc;
      acc += t.frames / SR + (i < items.length - 1 ? t.gapAfterSec : 0);
      return { item: t, x0: start * pxPerSec, x1: (start + t.frames / SR) * pxPerSec, len: t.frames / SR };
    }),
  };
}

export function Timeline(p: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);

  useEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, Math.floor(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { pxPerSec, segs } = layout(p.items, width);

  useEffect(() => {
    const c = canvas.current!;
    const dpr = window.devicePixelRatio || 1;
    const h = p.height;
    c.width = width * dpr;
    c.height = h * dpr;
    c.style.width = `${width}px`;
    c.style.height = `${h}px`;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, h);
    const { pxPerSec, segs } = layout(p.items, width);
    const color = css(p.color === "after" ? "--accent" : "--neutral-wave");
    const grey = css("--neutral-wave");
    // Waveform on top; the loudness curves get their own lane below so both stay readable.
    const waveH = p.showLoudness ? Math.round(h * (1 - LOUDNESS_LANE)) : h;
    const laneTop = waveH;
    const laneH = h - waveH;
    const mid = waveH / 2;
    const amp = (waveH / 2) * 0.9;
    const [lo, hi] = LUFS_RANGE;
    const lufsY = (l: number) => laneTop + laneH - ((Math.min(hi, Math.max(lo, l)) - lo) / (hi - lo)) * laneH;
    const scale = (v: number) => {
      if (!p.dbScale) return v * amp;
      const a = Math.abs(v);
      const d = a > 0 ? Math.max(DB_FLOOR, 20 * Math.log10(a)) : DB_FLOOR;
      return Math.sign(v) * ((d - DB_FLOOR) / -DB_FLOOR) * amp;
    };

    ctx.strokeStyle = css("--border");
    ctx.beginPath();
    ctx.moveTo(0, mid + 0.5);
    ctx.lineTo(width, mid + 0.5);
    ctx.stroke();

    if (p.showLoudness) {
      ctx.fillStyle = css("--bg");
      ctx.fillRect(0, laneTop, width, laneH);
      ctx.fillStyle = css("--border");
      ctx.fillRect(0, laneTop, width, 1);
    }
    for (const [i, s] of segs.entries()) {
      const { item } = s;
      ctx.fillStyle = css("--surface");
      ctx.fillRect(s.x0, 0, s.x1 - s.x0, waveH);
      // Track boundary (gaps are often under a pixel wide at album scale).
      ctx.fillStyle = css("--text-muted");
      ctx.globalAlpha = 0.5;
      ctx.fillRect(Math.round(s.x0), 0, 1, h);
      ctx.globalAlpha = 1;
      const pk = item.peaks;
      if (pk) {
        const nBins = pk.length / 3;
        const cols: [number, number, number][] = [];
        for (let x = Math.floor(s.x0); x < Math.ceil(s.x1); x++) {
          const t0 = (x - s.x0) / pxPerSec;
          const t1 = t0 + 1 / pxPerSec;
          const b0 = Math.max(0, Math.floor(t0 / BIN_SEC));
          const b1 = Math.min(nBins, Math.max(b0 + 1, Math.ceil(t1 / BIN_SEC)));
          if (b0 >= nBins) break;
          let mn = 0,
            mx = 0,
            sq = 0;
          for (let b = b0; b < b1; b++) {
            mn = Math.min(mn, pk[3 * b]);
            mx = Math.max(mx, pk[3 * b + 1]);
            sq += pk[3 * b + 2] ** 2;
          }
          const g = p.showFades && !item.unprocessed ? fadeGain((t0 + t1) / 2, s.len, item.fadeInSec, item.fadeOutSec) : 1;
          cols.push([mn * g, mx * g, Math.sqrt(sq / (b1 - b0)) * g]);
        }
        ctx.fillStyle = item.unprocessed ? grey : color;
        ctx.globalAlpha = 0.45;
        cols.forEach(([mn, mx], k) => {
          const top = mid - scale(mx);
          ctx.fillRect(Math.floor(s.x0) + k, top, 1, Math.max(1, mid - scale(mn) - top));
        });
        ctx.globalAlpha = 1;
        cols.forEach(([, , rms], k) => {
          const r = scale(rms);
          ctx.fillRect(Math.floor(s.x0) + k, mid - r, 1, Math.max(1, 2 * r));
        });
      }
      if (p.showLoudness && item.shortTerm) {
        ctx.strokeStyle = css("--boost");
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        let started = false;
        item.shortTerm.forEach((l, j) => {
          if (!Number.isFinite(l) || l < lo) {
            started = false;
            return;
          }
          const x = s.x0 + (j * 0.1 + 1.5) * pxPerSec; // value of the 3 s window centred here
          const y = lufsY(l);
          if (started) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
          started = true;
        });
        ctx.stroke();
        ctx.lineWidth = 1;
      }
      ctx.fillStyle = css("--text-muted");
      ctx.font = "11px var(--font-num)";
      const label = s.x1 - s.x0 > 90 ? `${String(i + 1).padStart(2, "0")} ${item.title}` : String(i + 1).padStart(2, "0");
      ctx.save();
      ctx.beginPath();
      ctx.rect(s.x0, 0, s.x1 - s.x0, h);
      ctx.clip();
      ctx.fillText(label, s.x0 + 4, 12);
      ctx.restore();
    }

    if (p.showLoudness) {
      // Scale lines, then the reference (target) as a dashed line.
      ctx.font = "10px var(--font-num)";
      ctx.fillStyle = css("--text-muted");
      ctx.strokeStyle = css("--border");
      for (const l of [-10, -20]) {
        const y = Math.round(lufsY(l)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
        ctx.fillText(`${l}`, 2, y - 2);
      }
      if (p.referenceLufs !== null) {
        const y = Math.round(lufsY(p.referenceLufs)) + 0.5;
        ctx.strokeStyle = css("--text");
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = css("--text");
        ctx.fillText(`目標 ${p.referenceLufs} LUFS`, width - 86, y - 3);
      }
      ctx.fillStyle = css("--text-muted");
      ctx.fillText("LUFS（3 秒）", width - 70, laneTop + laneH - 3);
    }
  }, [p.items, p.height, p.showFades, p.showLoudness, p.dbScale, p.referenceLufs, p.color, width]);

  const st = p.state;
  const playing = st?.playing ? segs[st.index] : null;
  const headX = playing && st ? (st.inGap ? playing.x1 : playing.x0 + (st.position / SR) * pxPerSec) : null;

  const onClick = (e: React.MouseEvent) => {
    if (!p.canPlay) return;
    const x = e.nativeEvent.offsetX;
    const i = segs.findIndex((s) => x >= s.x0 && x < s.x1);
    if (i >= 0) p.onSeek(i, Math.round(((x - segs[i].x0) / pxPerSec) * SR));
  };

  // Drag the bottom edge to change the height.
  const onResizeStart = (e: React.PointerEvent) => {
    const startY = e.clientY;
    const startH = p.height;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => p.onHeightChange(Math.round(Math.min(TIMELINE_HEIGHT.max, Math.max(TIMELINE_HEIGHT.min, startH + ev.clientY - startY))));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  return (
    <div className="timeline-wave" ref={wrap}>
      <div className="timeline-canvas" style={{ height: p.height }}>
        <canvas ref={canvas} onClick={onClick} className={p.canPlay ? "playable" : ""} aria-label="アルバム全体の波形。クリックでその位置から再生" />
        {playing && <span className="seg-outline" style={{ left: playing.x0, width: playing.x1 - playing.x0 }} />}
        {headX !== null && <span className="playhead" style={{ left: headX }} />}
      </div>
      <div
        className="resize-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="タイムラインの高さ（ドラッグで変更）"
        aria-valuenow={p.height}
        aria-valuemin={TIMELINE_HEIGHT.min}
        aria-valuemax={TIMELINE_HEIGHT.max}
        tabIndex={0}
        onPointerDown={onResizeStart}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") p.onHeightChange(Math.min(TIMELINE_HEIGHT.max, p.height + 20));
          if (e.key === "ArrowUp") p.onHeightChange(Math.max(TIMELINE_HEIGHT.min, p.height - 20));
        }}
      />
    </div>
  );
}
