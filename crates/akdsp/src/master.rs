//! Mastering chain: cleanup → auto tone (FIR) → tone shelves → 3-band dynamics → stereo →
//! limiter with loudness targeting (detailed design 4.2 / 8). Full renders also return the
//! statistics that region renders reuse (detailed design 4.5).
use serde::{Deserialize, Serialize};

use crate::Stereo;
use crate::analysis::{loudness, truepeak};
use crate::dsp::cleanup::{CleanupParams, cleanup};
use crate::dsp::dynamics::{band_levels, compress, split_stereo};
use crate::dsp::eq::{self, apply_tone_match, average_spectrum_db, deviation};
use crate::dsp::limiter::{LimiterParams, limit};
use crate::dsp::stereo::apply_stereo;
use crate::dsp::tone::apply_tone;

/// What `target_lufs` refers to (detailed design 10.2).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetMode {
    /// Integrated loudness of the whole track (singles, album anchor).
    #[default]
    Integrated,
    /// 95th percentile of short-term loudness, "the loud part" (other album tracks).
    L95,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MasterSettings {
    /// Cleanup amount 0..=1 (Cleanup macro).
    pub cleanup: f32,
    /// Automatic tone correction amount 0..=1.
    pub tone_match: f32,
    /// Tone −1 (warm) ..= +1 (bright).
    pub tone: f32,
    /// Three-band compressor on/off.
    pub multiband: bool,
    /// Punch macro 0..=1 (compressor attack / ratio / threshold).
    pub punch: f32,
    /// Side gain, 0..=1.5.
    pub width: f32,
    /// Side high-pass (low-end mono), Hz; 0 = off.
    pub mono_below_hz: f32,
    pub target_lufs: f32,
    pub target_mode: TargetMode,
    pub ceiling_dbtp: f32,
    /// Album tone correction (detailed design 10.3), dB at `eq::POINTS` frequencies; empty = none.
    pub album_tone: Vec<f32>,
}

impl Default for MasterSettings {
    fn default() -> Self {
        // Cleanup defaults low because its benefit was not yet audible in P0-4 (docs/04_p0_report.md).
        Self {
            cleanup: 0.5,
            tone_match: 0.5,
            tone: 0.0,
            multiband: true,
            punch: 0.4,
            width: 1.0,
            mono_below_hz: 120.0,
            target_lufs: -14.0,
            target_mode: TargetMode::Integrated,
            ceiling_dbtp: -1.0,
            album_tone: Vec::new(),
        }
    }
}

/// Full-track statistics reused by region renders, so a region sounds like the full render.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainStats {
    /// Tone correction at amount 1.0, dB at `eq::POINTS` frequencies.
    pub tone_deviation: Vec<f32>,
    pub band_levels_db: [f32; 3],
    pub makeup_db: [f32; 3],
    pub limiter_gain_db: f32,
}

/// Cached pre-limiter audio with its key, band levels, make-up and band gain reduction.
type PreLimiter = (Vec<u32>, Stereo, [f32; 3], [f32; 3], [f32; 3]);

/// Stage outputs kept between renders so changing a late stage skips the early ones (4.4).
#[derive(Default)]
pub struct ChainCache {
    cleaned: Option<(u32, Stereo, Vec<f32>)>,
    pre_limiter: Option<PreLimiter>,
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
    /// Applied automatic tone correction, dB at `toneFreqs`.
    pub tone_curve: Vec<f32>,
    pub tone_freqs: Vec<f32>,
    /// Mean gain reduction of the low / mid / high bands, dB.
    pub band_gain_reduction_db: [f32; 3],
}

pub struct Rendered {
    pub audio: Stereo,
    pub report: RenderReport,
    pub stats: ChainStats,
}

/// The render was cancelled through the progress callback.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cancelled;

pub type Progress<'a> = &'a mut dyn FnMut(&str, f32) -> bool;

fn key(v: f32) -> u32 {
    v.to_bits()
}

fn check(progress: Progress, stage: &str, f: f32) -> Result<(), Cancelled> {
    if progress(stage, f) { Ok(()) } else { Err(Cancelled) }
}

/// Tone, dynamics and stereo stages. `stats` = None computes band levels / make-up from `x`.
fn middle(
    x: &Stereo,
    sr: u32,
    s: &MasterSettings,
    deviation_db: &[f32],
    stats: Option<&ChainStats>,
) -> (Stereo, [f32; 3], [f32; 3], [f32; 3]) {
    let (matched, _) = apply_tone_match(x, sr, deviation_db, s.tone_match.clamp(0.0, 1.0), &s.album_tone);
    let toned = apply_tone(&matched, sr, s.tone);
    let (dyn_out, levels, makeup, gr) = if s.multiband {
        let levels = stats.map_or_else(|| band_levels(&split_stereo(&toned, sr), sr), |st| st.band_levels_db);
        let d = compress(&toned, sr, s.punch.clamp(0.0, 1.0), levels, stats.map(|st| st.makeup_db));
        (d.audio, levels, d.makeup_db, d.mean_gain_reduction_db)
    } else {
        (toned, [0.0; 3], [0.0; 3], [0.0; 3])
    };
    (apply_stereo(&dyn_out, sr, s.width.clamp(0.0, 1.5), s.mono_below_hz), levels, makeup, gr)
}

