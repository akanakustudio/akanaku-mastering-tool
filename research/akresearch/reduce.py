"""Shimmer reduction prototypes for blind listening (P0-4).

B: plain high-shelf EQ (control: is a simple EQ enough?)
C: detailed design 7.5 - smooth fast upward fluctuations of the 6-16 kHz bands
D: new idea - split the highs into harmonic / percussive / residual (HPSS with margin);
   keep harmonic, cut the noise-like residual (grain, "s"), trim percussive a little ("t", hats)
"""
import numpy as np
from scipy import ndimage, signal

N_FFT, HOP = 2048, 512


def _stft(x, sr):
    win = np.sqrt(signal.windows.hann(N_FFT, sym=False))
    _, _, z = signal.stft(x, sr, window=win, nperseg=N_FFT, noverlap=N_FFT - HOP, boundary="even", padded=True)
    return z


def _istft(z, sr, n):
    win = np.sqrt(signal.windows.hann(N_FFT, sym=False))
    _, y = signal.istft(z, sr, window=win, nperseg=N_FFT, noverlap=N_FFT - HOP, boundary=True)
    return y[..., :n]


def _band_weight(f, lo, hi, edge_oct=1 / 3):
    """1 inside [lo, hi], cosine ramps of `edge_oct` octaves outside."""
    w = np.zeros_like(f)
    lo0, hi1 = lo * 2 ** -edge_oct, hi * 2**edge_oct
    for i, fc in enumerate(f):
        if lo <= fc <= hi:
            w[i] = 1
        elif lo0 < fc < lo:
            w[i] = np.sin(0.5 * np.pi * np.log2(fc / lo0) / edge_oct) ** 2
        elif hi < fc < hi1:
            w[i] = np.cos(0.5 * np.pi * np.log2(fc / hi) / edge_oct) ** 2
    return w


def _apply_gain(x, sr, gain_fn):
    """Compute a gain mask from the mid STFT and apply it to both channels (keeps the image)."""
    z = np.stack([_stft(x[0], sr), _stft(x[1], sr)])
    f = np.fft.rfftfreq(N_FFT, 1 / sr)
    mid = np.abs(0.5 * (z[0] + z[1]))
    g = gain_fn(f, mid)
    return np.stack([_istft(z[0] * g, sr, x.shape[1]), _istft(z[1] * g, sr, x.shape[1])])


def eq_shelf(x, sr, freq=4500.0, gain_db=-3.6):
    """B: RBJ high shelf. Defaults match D's overall 4-16 kHz reduction (about -3.3 dB), so the
    blind test compares *how* the highs are reduced, not how much."""
    a = 10 ** (gain_db / 40)
    w0 = 2 * np.pi * freq / sr
    alpha = np.sin(w0) / 2 * np.sqrt(2)  # S = 1
    cw = np.cos(w0)
    b = [a * ((a + 1) + (a - 1) * cw + 2 * np.sqrt(a) * alpha), -2 * a * ((a - 1) + (a + 1) * cw), a * ((a + 1) + (a - 1) * cw - 2 * np.sqrt(a) * alpha)]
    den = [(a + 1) - (a - 1) * cw + 2 * np.sqrt(a) * alpha, 2 * ((a - 1) - (a + 1) * cw), (a + 1) - (a - 1) * cw - 2 * np.sqrt(a) * alpha]
    return signal.lfilter(np.array(b) / den[0], np.array(den) / den[0], x, axis=1)


def fluctuation_smooth(x, sr, amount=0.7, threshold_db=1.5, window=7, transient_protect=0.7):
    """C: detailed design 7.5."""

    def gain(f, mag):
        l = 20 * np.log10(mag + 1e-12)
        w = _band_weight(f, 6000, 16000)[:, None]
        e = ndimage.median_filter(l, size=(1, window), mode="nearest")
        e = ndimage.uniform_filter1d(e, size=5, axis=0)  # light smoothing across frequency
        m = (f >= 2000) & (f < 16000)
        flux = np.concatenate([[0.0], np.sum(np.maximum(np.diff(mag[m], axis=1), 0), axis=0)])
        t = np.clip(flux / (3 * ndimage.median_filter(flux, size=43) + 1e-12), 0, 1)
        t = ndimage.maximum_filter1d(t, size=5)
        s = amount * w * (1 - transient_protect * t[None, :])
        l_out = (1 - s) * l + s * np.minimum(l, e + threshold_db)
        return 10 ** ((l_out - l) / 20)

    return _apply_gain(x, sr, gain)


def hpss_highs(x, sr, residual_db=-7.0, percussive_db=-2.5, lo=4000.0, hi=16000.0, kernel=17, margin=2.0):
    """D: keep harmonic highs, cut residual (grain, sibilant hiss), trim percussive (plosives, hats)."""

    def gain(f, mag):
        p2 = mag**2
        h = ndimage.median_filter(p2, size=(1, kernel), mode="nearest")  # smooth in time  -> harmonic
        p = ndimage.median_filter(p2, size=(kernel, 1), mode="nearest")  # smooth in freq -> percussive
        eps = 1e-20
        mh = h / (h + margin**2 * p + eps)
        mp = p / (p + margin**2 * h + eps)
        mr = np.clip(1 - mh - mp, 0, 1)
        g_band = mh + mp * 10 ** (percussive_db / 20) + mr * 10 ** (residual_db / 20)
        w = _band_weight(f, lo, hi)[:, None]
        g = 1 - w * (1 - g_band)
        return ndimage.uniform_filter1d(g, size=3, axis=1)  # tame musical noise

    return _apply_gain(x, sr, gain)


METHODS = {"B": eq_shelf, "C": fluctuation_smooth, "D": hpss_highs}
