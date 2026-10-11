// Drawing styles for the spectrum display. All take the same band data:
// `shown` / `peak` in dB, mapped to 0..1 with `norm`.

export type VisualStyle = "classic" | "neon" | "circle" | "aurora";

export type Frame = {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  /** Band levels (dB, after ballistics) and peak holds. */
  shown: Float32Array;
  peak: Float32Array;
  /** dB -> 0..1 for the display range. */
  norm: (db: number) => number;
  /** Seconds since the display started (for slow colour drift). */
  time: number;
  reducedMotion: boolean;
  colors: { bar: string; peak: string; grid: string; text: string; bg: string };
  labels: (string | undefined)[];
  range: [number, number];
};

/** Hue for band b of n: magenta lows → violet → blue → cyan highs, drifting slowly over time. */
const hue = (b: number, n: number, t: number, motion: boolean) => 300 - (b / Math.max(1, n - 1)) * 120 + (motion ? 12 * Math.sin(t * 0.25) : 0);

/** Energy of the lowest ~quarter of the bands, 0..1 (drives the pulse). */
function bassEnergy(f: Frame) {
  const k = Math.max(1, Math.floor(f.shown.length / 4));
  let s = 0;
  for (let i = 0; i < k; i++) s += f.norm(f.shown[i]);
  return s / k;
}

export function drawClassic(f: Frame) {
  const { ctx, width, height, shown, peak, norm, colors, labels, range } = f;
  const n = shown.length;
  const axisH = 16;
  const plotH = height - axisH;
  const x0 = 28;
  const gap = n > 12 ? 2 : 4;
  const barW = (width - x0 - gap * (n - 1)) / n;
  const y = (db: number) => plotH - norm(db) * plotH;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, width, plotH);
  ctx.strokeStyle = colors.grid;
  ctx.fillStyle = colors.text;
  ctx.font = "10px var(--font-num)";
  for (let db = Math.ceil(range[0] / 12) * 12 + 12; db < range[1]; db += 12) {
    const yy = Math.round(y(db)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x0, yy);
    ctx.lineTo(width, yy);
    ctx.stroke();
    ctx.fillText(String(db), 2, yy + 3);
  }
  for (let b = 0; b < n; b++) {
    const x = x0 + b * (barW + gap);
    const top = y(shown[b]);
    ctx.fillStyle = colors.bar;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(x, top, barW, plotH - top);
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.peak;
    ctx.fillRect(x, Math.round(y(peak[b])), barW, 2);
    const label = labels[b];
    if (label) {
      ctx.fillStyle = colors.text;
      ctx.fillText(label, x + barW / 2 - label.length * 3, height - 4);
    }
  }
}

/** Glowing gradient bars with rounded tops and a mirrored reflection. */
export function drawNeon(f: Frame) {
  const { ctx, width, height, shown, peak, norm, time, reducedMotion } = f;
  const n = shown.length;
  ctx.fillStyle = "#07060d";
  ctx.fillRect(0, 0, width, height);
  const base = Math.round(height * 0.72);
  const gap = n > 12 ? 3 : 6;
  const barW = (width - 16 - gap * (n - 1)) / n;
  const r = Math.min(barW / 2, 6);
  for (let b = 0; b < n; b++) {
    const x = 8 + b * (barW + gap);
    const v = norm(shown[b]);
    const h = Math.max(2, v * (base - 8));
    const hu = hue(b, n, time, !reducedMotion);
    const grad = ctx.createLinearGradient(0, base - h, 0, base);
    grad.addColorStop(0, `hsl(${hu} 100% 72%)`);
    grad.addColorStop(1, `hsl(${hu + 20} 90% 45%)`);
    ctx.save();
    ctx.shadowColor = `hsl(${hu} 100% 60%)`;
    ctx.shadowBlur = 8 + 18 * v;
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(x, base - h, barW, h, [r, r, 0, 0]);
    ctx.fill();
    ctx.restore();
    // Reflection.
    const rh = Math.min(h * 0.45, height - base - 2);
    const rg = ctx.createLinearGradient(0, base, 0, base + rh);
    rg.addColorStop(0, `hsl(${hu} 100% 60% / 0.35)`);
    rg.addColorStop(1, `hsl(${hu} 100% 60% / 0)`);
    ctx.fillStyle = rg;
    ctx.fillRect(x, base + 2, barW, rh);
    // Peak spark.
    const py = base - Math.max(2, norm(peak[b]) * (base - 8));
    ctx.save();
    ctx.shadowColor = `hsl(${hu} 100% 85%)`;
    ctx.shadowBlur = 10;
    ctx.fillStyle = `hsl(${hu} 100% 88%)`;
    ctx.fillRect(x, py - 3, barW, 2);
    ctx.restore();
  }
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.fillRect(0, base, width, 1);
}

