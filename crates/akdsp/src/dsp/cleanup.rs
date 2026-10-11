//! Suno cleanup (P0-4 method D): split the highs into harmonic / percussive / residual with
//! median-filter HPSS; keep the harmonic part, cut the noise-like residual (grain, sibilant
//! hiss) and trim the percussive part (plosives). One STFT pass, one gain mask shared by L/R
//! so the stereo image is unchanged (detailed design 7.1, 7.3).
use realfft::RealFftPlanner;

use crate::Stereo;

const N_FFT: usize = 2048;
const HOP: usize = 512;
const KERNEL: usize = 17;
const MARGIN2: f32 = 4.0; // HPSS margin 2, squared
const BAND_LO: f64 = 4000.0;
const BAND_HI: f64 = 16000.0;
const EDGE_OCT: f64 = 1.0 / 3.0;

#[derive(Clone, Copy, Debug)]
pub struct CleanupParams {
    /// 0..=1. Maps to residual cut −10 dB × amount and percussive cut −3.5 dB × amount.
    pub amount: f32,
}

fn band_weight(f: f64) -> f32 {
    let lo0 = BAND_LO * libm::pow(2.0, -EDGE_OCT);
    let hi1 = BAND_HI * libm::pow(2.0, EDGE_OCT);
    let w = if (BAND_LO..=BAND_HI).contains(&f) {
        1.0
    } else if f > lo0 && f < BAND_LO {
        libm::pow(libm::sin(0.5 * core::f64::consts::PI * libm::log2(f / lo0) / EDGE_OCT), 2.0)
    } else if f > BAND_HI && f < hi1 {
        libm::pow(libm::cos(0.5 * core::f64::consts::PI * libm::log2(f / BAND_HI) / EDGE_OCT), 2.0)
    } else {
        0.0
    };
    w as f32
}

fn median(buf: &mut [f32]) -> f32 {
    let mid = buf.len() / 2;
    *buf.select_nth_unstable_by(mid, f32::total_cmp).1
}

