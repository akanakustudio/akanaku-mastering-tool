// Real-time spectrum of what is playing (detailed design 12.7), in a classic graphic-EQ look or
// one of the more expressive styles.
import { useEffect, useRef, useState } from "react";
import { OCTAVE, THIRD_OCTAVE, ballistics, bandLevels } from "./bands";
import { DRAW, STYLE_LABEL, type VisualStyle } from "./visualStyles";

/** Display range, dB. Measured on Suno masters at -14 LUFS: 1/3-octave bands mostly -64..-30, peaks up to about -27. */
const RANGE: [number, number] = [-72, -12];
const LABELS: Record<number, string> = { 31.5: "31", 63: "63", 125: "125", 250: "250", 500: "500", 1000: "1k", 2000: "2k", 4000: "4k", 8000: "8k", 16000: "16k" };
const STYLE_KEY = "akmaster.spectrumStyle";
const STYLES = Object.keys(STYLE_LABEL) as VisualStyle[];

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function readStyle(): VisualStyle {
  try {
    const v = localStorage.getItem(STYLE_KEY) as VisualStyle | null;
    return v && STYLES.includes(v) ? v : "classic";
  } catch {
    return "classic";
  }
}

export function SpectrumAnalyzer({ getAnalyser, height = 160 }: { getAnalyser: () => AnalyserNode | null; height?: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(600);
  const [octave, setOctave] = useState(false);
  const [style, setStyle] = useState<VisualStyle>(readStyle);
  const getRef = useRef(getAnalyser);
  getRef.current = getAnalyser;

  const chooseStyle = (s: VisualStyle) => {
    setStyle(s);
    try {
      localStorage.setItem(STYLE_KEY, s); // per-viewer convenience
    } catch {
      // storage unavailable: fine
    }
  };

  useEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, Math.floor(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const h = style === "circle" ? Math.max(height, 220) : height;

  useEffect(() => {
    const c = canvas.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr;
    c.height = h * dpr;
    c.style.width = `${width}px`;
    c.style.height = `${h}px`;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, h);
    const centres = octave ? OCTAVE : THIRD_OCTAVE;
    const n = centres.length;
    const level = new Float32Array(n).fill(-200);
    const shown = new Float32Array(n).fill(RANGE[0]);
    const peak = new Float32Array(n).fill(RANGE[0]);
    const age = new Float32Array(n);
    let bins: Float32Array<ArrayBuffer> | null = null;
    const colors = { bar: css("--accent"), peak: css("--boost"), grid: css("--border"), text: css("--text-muted"), bg: css("--surface-2") };
    const labels = centres.map((f) => LABELS[f]);
    const norm = (db: number) => (Math.min(RANGE[1], Math.max(RANGE[0], db)) - RANGE[0]) / (RANGE[1] - RANGE[0]);
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const draw = DRAW[style];
    const start = performance.now();
    let raf = 0;
    let last = start;
    let active = false;

    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const an = getRef.current();
      if (an) {
        if (!bins || bins.length !== an.frequencyBinCount) bins = new Float32Array(an.frequencyBinCount);
        an.getFloatFrequencyData(bins);
        bandLevels(bins, an.context.sampleRate, centres, octave ? 1 : 3, level);
      } else {
        level.fill(-200);
      }
      ballistics(level, shown, peak, age, dt);
      const nowActive = shown.some((v) => v > RANGE[0] + 6);
      if (nowActive !== active) {
        active = nowActive;
        c.dataset.active = String(active); // for tests
      }
      draw({ ctx, width, height: h, shown, peak, norm, time: (now - start) / 1000, reducedMotion, colors, labels, range: RANGE });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [width, h, octave, style]);

  return (
    <div className="spectrum" ref={wrap}>
      <div className="spectrum-head">
        <span className="sub">スペクトラム（再生中の音、リアルタイム）</span>
        <span className="spectrum-options">
          <span className="segmented" role="radiogroup" aria-label="表示スタイル">
            {STYLES.map((s) => (
              <button key={s} role="radio" aria-checked={style === s} className={style === s ? "on" : ""} onClick={() => chooseStyle(s)}>
                {STYLE_LABEL[s]}
              </button>
            ))}
          </span>
          <span className="segmented" role="radiogroup" aria-label="帯域の細かさ">
            <button role="radio" aria-checked={!octave} className={!octave ? "on" : ""} onClick={() => setOctave(false)}>
              31 帯域
            </button>
            <button role="radio" aria-checked={octave} className={octave ? "on" : ""} onClick={() => setOctave(true)}>
              10 帯域
            </button>
          </span>
        </span>
      </div>
      <canvas ref={canvas} aria-label={`再生中の音の周波数ごとのレベル（${STYLE_LABEL[style]}）`} data-active="false" data-style={style} />
    </div>
  );
}
