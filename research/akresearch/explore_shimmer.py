"""Explore which high-band features separate songs the user hears as shimmery from those they don't.

usage: python -m akresearch.explore_shimmer label=path [label=path ...]
"""
import sys

import numpy as np
import soundfile as sf
from scipy import ndimage

from .metrics import stft_mid

BANDS = [2000 * 2 ** (k / 3) for k in range(0, 14)]  # 2 kHz .. ~20 kHz, 1/3 octave


def features(path: str) -> dict:
    x, sr = sf.read(path, dtype="float64", always_2d=True)
    x = x.T[:2]
    f, pw = stft_mid(x, sr)
    frame_db = 10 * np.log10(pw.mean(axis=0) + 1e-20)
    keep = frame_db > -60
    ref_mask = (f >= 500) & (f < 2000)
    ref = 10 * np.log10(pw[ref_mask].mean(axis=0) + 1e-20)  # per-frame reference level
    flux = np.concatenate([[0.0], np.sum(np.maximum(np.diff(np.sqrt(pw), axis=1), 0), axis=0)])
    steady = keep & (flux < np.percentile(flux[keep], 95))
    quiet = keep & (frame_db <= np.percentile(frame_db[keep], 10))

    out = {}
    for lo, hi in zip(BANDS[:-1], BANDS[1:]):
        m = (f >= lo) & (f < min(hi, sr / 2))
        if m.sum() < 2:
            continue
        band = pw[m]
        lb = 10 * np.log10(band.mean(axis=0) + 1e-20)
        rel = lb - ref
        eb7 = ndimage.median_filter(lb, size=7, mode="nearest")
        eb3 = ndimage.median_filter(lb, size=3, mode="nearest")
        geo = np.exp(np.mean(np.log(band[:, steady] + 1e-20), axis=0))
        sfm = geo / (band[:, steady].mean(axis=0) + 1e-20)
        # Per-bin temporal roughness: how much each bin's level jumps frame to frame (dB).
        bin_db = 10 * np.log10(band + 1e-20)
        rough = np.median(np.abs(np.diff(bin_db[:, steady], axis=1)), axis=0)
        out[int(round(lo))] = {
            "rel": float(np.median(rel[keep])),
            "fluct7": float(np.percentile(np.maximum(lb - eb7, 0)[steady], 90)),
            "fluct3": float(np.percentile(np.abs(lb - eb3)[steady], 90)),
            "sfm": float(np.median(sfm)),
            "rough": float(np.median(rough)),
            "quiet_rel": float(np.median(rel[quiet])),
        }
    return out


def main() -> None:
    items = [a.split("=", 1) for a in sys.argv[1:]]
    res = {label: features(path) for label, path in items}
    labels = [l for l, _ in items]
    for key, title in [
        ("rel", "帯域レベル（500-2k 比 dB, 中央値）"),
        ("quiet_rel", "静かな区間での帯域レベル（ヒスの目安）"),
        ("fluct7", "上振れの揺らぎ P90（7 フレーム中央値比 dB）= 現行 Shimmer の素"),
        ("fluct3", "速い揺らぎ P90（3 フレーム中央値比 dB）"),
        ("rough", "ビン単位のフレーム間変化の中央値（dB）= ざらつき"),
        ("sfm", "スペクトル平坦度（1 = ノイズ的）"),
    ]:
        print(f"\n### {title}\n")
        print("| 帯域 (Hz) | " + " | ".join(labels) + " |")
        print("|---|" + "---|" * len(labels))
        for band in res[labels[0]]:
            vals = [res[l].get(band, {}).get(key) for l in labels]
            print(f"| {band} | " + " | ".join("-" if v is None else f"{v:.2f}" for v in vals) + " |")


if __name__ == "__main__":
    main()
