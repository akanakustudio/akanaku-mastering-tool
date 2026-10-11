"""Rank the album's raw Suno full mixes (studio multitrack entry 0) by candidate shimmer metrics."""
import json
from pathlib import Path

import numpy as np

from .explore_shimmer import features
from .golden import REPO, manifest

RAW = REPO / "research/out/raw"
USER_LABEL = {"music-traveler": "気になる", "texture": "気にならない", "ao-ni-kawaru": "気にならない"}


def summarize(feat: dict) -> dict:
    bands = sorted(feat)
    pick = lambda lo, hi, key: [feat[b][key] for b in bands if lo <= b < hi]
    return {
        # High band stays up when the music gets quiet -> a noise bed independent of the music.
        "persist": float(np.median([q - r for q, r in zip(pick(4000, 13000, "quiet_rel"), pick(4000, 13000, "rel"))])),
        "air": float(np.median(pick(8000, 17000, "rel"))),
        "sfm": float(np.mean(pick(2500, 11000, "sfm"))),
        "fluct": float(np.mean(pick(6000, 17000, "fluct7"))),
    }


def main() -> None:
    m = manifest()
    songs = {s["id"]: s for s in m["songs"]}
    rows = []
    for t in m["albums"]["SUMS"]["tracks"]:
        sid = t["songId"]
        path = RAW / f"{sid}-track0.wav"
        rows.append({"no": t["no"], "id": sid, "title": songs[sid]["title"], **summarize(features(str(path)))})
    (RAW.parent / "rank_candidates.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    rows.sort(key=lambda r: -r["persist"])
    print("| 順位 | # | 曲 | 静かな区間でも高域が残る（dB）| 高域の量 8-16k（dB） | 平坦度 2.5-10k | 揺らぎ（現行案） | ユーザー評価 |")
    print("|---|---|---|---|---|---|---|---|")
    for i, r in enumerate(rows, 1):
        print(f"| {i} | {r['no']:02d} | {r['title']} | {r['persist']:+.2f} | {r['air']:.1f} | {r['sfm']:.3f} | {r['fluct']:.2f} | {USER_LABEL.get(r['id'], '')} |")


if __name__ == "__main__":
    main()
