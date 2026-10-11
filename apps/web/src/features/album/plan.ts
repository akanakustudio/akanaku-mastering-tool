// Album loudness plan (detailed design 10.2). Pure functions so they can be unit tested.

export type PlanTrack = { id: string; l95Before: number; offsetDb: number };

/** The anchor is the track whose loud part is loudest before processing, unless chosen. */
export function anchorId(tracks: PlanTrack[], chosen: string | "auto"): string | null {
  if (chosen !== "auto" && tracks.some((t) => t.id === chosen)) return chosen;
  let best: PlanTrack | null = null;
  for (const t of tracks) if (!best || t.l95Before > best.l95Before) best = t;
  return best?.id ?? null;
}

/**
 * L95 goal for a non-anchor track: the anchor's processed L95, minus `keep` (0..1) of the
 * original L95 difference, never louder than the anchor, plus the user's offset.
 */
export function l95Goal(track: PlanTrack, anchor: PlanTrack, anchorL95After: number, keep: number): number {
  const goal = anchorL95After - keep * (anchor.l95Before - track.l95Before);
  return Math.min(goal, anchorL95After) + track.offsetDb;
}

/** Order by a leading track number in the file name ("01 ...", "✦12 ...", "3-..."), then by name. */
export function initialOrder<T extends { name: string }>(items: T[]): T[] {
  const num = (n: string) => {
    const m = /^\D{0,2}?(\d{1,3})(?=[\s._\-)])/.exec(n.normalize("NFC"));
    return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
  };
  return [...items].sort((a, b) => num(a.name) - num(b.name) || a.name.localeCompare(b.name, "ja"));
}

/** File name without extension and without a leading "01 " / "✦5 " style number. */
export function titleFromFileName(name: string): string {
  return name
    .normalize("NFC")
    .replace(/\.[^.]+$/, "")
    .replace(/^\D{0,2}?\d{1,3}[\s._-]+/, "")
    .trim();
}
