//! Automatic tone correction (detailed design 8.2, adapted): even out bumps and dips of the
//! track's own average spectrum relative to its one-octave trend, with a linear-phase FIR.
//! Genre target curves (U2) are not decided yet, so the track is its own reference.
use realfft::RealFftPlanner;

use super::kaiser;
use crate::Stereo;

/// 1/6-octave analysis points from 20 Hz (61 points, up to ~20.5 kHz).
pub const POINTS: usize = 61;
pub fn point_freq(k: usize) -> f64 {
    20.0 * libm::pow(2.0, k as f64 / 6.0)
}

/// Largest correction at amount 1.0, dB.
pub const MAX_CORRECTION_DB: f32 = 3.0;
const FIR_TAPS: usize = 8191;
const FFT_GRID: usize = 16384;

/// Average spectrum of the mid signal (Welch, n_fft 8192, Hann, 50 % overlap) at the 61 points, dB.
pub fn average_spectrum_db(x: &Stereo, sr: u32) -> Vec<f32> {
    let n = 8192;
    let hop = n / 2;
    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(n);
    let window: Vec<f32> = (0..n).map(|i| 0.5 - 0.5 * libm::cosf(2.0 * core::f32::consts::PI * i as f32 / n as f32)).collect();
    let mut buf = fft.make_input_vec();
    let mut spec = fft.make_output_vec();
    let mut acc = vec![0.0f64; n / 2 + 1];
    let mut frames = 0;
    let mut start = 0;
    while start + n <= x.len() {
        for i in 0..n {
            buf[i] = 0.5 * (x.l[start + i] + x.r[start + i]) * window[i];
        }
        fft.process(&mut buf, &mut spec).expect("fft");
        for (a, c) in acc.iter_mut().zip(&spec) {
            *a += f64::from(c.norm_sqr());
        }
        frames += 1;
        start += hop;
    }
    let bin_hz = f64::from(sr) / n as f64;
    (0..POINTS)
        .map(|k| {
            let (lo, hi) = (point_freq(k) * libm::pow(2.0, -1.0 / 12.0), point_freq(k) * libm::pow(2.0, 1.0 / 12.0));
            let (b0, b1) = ((lo / bin_hz).floor() as usize, ((hi / bin_hz).ceil() as usize).min(acc.len() - 1));
            let (sum, cnt) = (b0..=b1.max(b0)).fold((0.0, 0), |(s, c), b| (s + acc[b.min(acc.len() - 1)], c + 1));
            (10.0 * libm::log10((sum / cnt.max(1) as f64 / frames.max(1) as f64).max(1e-20))) as f32
        })
        .collect()
}

/// Weight of the correction by frequency: none below 30 Hz or above 18 kHz.
fn range_weight(f: f64) -> f32 {
    let w = if f < 30.0 {
        0.0
    } else if f < 60.0 {
        libm::log2(f / 30.0)
    } else if f <= 14_000.0 {
        1.0
    } else if f < 18_000.0 {
        1.0 - libm::log2(f / 14_000.0) / libm::log2(18_000.0 / 14_000.0)
    } else {
        0.0
    };
    w as f32
}

/// Above this frequency the correction only cuts: boosting the highs of Suno output brings
/// out its shimmer (research 3.4).
pub const CUT_ONLY_ABOVE_HZ: f64 = 4000.0;

/// Correction at full amount: one-octave trend minus the spectrum, clipped to ±MAX, in dB.
pub fn deviation(spectrum_db: &[f32]) -> Vec<f32> {
    (0..POINTS)
        .map(|k| {
            let (a, b) = (k.saturating_sub(3), (k + 3).min(POINTS - 1));
            let trend = spectrum_db[a..=b].iter().sum::<f32>() / (b - a + 1) as f32;
            let mut d = (trend - spectrum_db[k]).clamp(-MAX_CORRECTION_DB, MAX_CORRECTION_DB);
            if point_freq(k) >= CUT_ONLY_ABOVE_HZ {
                d = d.min(0.0);
            }
            d * range_weight(point_freq(k))
        })
        .collect()
}

/// Linear-phase FIR whose magnitude follows `curve_db` (61 points), by frequency sampling.
pub fn design_fir(curve_db: &[f32], sr: u32) -> Vec<f32> {
    let mut planner = RealFftPlanner::<f32>::new();
    let ifft = planner.plan_fft_inverse(FFT_GRID);
    let mut spec = ifft.make_input_vec();
    let bin_hz = f64::from(sr) / FFT_GRID as f64;
    for (i, c) in spec.iter_mut().enumerate() {
        let f = (i as f64 * bin_hz).max(1.0);
        // Interpolate in log frequency; hold the ends.
        let pos = (6.0 * libm::log2(f / 20.0)).clamp(0.0, (POINTS - 1) as f64);
        let k = pos.floor() as usize;
        let t = (pos - k as f64) as f32;
        let db = if k + 1 < POINTS { curve_db[k] * (1.0 - t) + curve_db[k + 1] * t } else { curve_db[POINTS - 1] };
        c.re = libm::powf(10.0, db / 20.0);
        c.im = 0.0;
    }
    let mut imp = ifft.make_output_vec();
    ifft.process(&mut spec, &mut imp).expect("ifft");
    // Zero-phase impulse is centred at 0; rotate to the middle of the FIR and window it.
    let half = FIR_TAPS / 2;
    (0..FIR_TAPS)
        .map(|n| {
            let idx = (n as isize - half as isize).rem_euclid(FFT_GRID as isize) as usize;
            imp[idx] / FFT_GRID as f32 * kaiser(n, FIR_TAPS, 8.0) as f32
        })
        .collect()
}

