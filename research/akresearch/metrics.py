"""Analysis metrics from detailed design 6.1 / 6.2 (prototype; Rust is the reference later)."""
import numpy as np
import pyloudnorm as pyln
from scipy import ndimage, signal

# (Calibrate) Shimmer Score mapping, detailed design 6.2.
SHIMMER_S0, SHIMMER_S1 = 1.0, 4.0


def integrated_lufs(x: np.ndarray, sr: int) -> float:
    return float(pyln.Meter(sr).integrated_loudness(x.T))


def true_peak_dbtp(x: np.ndarray, oversample: int = 4) -> float:
    up = signal.resample_poly(x, oversample, 1, axis=1)
    return float(20 * np.log10(np.max(np.abs(up)) + 1e-12))


def short_term_lufs(x: np.ndarray, sr: int, hop_s: float = 0.1) -> np.ndarray:
    """Short-term loudness (3 s window, 100 ms hop), using pyloudnorm's K-weighting."""
    meter = pyln.Meter(sr)
    y = x.T.copy()
    for f in meter._filters.values():
        y = f.apply_filter(y)
    p = np.mean(y**2, axis=1)
    win, hop = int(3 * sr), int(hop_s * sr)
    c = np.concatenate([[0.0], np.cumsum(p)])
    starts = np.arange(0, len(p) - win + 1, hop)
    ms = (c[starts + win] - c[starts]) / win
    return -0.691 + 10 * np.log10(ms + 1e-12)


def l95(x: np.ndarray, sr: int) -> float:
    st = short_term_lufs(x, sr)
    st = st[st > -70]
    return float(np.percentile(st, 95)) if st.size else -70.0


def average_spectrum_db(x: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray]:
    mid = x.mean(axis=0)
    f, p = signal.welch(mid, sr, window="hann", nperseg=8192, noverlap=4096)
    return f, 10 * np.log10(p + 1e-20)


def band_level_db(f: np.ndarray, p_db: np.ndarray, lo: float, hi: float) -> float:
    m = (f >= lo) & (f < hi)
    return float(10 * np.log10(np.mean(10 ** (p_db[m] / 10))))


def stft_mid(x: np.ndarray, sr: int, n_fft: int = 2048, hop: int = 512):
    mid = x.mean(axis=0)
    f, t, z = signal.stft(mid, sr, window="hann", nperseg=n_fft, noverlap=n_fft - hop, boundary=None, padded=False)
    return f, np.abs(z) ** 2  # power [bins, frames]


def shimmer_score(x: np.ndarray, sr: int) -> dict:
    """Shimmer Score (detailed design 6.2): upward, fast fluctuation of the 6-16 kHz bands."""
    f, pw = stft_mid(x, sr)
    frame_db = 10 * np.log10(pw.mean(axis=0) + 1e-20)
    keep = frame_db > -60  # gate silence

    flux = np.sum(np.maximum(np.diff(np.sqrt(pw), axis=1), 0), axis=0)
    flux = np.concatenate([[0.0], flux])
    transient = flux >= np.percentile(flux[keep], 95)
    use = keep & ~transient

    edges = [6000 * 2 ** (k / 3) for k in range(5)] + [16000]
    edges = sorted(set(min(e, 16000) for e in edges))
    fs, sfms = [], []
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (f >= lo) & (f < hi)
        if m.sum() < 2:
            continue
        band = pw[m]
        lb = 10 * np.log10(band.mean(axis=0) + 1e-20)
        eb = ndimage.median_filter(lb, size=7, mode="nearest")
        d = np.maximum(lb - eb, 0)[use]
        fs.append(np.percentile(d, 90))
        geo = np.exp(np.mean(np.log(band[:, use] + 1e-20), axis=0))
        ari = band[:, use].mean(axis=0) + 1e-20
        sfms.append(float(np.mean(geo / ari)))
    F = float(np.mean(fs))
    sfm = float(np.mean(sfms))
    S = F * (0.5 + 0.5 * sfm)
    score = float(np.clip((S - SHIMMER_S0) / (SHIMMER_S1 - SHIMMER_S0), 0, 1) * 100)
    return {"F": F, "sfm": sfm, "S": S, "score": score}


def mono_loudness_drop(x: np.ndarray, sr: int) -> float:
    mono = x.mean(axis=0)
    return integrated_lufs(np.vstack([mono, mono]), sr) - integrated_lufs(x, sr)


def analyze(x: np.ndarray, sr: int) -> dict:
    f, p = average_spectrum_db(x, sr)
    ref = band_level_db(f, p, 500, 2000)
    lufs = integrated_lufs(x, sr)
    tp = true_peak_dbtp(x)
    return {
        "lufs": lufs,
        "tp": tp,
        "plr": tp - lufs,
        "l95": l95(x, sr),
        "low_mid": band_level_db(f, p, 200, 500) - ref,
        "fizz": band_level_db(f, p, 5000, 8000) - ref,
        "air": band_level_db(f, p, 8000, 16000) - ref,
        "top": band_level_db(f, p, 16000, 20000) - ref,
        "mono_drop": mono_loudness_drop(x, sr),
        "shimmer": shimmer_score(x, sr),
    }