/// Applies the cleanup. `on_progress` receives 0..1 and returns false to cancel (→ `None`).
pub fn cleanup(x: &Stereo, sr: u32, p: CleanupParams, on_progress: &mut dyn FnMut(f32) -> bool) -> Option<Stereo> {
    if p.amount <= 0.0 || x.len() < N_FFT {
        return Some(x.clone());
    }
    let residual_gain = libm::powf(10.0, -10.0 * p.amount / 20.0);
    let percussive_gain = libm::powf(10.0, -3.5 * p.amount / 20.0);

    let bin_hz = f64::from(sr) / N_FFT as f64;
    let n_bins = N_FFT / 2 + 1;
    let weights: Vec<f32> = (0..n_bins).map(|k| band_weight(k as f64 * bin_hz)).collect();
    let band_lo = weights.iter().position(|&w| w > 0.0).unwrap_or(n_bins);
    let band_hi = weights.iter().rposition(|&w| w > 0.0).map_or(band_lo, |k| k + 1);
    if band_lo >= band_hi {
        return Some(x.clone());
    }
    // Extra bins on both sides give the frequency median some context.
    let ext_lo = band_lo.saturating_sub(KERNEL / 2);
    let ext_hi = (band_hi + KERNEL / 2).min(n_bins);
    let n_ext = ext_hi - ext_lo;

    let window: Vec<f32> =
        (0..N_FFT).map(|n| libm::sqrtf(0.5 - 0.5 * libm::cosf(2.0 * core::f32::consts::PI * n as f32 / N_FFT as f32))).collect();
    let pad = N_FFT - HOP;
    let len = x.len();
    // Enough frames that every sample, including the last ones, gets the full 4x overlap.
    let n_frames = (len + pad).div_ceil(HOP) + N_FFT / HOP;
    let frame_start = |t: usize| (t * HOP) as isize - pad as isize;

    let mut planner = RealFftPlanner::<f32>::new();
    let fwd = planner.plan_fft_forward(N_FFT);
    let inv = planner.plan_fft_inverse(N_FFT);
    let mut frame = fwd.make_input_vec();
    let mut spec_l = fwd.make_output_vec();
    let mut spec_r = fwd.make_output_vec();

    let load = |ch: &[f32], t: usize, out: &mut Vec<f32>| {
        let start = frame_start(t);
        for (n, v) in out.iter_mut().enumerate() {
            let i = start + n as isize;
            *v = if i >= 0 && (i as usize) < ch.len() { ch[i as usize] * window[n] } else { 0.0 };
        }
    };

    // Pass 1: power of the mid signal in the (extended) band, per frame.
    let mut pow = vec![0.0f32; n_frames * n_ext];
    for t in 0..n_frames {
        load(&x.l, t, &mut frame);
        fwd.process(&mut frame, &mut spec_l).expect("fft");
        load(&x.r, t, &mut frame);
        fwd.process(&mut frame, &mut spec_r).expect("fft");
        for b in 0..n_ext {
            let k = ext_lo + b;
            pow[t * n_ext + b] = ((spec_l[k] + spec_r[k]) * 0.5).norm_sqr();
        }
        if t % 256 == 0 && !on_progress(0.3 * t as f32 / n_frames as f32) {
            return None;
        }
    }

    // Harmonic estimate: median over time per bin.
    let half = KERNEL / 2;
    let mut harm = vec![0.0f32; n_frames * n_ext];
    let mut win = [0.0f32; KERNEL];
    for b in 0..n_ext {
        for t in 0..n_frames {
            for (j, w) in win.iter_mut().enumerate() {
                let tt = (t + j).saturating_sub(half).min(n_frames - 1);
                *w = pow[tt * n_ext + b];
            }
            harm[t * n_ext + b] = median(&mut win);
        }
        if b % 32 == 0 && !on_progress(0.3 + 0.3 * b as f32 / n_ext as f32) {
            return None;
        }
    }

    // Gain per frame and band bin. Percussive estimate: median over frequency within the frame.
    let n_band = band_hi - band_lo;
    let mut gain = vec![1.0f32; n_frames * n_band];
    for t in 0..n_frames {
        let row = &pow[t * n_ext..(t + 1) * n_ext];
        for k in band_lo..band_hi {
            let b = k - ext_lo;
            for (j, w) in win.iter_mut().enumerate() {
                *w = row[(b + j).saturating_sub(half).min(n_ext - 1)];
            }
            let perc = median(&mut win);
            let h = harm[t * n_ext + b];
            let eps = 1e-20;
            let mh = h / (h + MARGIN2 * perc + eps);
            let mp = perc / (perc + MARGIN2 * h + eps);
            let mr = (1.0 - mh - mp).clamp(0.0, 1.0);
            let g_band = mh + mp * percussive_gain + mr * residual_gain;
            gain[t * n_band + (k - band_lo)] = 1.0 - weights[k] * (1.0 - g_band);
        }
    }
    drop(harm);
    drop(pow);
    // Smooth over 3 frames to tame musical noise.
    let mut smoothed = gain.clone();
    for t in 0..n_frames {
        for b in 0..n_band {
            let a = gain[t.saturating_sub(1) * n_band + b];
            let c = gain[(t + 1).min(n_frames - 1) * n_band + b];
            smoothed[t * n_band + b] = (a + gain[t * n_band + b] + c) / 3.0;
        }
    }
    if !on_progress(0.7) {
        return None;
    }

    // Pass 2: apply the mask to each channel and overlap-add (√Hann² at 75 % overlap sums to 2).
    let mut out = Stereo::zeros(len);
    let mut spec = fwd.make_output_vec();
    let mut time = inv.make_output_vec();
    for (ci, ch) in x.channels().into_iter().enumerate() {
        let dst = if ci == 0 { &mut out.l } else { &mut out.r };
        for t in 0..n_frames {
            load(ch, t, &mut frame);
            fwd.process(&mut frame, &mut spec).expect("fft");
            for k in band_lo..band_hi {
                spec[k] *= smoothed[t * n_band + (k - band_lo)];
            }
            spec[0].im = 0.0;
            spec[n_bins - 1].im = 0.0;
            inv.process(&mut spec, &mut time).expect("ifft");
            let start = frame_start(t);
            for (n, &v) in time.iter().enumerate() {
                let i = start + n as isize;
                if i >= 0 && (i as usize) < len {
                    dst[i as usize] += v * window[n] / (N_FFT as f32 * 2.0);
                }
            }
        }
        if !on_progress(0.7 + 0.15 * (ci + 1) as f32) {
            return None;
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_amount_is_bit_exact_bypass() {
        let x = Stereo::new(vec![0.25; 10_000], vec![-0.5; 10_000]);
        assert_eq!(cleanup(&x, 48_000, CleanupParams { amount: 0.0 }, &mut |_| true).unwrap(), x);
    }

    #[test]
    fn leaves_low_frequencies_untouched() {
        // A 200 Hz tone is far below the band, so the STFT round trip must reconstruct it.
        // (The abrupt start of the test signal does have high-frequency content, so skip the edges.)
        let n = 48_000;
        let ch: Vec<f32> = (0..n).map(|i| 0.5 * libm::sinf(2.0 * core::f32::consts::PI * 200.0 * i as f32 / 48_000.0)).collect();
        let x = Stereo::new(ch.clone(), ch);
        let y = cleanup(&x, 48_000, CleanupParams { amount: 1.0 }, &mut |_| true).unwrap();
        let err = x.l[2048..n - 2048].iter().zip(&y.l[2048..n - 2048]).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
        assert!(err < 1e-4, "max error {err}");
    }

    #[test]
    fn reduces_high_frequency_noise() {
        let mut seed = 1u32;
        let mut noise = || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            (seed as f32 / u32::MAX as f32 - 0.5) * 0.2
        };
        let ch: Vec<f32> = (0..96_000).map(|_| noise()).collect();
        let x = Stereo::new(ch.clone(), ch);
        let y = cleanup(&x, 48_000, CleanupParams { amount: 1.0 }, &mut |_| true).unwrap();
        let e = |v: &[f32]| v.iter().map(|s| s * s).sum::<f32>();
        assert!(e(&y.l) < e(&x.l), "white noise should lose energy in the high band");
    }
}