/// FFT convolution (overlap-save) with the FIR's delay removed: output has the input's length.
pub fn convolve(x: &[f32], h: &[f32]) -> Vec<f32> {
    let n = FFT_GRID;
    let m = h.len();
    let step = n - m + 1;
    let delay = m / 2;
    let mut planner = RealFftPlanner::<f32>::new();
    let fwd = planner.plan_fft_forward(n);
    let inv = planner.plan_fft_inverse(n);
    let mut hbuf = fwd.make_input_vec();
    hbuf[..m].copy_from_slice(h);
    let mut hspec = fwd.make_output_vec();
    fwd.process(&mut hbuf, &mut hspec).expect("fft");

    let total = x.len() + delay;
    let mut out = vec![0.0f32; x.len()];
    let mut buf = fwd.make_input_vec();
    let mut spec = fwd.make_output_vec();
    let mut time = inv.make_output_vec();
    let mut pos = 0usize; // output index (before delay removal) of the first valid sample
    while pos < total {
        // Input block covers x[pos - (m - 1) .. pos - (m - 1) + n].
        for (i, b) in buf.iter_mut().enumerate() {
            let xi = pos as isize - (m as isize - 1) + i as isize;
            *b = if xi >= 0 && (xi as usize) < x.len() { x[xi as usize] } else { 0.0 };
        }
        fwd.process(&mut buf, &mut spec).expect("fft");
        for (s, hs) in spec.iter_mut().zip(&hspec) {
            *s *= *hs;
        }
        inv.process(&mut spec, &mut time).expect("ifft");
        for i in 0..step {
            let y = pos + i;
            if y >= delay && y - delay < out.len() {
                out[y - delay] = time[m - 1 + i] / n as f32;
            }
        }
        pos += step;
    }
    out
}

/// `amount` × `deviation`, plus the album correction (`extra`, empty = none), in dB.
pub fn total_curve(deviation: &[f32], amount: f32, extra: &[f32]) -> Vec<f32> {
    deviation.iter().enumerate().map(|(k, d)| d * amount + if extra.len() == POINTS { extra[k] } else { 0.0 }).collect()
}

/// Applies `total_curve` to both channels. Returns the input unchanged when the curve is flat.
pub fn apply_tone_match(x: &Stereo, sr: u32, deviation: &[f32], amount: f32, extra: &[f32]) -> (Stereo, Vec<f32>) {
    let curve = total_curve(deviation, amount, extra);
    if curve.iter().all(|c| c.abs() < 0.01) {
        return (x.clone(), curve);
    }
    let h = design_fir(&curve, sr);
    (Stereo::new(convolve(&x.l, &h), convolve(&x.r, &h)), curve)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_curve_is_transparent() {
        let x: Vec<f32> = (0..50_000).map(|i| libm::sinf(i as f32 * 0.05) * 0.3).collect();
        let h = design_fir(&[0.0; POINTS], 48_000);
        let y = convolve(&x, &h);
        let err = x[5_000..45_000].iter().zip(&y[5_000..45_000]).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
        assert!(err < 1e-3, "max error {err}");
    }

    #[test]
    fn boost_at_1khz_shows_in_the_output() {
        let mut curve = [0.0f32; POINTS];
        curve[40] = 3.0; // 20 * 2^(40/6) ≈ 2 kHz
        let f = point_freq(40) as f32;
        let x: Vec<f32> = (0..96_000).map(|i| libm::sinf(2.0 * core::f32::consts::PI * f * i as f32 / 48_000.0) * 0.3).collect();
        let y = convolve(&x, &design_fir(&curve, 48_000));
        let rms = |v: &[f32]| (v.iter().map(|s| s * s).sum::<f32>() / v.len() as f32).sqrt();
        let gain = 20.0 * libm::log10f(rms(&y[10_000..86_000]) / rms(&x[10_000..86_000]));
        assert!((gain - 3.0).abs() < 0.3, "gain {gain}");
    }

    #[test]
    fn deviation_flattens_a_bump() {
        let mut spec = [0.0f32; POINTS];
        spec[30] = 4.0; // a 4 dB bump at ~640 Hz
        let d = deviation(&spec);
        assert!(d[30] < -2.5 && d[30] >= -MAX_CORRECTION_DB);
        assert!(d[20].abs() < 0.01);
    }

    #[test]
    fn never_boosts_above_4khz() {
        let mut spec = [0.0f32; POINTS];
        spec[50] = -4.0; // a dip at ~6.4 kHz would normally be filled
        assert_eq!(deviation(&spec)[50], 0.0);
    }
}
