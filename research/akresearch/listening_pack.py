"""Build a listening pack: 15 s from the loudest part of each album track's raw Suno mix,
loudness-matched, so the user can rate how shimmery each one sounds."""
import json

import numpy as np
import pyloudnorm as pyln
import soundfile as sf

from .golden import REPO, manifest
from .metrics import short_term_lufs

RAW = REPO / "research/out/raw"
OUT = REPO / "research/out/listening"
SECONDS = 15
TARGET_LUFS = -18.0  # quiet enough to leave true-peak headroom without limiting
FADE_S = 0.3


def excerpt(x: np.ndarray, sr: int) -> tuple[np.ndarray, float]:
    st = short_term_lufs(x, sr)  # 3 s windows, 100 ms hop
    win = int(SECONDS / 0.1)
    smooth = np.convolve(st, np.ones(win) / win, mode="valid")
    start_s = float(np.argmax(smooth)) * 0.1
    a = int(start_s * sr)
    return x[:, a : a + SECONDS * sr].copy(), start_s


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    m = manifest()
    songs = {s["id"]: s for s in m["songs"]}
    sheet = []
    for t in m["albums"]["SUMS"]["tracks"]:
        sid = t["songId"]
        x, sr = sf.read(RAW / f"{sid}-track0.wav", dtype="float64", always_2d=True)
        y, start = excerpt(x.T[:2], sr)
        gain = TARGET_LUFS - pyln.Meter(sr).integrated_loudness(y.T)
        y *= 10 ** (gain / 20)
        n = int(FADE_S * sr)
        ramp = np.sin(np.linspace(0, np.pi / 2, n)) ** 2
        y[:, :n] *= ramp
        y[:, -n:] *= ramp[::-1]
        name = f"{t['no']:02d} {songs[sid]['title']}.wav"
        sf.write(OUT / name, y.T, sr, subtype="PCM_24")
        mmss = f"{int(start // 60)}:{start % 60:04.1f}"
        sheet.append({"no": t["no"], "title": songs[sid]["title"], "file": name, "from": mmss, "peak": float(np.max(np.abs(y)))})
        print(f"{name}  （元の曲の {mmss} から {SECONDS} 秒、ピーク {20 * np.log10(sheet[-1]['peak']):.1f} dBFS）")
    (OUT / "sheet.json").write_text(json.dumps(sheet, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
