//! Album tone harmonisation (detailed design 10.3): nudge each track's average tone towards the
//! album's median, gently and broadly.
//!
//! The spectra come from the unprocessed tracks; the automatic tone correction each track will
//! receive is predicted from them, so the album does not need an extra cleanup pass.
use crate::dsp::eq::{POINTS, deviation, point_freq};

/// Largest album correction at amount 1.0, dB.
pub const MAX_ALBUM_DB: f32 = 2.0;
/// As with the per-track correction, only cut above this frequency (Suno highs, research 3.4).
const CUT_ONLY_ABOVE_HZ: f64 = 4000.0;

fn weight(f: f64) -> f32 {
    if (40.0..=16_000.0).contains(&f) { 1.0 } else { 0.0 }
}

/// Mean of the points between 500 Hz and 2 kHz (the normalisation band).
fn mid_level(s: &[f32]) -> f32 {
    let idx: Vec<usize> = (0..POINTS).filter(|&k| (500.0..=2000.0).contains(&point_freq(k))).collect();
    idx.iter().map(|&k| s[k]).sum::<f32>() / idx.len() as f32
}

/// `spectra`: average spectrum (dB, `POINTS` values) of each unprocessed track. Returns the
/// correction for each track (dB, `POINTS` values), with `amount` 0..=1.
pub fn tone_plan(spectra: &[Vec<f32>], tone_match: f32, amount: f32) -> Vec<Vec<f32>> {
    if spectra.len() < 2 || amount <= 0.0 {
        return vec![vec![0.0; POINTS]; spectra.len()];
    }
    // Predicted tone after each track's own correction, normalised at 500 Hz - 2 kHz.
    let predicted: Vec<Vec<f32>> = spectra
        .iter()
        .map(|s| {
            let dev = deviation(s);
            let p: Vec<f32> = (0..POINTS).map(|k| s[k] + dev[k] * tone_match).collect();
            let m = mid_level(&p);
            p.iter().map(|v| v - m).collect()
        })
        .collect();
    // Album reference: the median, so one odd track does not pull the others (10.3).
    let reference: Vec<f32> = (0..POINTS)
        .map(|k| {
            let mut v: Vec<f32> = predicted.iter().map(|p| p[k]).collect();
            v.sort_by(f32::total_cmp);
            let n = v.len();
            if n % 2 == 1 { v[n / 2] } else { 0.5 * (v[n / 2 - 1] + v[n / 2]) }
        })
        .collect();
    predicted
        .iter()
        .map(|p| {
            let diff: Vec<f32> = (0..POINTS).map(|k| reference[k] - p[k]).collect();
            (0..POINTS)
                .map(|k| {
                    // One-octave smoothing keeps the correction broad.
                    let (a, b) = (k.saturating_sub(3), (k + 3).min(POINTS - 1));
                    let mut d = diff[a..=b].iter().sum::<f32>() / (b - a + 1) as f32;
                    d = (d * amount).clamp(-MAX_ALBUM_DB, MAX_ALBUM_DB);
                    if point_freq(k) >= CUT_ONLY_ABOVE_HZ {
                        d = d.min(0.0);
                    }
                    d * weight(point_freq(k))
                })
                .collect()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tilt(db_per_oct: f32) -> Vec<f32> {
        (0..POINTS).map(|k| db_per_oct * (k as f32 / 6.0 - 6.0)).collect()
    }

    #[test]
    fn identical_tracks_need_no_correction() {
        let plan = tone_plan(&[tilt(-3.0), tilt(-3.0), tilt(-3.0)], 0.5, 1.0);
        assert!(plan.iter().flatten().all(|v| v.abs() < 1e-4));
    }

    #[test]
    fn a_brighter_track_is_darkened_and_a_darker_one_is_not_brightened_above_4k() {
        let plan = tone_plan(&[tilt(-3.0), tilt(-3.0), tilt(-1.5), tilt(-4.5)], 0.0, 1.0);
        let k10k = (0..POINTS).find(|&k| point_freq(k) >= 10_000.0).unwrap();
        let k100 = (0..POINTS).find(|&k| point_freq(k) >= 100.0).unwrap();
        assert!(plan[2][k10k] < -0.5, "brighter track should be cut at 10 kHz: {}", plan[2][k10k]);
        assert_eq!(plan[3][k10k], 0.0, "darker track must not be boosted above 4 kHz");
        assert!(plan[3][k100] < 0.0 && plan[2][k100] > 0.0, "below 4 kHz both directions are allowed");
        assert!(plan.iter().flatten().all(|v| v.abs() <= MAX_ALBUM_DB));
    }
}
