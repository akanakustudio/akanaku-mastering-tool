pub mod loudness;
pub mod truepeak;

use serde::Serialize;

use crate::Stereo;

/// Before/after summary shown in the UI (subset of detailed design 6.1 for the MVP).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    pub lufs: f64,
    pub true_peak: f64,
    pub sample_peak: f64,
    pub plr: f64,
    pub l95: f64,
    pub lra: f64,
    /// Short-term loudness, 10 Hz.
    pub short_term: Vec<f32>,
}

pub fn analyze(x: &Stereo, sr: u32) -> Analysis {
    let seg = loudness::segments(x, sr);
    let lufs = loudness::integrated(&seg);
    let st = loudness::short_term(&seg);
    let true_peak = truepeak::true_peak_dbtp(x);
    let sample_peak = x.l.iter().chain(&x.r).fold(0.0f32, |m, s| m.max(s.abs()));
    Analysis {
        lufs,
        true_peak,
        sample_peak: 20.0 * libm::log10(f64::from(sample_peak).max(1e-12)),
        plr: true_peak - lufs,
        l95: loudness::l95(&st),
        lra: loudness::lra(&st),
        short_term: st.iter().map(|&v| v as f32).collect(),
    }
}