/** Bars radiating from a ring that breathes with the bass. */
export function drawCircle(f: Frame) {
  const { ctx, width, height, shown, norm, time, reducedMotion } = f;
  const n = shown.length;
  ctx.fillStyle = "#06050b";
  ctx.fillRect(0, 0, width, height);
  const cx = width / 2;
  const cy = height / 2;
  const bass = bassEnergy(f);
  const maxR = Math.min(width, height) / 2 - 4;
  const r0 = maxR * (0.34 + (reducedMotion ? 0 : 0.08 * bass));
  // Soft glow behind the ring.
  const glow = ctx.createRadialGradient(cx, cy, r0 * 0.2, cx, cy, maxR);
  glow.addColorStop(0, `hsl(${290 + (reducedMotion ? 0 : 30 * Math.sin(time * 0.2))} 90% 55% / ${0.18 + 0.3 * bass})`);
  glow.addColorStop(1, "hsl(260 90% 40% / 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);
  // Mirror the bands around the circle (left and right halves).
  const count = n * 2;
  const rot = reducedMotion ? 0 : time * 0.05;
  ctx.lineCap = "round";
  for (let i = 0; i < count; i++) {
    const b = i < n ? i : count - 1 - i;
    const v = norm(shown[b]);
    const a = -Math.PI / 2 + (i / count) * Math.PI * 2 + rot;
    const len = 4 + v * (maxR - r0);
    const hu = hue(b, n, time, !reducedMotion);
    ctx.strokeStyle = `hsl(${hu} 100% ${55 + 20 * v}%)`;
    ctx.lineWidth = Math.max(2, ((Math.PI * 2 * r0) / count) * 0.55);
    ctx.shadowColor = `hsl(${hu} 100% 60%)`;
    ctx.shadowBlur = 6 + 12 * v;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len));
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  ctx.strokeStyle = `hsl(300 100% 80% / ${0.25 + 0.5 * bass})`;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r0 - 4, 0, Math.PI * 2);
  ctx.stroke();
}

/** A smooth, filled curve that leaves a fading afterimage. */
export function drawAurora(f: Frame) {
  const { ctx, width, height, shown, norm, time, reducedMotion } = f;
  const n = shown.length;
  // Afterimage: cover the previous frame with a translucent backdrop instead of clearing it.
  ctx.fillStyle = reducedMotion ? "#05060c" : "rgba(5, 6, 12, 0.18)";
  ctx.fillRect(0, 0, width, height);
  const pts = Array.from(shown, (db, b) => ({ x: (b / (n - 1)) * width, y: height - 6 - norm(db) * (height - 16) }));
  const path = new Path2D();
  path.moveTo(0, height);
  path.lineTo(pts[0].x, pts[0].y);
  for (let i = 0; i < n - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    path.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
  }
  path.lineTo(pts[n - 1].x, pts[n - 1].y);
  path.lineTo(width, height);
  path.closePath();
  const shift = reducedMotion ? 0 : 40 * Math.sin(time * 0.15);
  const fill = ctx.createLinearGradient(0, 0, width, 0);
  fill.addColorStop(0, `hsl(${310 + shift} 95% 60% / 0.55)`);
  fill.addColorStop(0.5, `hsl(${250 + shift} 95% 62% / 0.45)`);
  fill.addColorStop(1, `hsl(${185 + shift} 95% 60% / 0.5)`);
  ctx.fillStyle = fill;
  ctx.fill(path);
  ctx.save();
  ctx.shadowColor = `hsl(${200 + shift} 100% 70%)`;
  ctx.shadowBlur = 14;
  ctx.strokeStyle = `hsl(${200 + shift} 100% 85% / 0.9)`;
  ctx.lineWidth = 2;
  ctx.stroke(path);
  ctx.restore();
}

export const DRAW: Record<VisualStyle, (f: Frame) => void> = { classic: drawClassic, neon: drawNeon, circle: drawCircle, aurora: drawAurora };

export const STYLE_LABEL: Record<VisualStyle, string> = { classic: "クラシック", neon: "ネオン", circle: "サークル", aurora: "オーロラ" };