fn measure(y: &Stereo, sr: u32, mode: TargetMode) -> f32 {
    let seg = loudness::segments(y, sr);
    (match mode {
        TargetMode::Integrated => loudness::integrated(&seg),
        TargetMode::L95 => loudness::l95(&loudness::short_term(&seg)),
    }) as f32
}

/// Limiter input gain search with the secant method (8.6), starting from `g0`.
#[allow(clippy::too_many_arguments)]
fn fit_limiter(
    pre: &Stereo,
    sr: u32,
    target: f32,
    mode: TargetMode,
    ceiling: f32,
    g0: f32,
    measure_range: (usize, usize),
    progress: Progress,
) -> Result<(crate::dsp::limiter::LimiterOutput, f32, u32), Cancelled> {
    let lim = LimiterParams { ceiling_dbtp: ceiling, ..Default::default() };
    let (a, b) = measure_range;
    let slice = |x: &Stereo| Stereo::new(x.l[a..b].to_vec(), x.r[a..b].to_vec());
    let mut g = g0.clamp(-24.0, 24.0);
    let mut prev: Option<(f32, f32)> = None;
    let mut iterations = 0;
    loop {
        iterations += 1;
        check(progress, "limiter", (iterations - 1) as f32 / 4.0)?;
        let out = limit(pre, sr, g, lim);
        let l = measure(&slice(&out.audio), sr, mode);
        let err = target - l;
        if err.abs() <= 0.2 || iterations >= 4 || !l.is_finite() {
            return Ok((out, g, iterations));
        }
        let next = match prev {
            Some((gp, lp)) if (l - lp).abs() > 0.05 => g + err * (g - gp) / (l - lp),
            _ => g + err,
        };
        prev = Some((g, l));
        g = next.clamp(-24.0, 24.0);
    }
}

pub fn render(source: &Stereo, sr: u32, s: &MasterSettings, cache: &mut ChainCache, progress: Progress) -> Result<Rendered, Cancelled> {
    // Cleanup (the expensive stage) and the spectrum the tone correction is based on.
    let ck = key(s.cleanup);
    if cache.cleaned.as_ref().is_none_or(|(k, _, _)| *k != ck) {
        check(progress, "cleanup", 0.0)?;
        let out =
            cleanup(source, sr, CleanupParams { amount: s.cleanup.clamp(0.0, 1.0) }, &mut |f| progress("cleanup", f)).ok_or(Cancelled)?;
        let dev = deviation(&average_spectrum_db(&out, sr));
        cache.cleaned = Some((ck, out, dev));
        cache.pre_limiter = None;
    }
    let mut pk = vec![ck, key(s.tone_match), key(s.tone), u32::from(s.multiband), key(s.punch), key(s.width), key(s.mono_below_hz)];
    pk.extend(s.album_tone.iter().map(|v| key(*v)));
    if cache.pre_limiter.as_ref().is_none_or(|(k, ..)| *k != pk) {
        check(progress, "tone", 0.0)?;
        let (_, cleaned, dev) = cache.cleaned.as_ref().unwrap();
        let (pre, levels, makeup, gr) = middle(cleaned, sr, s, dev, None);
        cache.pre_limiter = Some((pk, pre, levels, makeup, gr));
    }
    let (_, pre, levels, makeup, band_gr) = cache.pre_limiter.as_ref().unwrap();
    let dev = cache.cleaned.as_ref().unwrap().2.clone();

    let g0 = s.target_lufs - measure(pre, sr, s.target_mode);
    let (mut out, g, iterations) = fit_limiter(pre, sr, s.target_lufs, s.target_mode, s.ceiling_dbtp, g0, (0, pre.len()), progress)?;

    // Guarantee the ceiling with a final measurement at 4x / 48 taps.
    check(progress, "verify", 0.0)?;
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
        tone_curve: eq::total_curve(&dev, s.tone_match.clamp(0.0, 1.0), &s.album_tone),
        tone_freqs: (0..eq::POINTS).map(|k| eq::point_freq(k) as f32).collect(),
        band_gain_reduction_db: *band_gr,
    };
    let stats = ChainStats { tone_deviation: dev, band_levels_db: *levels, makeup_db: *makeup, limiter_gain_db: g + trim };
    Ok(Rendered { audio: out.audio, report, stats })
}

