//! True peak (4x oversampling, 48 taps per phase; detailed design 6.1).
use crate::Stereo;
use crate::dsp::oversample::Oversampler4;

pub fn true_peak_linear(x: &Stereo) -> f32 {
    let os = Oversampler4::new(48);
    let bound = os.gain_bound();
    let mut best = x.l.iter().chain(&x.r).fold(0.0f32, |m, s| m.max(s.abs()));
    for ch in x.channels() {
        let wmax = os.window_abs_max(ch);
        for n in 0..ch.len() {
            // Exact skip: the interpolated value cannot exceed wmax · bound.
            if wmax[n] * bound > best {
                best = best.max(os.peak_at(ch, n));
            }
        }
    }
    best
}

pub fn true_peak_dbtp(x: &Stereo) -> f64 {
    20.0 * libm::log10(f64::from(true_peak_linear(x)).max(1e-12))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skipping_matches_brute_force() {
        let mut seed = 3u32;
        let ch: Vec<f32> = (0..20_000)
            .map(|i| {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                (seed as f32 / u32::MAX as f32 - 0.5) * if i % 5000 < 50 { 1.6 } else { 0.3 }
            })
            .collect();
        let x = Stereo::new(ch.clone(), ch.iter().map(|s| s * 0.5).collect());
        let os = Oversampler4::new(48);
        let brute =
            x.channels().iter().map(|c| (0..c.len()).fold(0.0f32, |m, n| m.max(os.peak_at(c, n)).max(c[n].abs()))).fold(0.0, f32::max);
        assert_eq!(true_peak_linear(&x), brute);
    }

    #[test]
    fn detects_inter_sample_peak() {
        // fs/4 sine with 45° phase: samples are ±0.707·A but the waveform peaks at A.
        let x: Vec<f32> = (0..4800).map(|n| libm::sinf(core::f32::consts::FRAC_PI_2 * n as f32 + core::f32::consts::FRAC_PI_4)).collect();
        let tp = true_peak_dbtp(&Stereo::new(x.clone(), x));
        assert!(tp > -0.3 && tp < 0.3, "got {tp}");
    }
}
