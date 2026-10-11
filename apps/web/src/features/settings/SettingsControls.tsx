// Mastering controls shared by the single and album screens (detailed design 17.3 macros).
import type { MasterSettings, RenderReport } from "../../workers/protocol";
import { LOUDNESS_PRESETS } from "./settings";

export function SettingsControls({ settings, onChange, loudnessLabel = "音圧の目標（Loudness）" }: { settings: MasterSettings; onChange: (patch: Partial<MasterSettings>) => void; loudnessLabel?: string }) {
  return (
    <>
      <Slider label="ノイズ除去（Cleanup）" hint="シャリシャリ・ザラザラを抑える強さ" value={Math.round(settings.cleanup * 100)} min={0} max={100} step={5} unit="%" onChange={(v) => onChange({ cleanup: v / 100 })} />
      <Slider
        label="自動トーン補正"
        hint="周波数の出っ張り・へこみをならす（4 kHz より上は下げるだけ）"
        value={Math.round(settings.toneMatch * 100)}
        min={0}
        max={100}
        step={5}
        unit="%"
        onChange={(v) => onChange({ toneMatch: v / 100 })}
      />
      <Slider label="音色（Warm ⇔ Bright）" hint="マイナスで柔らかく、プラスで明るく" value={Math.round(settings.tone * 100)} min={-100} max={100} step={5} unit="" onChange={(v) => onChange({ tone: v / 100 })} />
      <label className="field">
        <span>マルチバンドコンプ（低・中・高の 3 帯域）</span>
        <input type="checkbox" checked={settings.multiband} onChange={() => onChange({ multiband: !settings.multiband })} />
      </label>
      {settings.multiband && (
        <Slider label="パンチ（Punch）" hint="上げるとアタックが立ち、まとまりが強くなる" value={Math.round(settings.punch * 100)} min={0} max={100} step={5} unit="%" onChange={(v) => onChange({ punch: v / 100 })} />
      )}
      <Slider label="ステレオの広がり（Width）" hint="100% がそのまま" value={Math.round(settings.width * 100)} min={0} max={150} step={5} unit="%" onChange={(v) => onChange({ width: v / 100 })} />
      <label className="field">
        <span>低音のモノラル化</span>
        <select value={settings.monoBelowHz} onChange={(e) => onChange({ monoBelowHz: Number(e.target.value) })}>
          <option value={0}>しない</option>
          <option value={80}>80 Hz 以下</option>
          <option value={120}>120 Hz 以下</option>
          <option value={160}>160 Hz 以下</option>
        </select>
      </label>
      <label className="field">
        <span>{loudnessLabel}</span>
        <select value={settings.targetLufs} onChange={(e) => onChange({ targetLufs: Number(e.target.value) })}>
          {LOUDNESS_PRESETS.map((p) => (
            <option key={p.lufs} value={p.lufs}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

export function Slider(p: { label: string; hint?: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void }) {
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
      {p.hint && <span className="hint">{p.hint}</span>}
    </label>
  );
}

/** Applied automatic tone correction (log frequency, ±3 dB) and the bands' gain reduction. */
export function ToneCurve({ report }: { report: RenderReport }) {
  if (!report.toneCurve.length) return null;
  const w = 300;
  const h = 90;
  const x = (f: number) => (Math.log10(f / 20) / Math.log10(20_000 / 20)) * w;
  const y = (db: number) => h / 2 - (db / 3) * (h / 2 - 6);
  const pts = report.toneFreqs.map((f, i) => `${x(f).toFixed(1)},${y(report.toneCurve[i]).toFixed(1)}`).join(" ");
  const [lo, mid, hi] = report.bandGainReductionDb;
  return (
    <div className="tone-curve">
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img" aria-label="自動トーン補正のカーブ">
        {[100, 1000, 10_000].map((f) => (
          <g key={f}>
            <line x1={x(f)} x2={x(f)} y1={0} y2={h} className="grid" />
            <text x={x(f) + 3} y={h - 4} className="axis">
              {f >= 1000 ? `${f / 1000}k` : f}
            </text>
          </g>
        ))}
        <line x1={0} x2={w} y1={h / 2} y2={h / 2} className="grid zero" />
        <text x={3} y={12} className="axis">
          +3 dB
        </text>
        <text x={3} y={h - 16} className="axis">
          −3 dB
        </text>
        <polyline points={pts} className="curve" />
      </svg>
      <p className="sub">
        コンプの平均リダクション：低 {lo.toFixed(1)} ／ 中 {mid.toFixed(1)} ／ 高 {hi.toFixed(1)} dB
      </p>
    </div>
  );
}
