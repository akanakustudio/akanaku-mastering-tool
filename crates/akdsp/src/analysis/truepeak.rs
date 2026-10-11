//! True peak (4x oversampling, 48 taps per phase; detailed design 6.1).
use crate::Stereo;
use crate::dsp::oversample::Oversampler4;

pub fn true_peak_linear(x: &Stereo) -> f32 {
    let os = Oversampler4::new(48);
    x.channels()
        .iter()
        .map(|ch| (0..ch.len()).fold(0.0f32, |m, n| m.max(os.peak_at(ch, n)).max(ch[n].abs())))
        .fold(0.0, f32::max)
}

pub fn true_peak_dbtp(x: &Stereo) -> f64 {
    20.0 * libm::log10(f64::from(true_peak_linear(x)).max(1e-12))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_inter_sample_peak() {
        // fs/4 sine with 45° phase: samples are ±0.707·A but the waveform peaks at A.
        let x: Vec<f32> = (0..4800)
            .map(|n| {
                libm::sinf(core::f32::consts::FRAC_PI_2 * n as f32 + core::f32::consts::FRAC_PI_4)
            })
            .collect();
        let tp = true_peak_dbtp(&Stereo::new(x.clone(), x));
        assert!(tp > -0.3 && tp < 0.3, "got {tp}");
    }
}