/// Pre-roll before a region: covers the FIR (8191 taps), STFT context, compressor and limiter release.
pub const REGION_PREROLL_S: f32 = 2.0;
const REGION_POSTROLL_S: f32 = 0.2;
/// Extra samples returned on both sides for the splice crossfade (detailed design 4.5).
pub const SPLICE_FRAMES: usize = 240;

/// Renders `[start, end)` of `source` with new settings for quick auditioning (detailed design 4.5).
/// Full-track statistics come from the last full render. The limiter gain is chosen so the
/// region's loudness becomes `region_lufs_goal` (the previous After's loudness there, shifted by
/// any change of the target). Returns audio for `[start − SPLICE_FRAMES, end + SPLICE_FRAMES)`.
#[allow(clippy::too_many_arguments)]
pub fn render_region(
    source: &Stereo,
    sr: u32,
    s: &MasterSettings,
    stats: &ChainStats,
    start: usize,
    end: usize,
    region_lufs_goal: f32,
    progress: Progress,
) -> Result<(Stereo, usize), Cancelled> {
    let n = source.len();
    let start = start.min(n);
    let end = end.clamp(start, n);
    let a = start.saturating_sub((REGION_PREROLL_S * sr as f32) as usize);
    let b = (end + (REGION_POSTROLL_S * sr as f32) as usize).min(n);
    let seg = Stereo::new(source.l[a..b].to_vec(), source.r[a..b].to_vec());

    let cleaned =
        cleanup(&seg, sr, CleanupParams { amount: s.cleanup.clamp(0.0, 1.0) }, &mut |f| progress("cleanup", f)).ok_or(Cancelled)?;
    check(progress, "tone", 0.0)?;
    let dev = if stats.tone_deviation.len() == eq::POINTS { stats.tone_deviation.clone() } else { vec![0.0; eq::POINTS] };
    let (pre, ..) = middle(&cleaned, sr, s, &dev, Some(stats));
    let range = (start - a, end - a);
    let (out, ..) =
        fit_limiter(&pre, sr, region_lufs_goal, TargetMode::Integrated, s.ceiling_dbtp, stats.limiter_gain_db, range, progress)?;

    let from = start.saturating_sub(SPLICE_FRAMES).max(a) - a;
    let to = (end + SPLICE_FRAMES).min(b) - a;
    Ok((Stereo::new(out.audio.l[from..to].to_vec(), out.audio.r[from..to].to_vec()), from + a))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::analyze;

    fn music(secs: usize) -> Stereo {
        // Two sections 6 dB apart, so integrated loudness and L95 differ.
        let n = secs * 48_000;
        let ch: Vec<f32> = (0..n)
            .map(|i| {
                let t = i as f32 / 48_000.0;
                let amp = if (i / 48_000) % 10 < 5 { 0.1 } else { 0.2 };
                amp * (libm::sinf(2.0 * core::f32::consts::PI * 220.0 * t) + 0.5 * libm::sinf(2.0 * core::f32::consts::PI * 1760.0 * t))
            })
            .collect();
        Stereo::new(ch.clone(), ch)
    }

    #[test]
    fn hits_the_l95_target_in_l95_mode() {
        let x = music(30);
        let s = MasterSettings { cleanup: 0.0, target_lufs: -12.0, target_mode: TargetMode::L95, ..Default::default() };
        let r = render(&x, 48_000, &s, &mut ChainCache::default(), &mut |_, _| true).unwrap();
        let a = analyze(&r.audio, 48_000);
        assert!((a.l95 - -12.0).abs() < 0.3, "l95 {}", a.l95);
        assert!(a.true_peak <= -1.0, "tp {}", a.true_peak);
    }

    #[test]
    fn cancels_when_progress_says_so() {
        let x = music(10);
        let r = render(&x, 48_000, &MasterSettings::default(), &mut ChainCache::default(), &mut |stage, _| stage != "limiter");
        assert!(matches!(r, Err(Cancelled)));
    }

    #[test]
    fn region_render_matches_the_full_render() {
        let x = music(30);
        let s = MasterSettings::default();
        let full = render(&x, 48_000, &s, &mut ChainCache::default(), &mut |_, _| true).unwrap();
        let (start, end) = (12 * 48_000, 20 * 48_000);
        let goal = analyze(&Stereo::new(full.audio.l[start..end].to_vec(), full.audio.r[start..end].to_vec()), 48_000).lufs as f32;
        let (region, offset) = render_region(&x, 48_000, &s, &full.stats, start, end, goal, &mut |_, _| true).unwrap();
        assert_eq!(offset, start - SPLICE_FRAMES);
        assert_eq!(region.len(), end - start + 2 * SPLICE_FRAMES);
        // Same settings and statistics → the region should be close to the full render.
        let err = (0..region.len()).map(|i| (region.l[i] - full.audio.l[offset + i]).abs()).fold(0.0f32, f32::max);
        assert!(err < 0.02, "max difference {err}");
    }
}
