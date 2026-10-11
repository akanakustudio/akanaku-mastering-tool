"""Correlate candidate shimmer features (computed on the rated excerpts) with the user's ratings."""
import json

import numpy as np
import soundfile as sf
from scipy import ndimage, signal, stats

from .golden import REPO
from .ratings import RATINGS

PACK = REPO / "research/out/listening"


def band_db(f, pw, lo, hi):
    m = (f >= lo) & (f < hi)
    return 10 * np.log10(pw[m].mean(axis=0) + 1e-20)


def octave_smooth(db_spec, f, frac):
    """Smooth a dB spectrum (bins x frames) over 1/frac octave around each bin."""
    out = np.empty_like(db_spec)
    for i, fc in enumerate(f):
        if fc <= 0:
            out[i] = db_spec[i]
            continue
        m = (f >= fc * 2 ** (-0.5 / frac)) & (f <= fc * 2 ** (0.5 / frac))
        out[i] = db_spec[m].mean(axis=0)
    return out


def candidates(path) -> dict:
    x, sr = sf.read(path, dtype="float64", always_2d=True)
    x = x.T[:2]
    mid, side = x.mean(axis=0), 0.5 * (x[0] - x[1])
    kw = dict(window="hann", nperseg=2048, noverlap=1536, boundary=None, padded=False)
    f, _, zm = signal.stft(mid, sr, **kw)
    _, _, zs = signal.stft(side, sr, **kw)
    pm, ps = np.abs(zm) ** 2, np.abs(zs) ** 2
    ref = band_db(f, pm, 500, 2000)
    c = {}
    for lo, hi, name in [(2000, 5000, "2-5k"), (5000, 8000, "5-8k"), (8000, 12000, "8-12k"), (12000, 16000, "12-16k"), (16000, 20000, "16-20k")]:
        c[f"level {name}"] = float(np.median(band_db(f, pm, lo, hi) - ref))
        c[f"side/mid {name}"] = float(np.median(band_db(f, ps, lo, hi) - band_db(f, pm, lo, hi)))
    # Noise-likeness of the highs.
    for lo, hi, name in [(4000, 8000, "4-8k"), (8000, 16000, "8-16k")]:
        m = (f >= lo) & (f < hi)
        geo = np.exp(np.mean(np.log(pm[m] + 1e-20), axis=0))
        c[f"flatness {name}"] = float(np.median(geo / (pm[m].mean(axis=0) + 1e-20)))
    # Design 6.2 style fluctuation (upward deviation from a 7-frame median).
    lb = band_db(f, pm, 6000, 16000)
    c["fluctuation 6-16k"] = float(np.percentile(np.maximum(lb - ndimage.median_filter(lb, 7, mode="nearest"), 0), 90))
    # Narrow resonant peaks above the broad envelope (design 7.6 idea), 3-12 kHz.
    m = (f >= 2500) & (f < 14000)
    db = 10 * np.log10(pm[m] + 1e-20)
    fm = f[m]
    fine = octave_smooth(db, fm, 24)
    broad = octave_smooth(db, fm, 3)
    sel = (fm >= 3000) & (fm < 12000)
    c["resonance peaks 3-12k"] = float(np.mean(np.percentile(np.maximum(fine - broad, 0)[sel], 95, axis=0)))
    # Fast amplitude modulation ("granular" / warble) of the 6-16 kHz envelope: 15-60 Hz share.
    sos = signal.butter(4, [6000, 16000], "bandpass", fs=sr, output="sos")
    env = np.abs(signal.hilbert(signal.sosfiltfilt(sos, mid)))
    env = signal.resample_poly(env, 1, 100)  # 480 Hz
    fe, pe = signal.welch(env - env.mean(), 480, nperseg=1024)
    c["fast modulation 15-60Hz"] = float(10 * np.log10(pe[(fe >= 15) & (fe < 60)].sum() / pe[(fe >= 0.5) & (fe < 15)].sum()))
    return c


def main() -> None:
    files = sorted(PACK.glob("*.wav"))
    feats = {int(p.name[:2]): candidates(p) for p in files}
    nos = sorted(feats)
    y = np.array([RATINGS[n] for n in nos])
    names = list(feats[nos[0]])
    rows = []
    for k in names:
        v = np.array([feats[n][k] for n in nos])
        rho, p = stats.spearmanr(v, y)
        # AUC: does the feature rank every "3" above every "1"?
        hi, lo = v[y == 3], v[y == 1]
        auc = np.mean([(a > b) + 0.5 * (a == b) for a in hi for b in lo])
        rows.append((k, rho, p, auc, {n: feats[n][k] for n in nos}))
    rows.sort(key=lambda r: -abs(r[1]))
    print("| 特徴 | 相関 ρ | p 値 | 3と1の分離（AUC） | 評価3の曲の値 | 評価1の曲の値 |")
    print("|---|---|---|---|---|---|")
    for k, rho, p, auc, vals in rows:
        v3 = ", ".join(f"{vals[n]:.2f}" for n in nos if RATINGS[n] == 3)
        v1 = ", ".join(f"{vals[n]:.2f}" for n in nos if RATINGS[n] == 1)
        print(f"| {k} | {rho:+.2f} | {p:.3f} | {auc:.2f} | {v3} | {v1} |")
    (REPO / "research/out/correlate.json").write_text(json.dumps({str(n): feats[n] for n in nos}, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
