//! MVP mastering chain: cleanup → tone → stereo → limiter with loudness targeting
//! (detailed design 4.2 / 8.6, reduced to the stages needed to run end to end).
use serde::{Deserialize, Serialize};

use crate::Stereo;
use crate::analysis::{loudness, truepeak};
use crate::dsp::cleanup::{CleanupParams, cleanup};
use crate::dsp::limiter::{LimiterParams, limit};
use crate::dsp::stereo::apply_stereo;
use crate::dsp::tone::apply_tone;

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MasterSettings {
    /// Cleanup amount 0..=1 (Cleanup macro).
    pub cleanup: f32,
    /// Tone −1 (warm) ..= +1 (bright).
    pub tone: f32,
    /// Side gain, 0..=1.5.
    pub width: f32,
    /// Side high-pass (low-end mono), Hz; 0 = off.
    pub mono_below_hz: f32,
    pub target_lufs: f32,
    pub ceiling_dbtp: f32,
}

impl Default for MasterSettings {
    fn default() -> Self {
        // Cleanup defaults low because its benefit was not yet audible in P0-4 (docs/04_p0_report.md).
        Self {
            cleanup: 0.5,
            tone: 0.0,
            width: 1.0,
            mono_below_hz: 120.0,
            target_lufs: -14.0,
            ceiling_dbtp: -1.0,
        }
    }
}

/// Stage outputs kept between renders so changing only the loudness skips the cleanup (4.4).
#[derive(Default)]
pub struct ChainCache {
    cleaned: Option<(u32, Stereo)>,
    pre_limiter: Option<([u32; 4], Stereo)>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderReport {
    pub applied_gain_db: f32,
    pub iterations: u32,
    /// Extra trim applied after limiting to guarantee the ceiling (detailed design 8.6), dB ≤ 0.
    pub true_peak_trim_db: f32,
    pub mean_gain_reduction_db: f32,
    pub max_gain_reduction_db: f32,
}

pub struct Rendered {
    pub audio: Stereo,
    pub report: RenderReport,
}

fn key(v: f32) -> u32 {
    v.to_bits()
}

pub fn render(
    source: &Stereo,
    sr: u32,
    s: &MasterSettings,
    cache: &mut ChainCache,
    progress: &mut dyn FnMut(&str, f32),
) -> Rendered {
    // Cleanup (the expensive stage).
    let ck = key(s.cleanup);
    if cache.cleaned.as_ref().is_none_or(|(k, _)| *k != ck) {
        progress("cleanup", 0.0);
        let out = cleanup(
            source,
            sr,
            CleanupParams {
                amount: s.cleanup.clamp(0.0, 1.0),
            },
            &mut |f| progress("cleanup", f),
        );
        cache.cleaned = Some((ck, out));
        cache.pre_limiter = None;
    }
    let pk = [ck, key(s.tone), key(s.width), key(s.mono_below_hz)];
    if cache.pre_limiter.as_ref().is_none_or(|(k, _)| *k != pk) {
        progress("tone", 0.0);
        let cleaned = &cache.cleaned.as_ref().unwrap().1;
        let toned = apply_tone(cleaned, sr, s.tone);
        let pre = apply_stereo(&toned, sr, s.width.clamp(0.0, 1.5), s.mono_below_hz);
        cache.pre_limiter = Some((pk, pre));
    }
    let pre = &cache.pre_limiter.as_ref().unwrap().1;

    // Loudness targeting: adjust the limiter's input gain with the secant method (8.6).
    let lim = LimiterParams {
        ceiling_dbtp: s.ceiling_dbtp,
        ..Default::default()
    };
    let measure = |y: &Stereo| loudness::integrated(&loudness::segments(y, sr)) as f32;
    let l_pre = measure(pre);
    let mut g = (s.target_lufs - l_pre).clamp(-24.0, 24.0);
    let mut prev: Option<(f32, f32)> = None;
    let mut iterations = 0;
    let mut out;
    loop {
        iterations += 1;
        progress("limiter", (iterations - 1) as f32 / 4.0);
        out = limit(pre, sr, g, lim);
        let l = measure(&out.audio);
        let err = s.target_lufs - l;
        if err.abs() <= 0.2 || iterations >= 4 {
            break;
        }
        let next = match prev {
            Some((gp, lp)) if (l - lp).abs() > 0.05 => g + err * (g - gp) / (l - lp),
            _ => g + err,
        };
        prev = Some((g, l));
        g = next.clamp(-24.0, 24.0);
    }

    // Guarantee the ceiling with a final measurement at 4x / 48 taps.
    progress("verify", 0.0);
    let tp = truepeak::true_peak_dbtp(&out.audio) as f32;
    let mut trim = 0.0;
    if tp > s.ceiling_dbtp {
        trim = s.ceiling_dbtp - tp - 0.02;
        out.audio.scale(libm::powf(10.0, trim / 20.0));
    }
    let gr = &out.gain_reduction_db;
    let report = RenderReport {
        applied_gain_db: g,
        iterations,
        true_peak_trim_db: trim,
        mean_gain_reduction_db: gr.iter().sum::<f32>() / gr.len().max(1) as f32,
        max_gain_reduction_db: gr.iter().copied().fold(0.0, f32::min),
    };
    Rendered {
        audio: out.audio,
        report,
    }
}
