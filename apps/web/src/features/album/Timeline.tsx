// Album timeline: tracks and gaps to scale, with the playhead; click to play from there.
import type { SeqState } from "./sequence";

type Item = { id: string; title: string; frames: number; gapAfterSec: number };

export function Timeline({ items, state, onSeek }: { items: Item[]; state: SeqState | null; onSeek: (index: number, frame: number) => void }) {
  const SR = 48_000;
  const total = items.reduce((s, t, i) => s + t.frames / SR + (i < items.length - 1 ? t.gapAfterSec : 0), 0) || 1;
  let acc = 0;
  const segs = items.map((t, i) => {
    const start = acc;
    acc += t.frames / SR + (i < items.length - 1 ? t.gapAfterSec : 0);
    return { ...t, start, len: t.frames / SR };
  });
  const head = state?.playing ? segs[state.index].start + (state.inGap ? segs[state.index].len : state.position / SR) : null;
  return (
    <div className="timeline" role="group" aria-label="アルバムのタイムライン">
      {segs.map((s, i) => (
        <button
          key={s.id}
          className={`seg${state?.playing && state.index === i ? " on" : ""}`}
          style={{ left: `${(s.start / total) * 100}%`, width: `${(s.len / total) * 100}%` }}
          title={`${String(i + 1).padStart(2, "0")} ${s.title}`}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onSeek(i, Math.round(((e.clientX - r.left) / r.width) * s.frames));
          }}
        >
          {String(i + 1).padStart(2, "0")}
        </button>
      ))}
      {head !== null && <span className="playhead" style={{ left: `${(head / total) * 100}%` }} />}
    </div>
  );
}
