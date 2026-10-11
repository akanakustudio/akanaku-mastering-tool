"""Blind listening pack: A (original) / B / C / D for the songs rated 3, shuffled and loudness-matched."""
import json
import random

import numpy as np
import pyloudnorm as pyln
import soundfile as sf

from .golden import REPO, manifest
from .reduce import METHODS

RAW = REPO / "research/out/raw"
OUT = REPO / "research/out/blind"
SONGS = [2, 3, 12]  # rated 3 ("bothersome")
SECONDS, MARGIN, TARGET_LUFS, FADE_S = 15, 2.0, -18.0, 0.3


def finish(y, sr):
    y = y * 10 ** ((TARGET_LUFS - pyln.Meter(sr).integrated_loudness(y.T)) / 20)
    n = int(FADE_S * sr)
    ramp = np.sin(np.linspace(0, np.pi / 2, n)) ** 2
    y[:, :n] *= ramp
    y[:, -n:] *= ramp[::-1]
    return y


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    m = manifest()
    songs = {s["id"]: s for s in m["songs"]}
    tracks = {t["no"]: t for t in m["albums"]["SUMS"]["tracks"]}
    sheet = {e["no"]: e for e in json.loads((REPO / "research/out/listening/sheet.json").read_text(encoding="utf-8"))}
    rng = random.Random(20261011)
    key = {}
    for no in SONGS:
        sid = tracks[no]["songId"]
        x, sr = sf.read(RAW / f"{sid}-track0.wav", dtype="float64", always_2d=True)
        x = x.T[:2]
        mm, ss = sheet[no]["from"].split(":")
        start = int((int(mm) * 60 + float(ss)) * sr)
        a, b = start - int(MARGIN * sr), start + SECONDS * sr + int(MARGIN * sr)
        seg = x[:, max(0, a) : b]
        versions = {"A": seg.copy(), **{k: fn(seg, sr) for k, fn in METHODS.items()}}
        trim = slice(int(MARGIN * sr), int(MARGIN * sr) + SECONDS * sr)
        labels = list(versions)
        rng.shuffle(labels)
        for i, label in enumerate(labels, 1):
            y = finish(versions[label][:, trim].copy(), sr)
            peak = np.max(np.abs(y))
            name = f"{no:02d} {songs[sid]['title']} - {i}.wav"
            sf.write(OUT / name, y.T, sr, subtype="PCM_24")
            key[name] = label
            print(f"{name}  peak {20 * np.log10(peak):.1f} dBFS")
    (REPO / "research/out/blind_key.json").write_text(json.dumps(key, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
