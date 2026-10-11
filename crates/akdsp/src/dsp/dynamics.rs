//! Three-band compressor (detailed design 8.3): LR4 crossovers at 150 Hz / 3 kHz, stereo-linked
//! RMS detection, soft knee, automatic thresholds from the track's own band levels, and
//! make-up gain that keeps each band's long-term level (so the tone does not change).
use super::biquad::Biquad;
use crate::Stereo;

const Q: f64 = core::f64::consts::FRAC_1_SQRT_2;
pub const CROSSOVERS: [f64; 2] = [150.0, 3000.0];
const KNEE_DB: f32 = 6.0;

fn lr4(sr: f64, f: f64, high: bool) -> [Biquad; 2] {
    if high { [Biquad::high_pass(sr, f, Q), Biquad::high_pass(sr, f, Q)] } else { [Biquad::low_pass(sr, f, Q), Biquad::low_pass(sr, f, Q)] }
}

fn run(fs: &mut [Biquad; 2], x: &[f32]) -> Vec<f32> {
    let mut y = x.to_vec();
    fs[0].process(&mut y);
    fs[1].process(&mut y);
    y
}

/// Splits a channel into low / mid / high; the low band gets an allpass at the upper crossover
/// so the three bands sum back to a flat magnitude.
pub fn split3(x: &[f32], sr: u32) -> [Vec<f32>; 3] {
    let sr = f64::from(sr);
    let [f1, f2] = CROSSOVERS;
    let low1 = run(&mut lr4(sr, f1, false), x);
    let rest = run(&mut lr4(sr, f1, true), x);
    let mid = run(&mut lr4(sr, f2, false), &rest);
    let high = run(&mut lr4(sr, f2, true), &rest);
    let lo_lp = run(&mut lr4(sr, f2, false), &low1);
    let lo_hp = run(&mut lr4(sr, f2, true), &low1);
    let low: Vec<f32> = lo_lp.iter().zip(&lo_hp).map(|(a, b)| a + b).collect();
    [low, mid, high]
}

#[derive(Clone, Copy, Debug)]
struct BandParams {
    threshold_db: f32,
    ratio: f32,
    attack_ms: f32,
    release_ms: f32,
}

fn lerp3(p: f32, a: f32, b: f32, c: f32) -> f32 {
    if p < 0.5 { a + (b - a) * p * 2.0 } else { b + (c - b) * (p - 0.5) * 2.0 }
}

/// Punch macro mapping (detailed design 8.3 table), `punch` 0..=1.
fn band_params(level_db: [f32; 3], punch: f32) -> [BandParams; 3] {
    let attack_mult = lerp3(punch, 0.6, 1.0, 1.8);
    let shift = lerp3(punch, 3.0, 0.0, -3.0);
    let ratios = [lerp3(punch, 1.3, 1.8, 2.5), 1.6, 1.5];
    let attacks = [30.0, 20.0, 10.0];
    let releases = [200.0, 150.0, 100.0];
    core::array::from_fn(|b| BandParams {
        threshold_db: level_db[b] + 2.0 + shift,
        ratio: ratios[b],
        attack_ms: attacks[b] * attack_mult,
        release_ms: releases[b],
    })
}

fn linked_power(l: &[f32], r: &[f32], i: usize) -> f32 {
    0.5 * (l[i] * l[i] + r[i] * r[i])
}

/// 70th percentile of the 400 ms RMS level of each band (dB), ignoring near-silence.
pub fn band_levels(bands: &[[Vec<f32>; 3]; 2], sr: u32) -> [f32; 3] {
    let win = (sr as usize * 4) / 10;
    core::array::from_fn(|b| {
        let (l, r) = (&bands[0][b], &bands[1][b]);
        let mut levels: Vec<f32> = l
            .chunks(win)
            .enumerate()
            .map(|(k, c)| {
                let p: f32 = (0..c.len()).map(|i| linked_power(l, r, k * win + i)).sum::<f32>() / c.len() as f32;
                10.0 * libm::log10f(p.max(1e-12))
            })
            .filter(|&d| d > -60.0)
            .collect();
        if levels.is_empty() {
            return -60.0;
        }
        levels.sort_by(f32::total_cmp);
        levels[((levels.len() - 1) as f32 * 0.7) as usize]
    })
}

fn gain_computer(level_db: f32, p: &BandParams) -> f32 {
    let over = level_db - p.threshold_db;
    let slope = 1.0 / p.ratio - 1.0;
    if over <= -KNEE_DB / 2.0 {
        0.0
    } else if over >= KNEE_DB / 2.0 {
        slope * over
    } else {
        slope * (over + KNEE_DB / 2.0).powi(2) / (2.0 * KNEE_DB)
    }
}

pub struct DynamicsOutput {
    pub audio: Stereo,
    pub makeup_db: [f32; 3],
    pub mean_gain_reduction_db: [f32; 3],
}

/// Compresses `x`. `levels` are the band levels from `band_levels` (full track); `makeup`
/// is computed when `None` (full render) or reused (region render).
pub fn compress(x: &Stereo, sr: u32, punch: f32, levels: [f32; 3], makeup: Option<[f32; 3]>) -> DynamicsOutput {
    let bands = [split3(&x.l, sr), split3(&x.r, sr)];
    let params = band_params(levels, punch);
    let n = x.len();
    let det_coef = 1.0 - libm::expf(-1.0 / (0.010 * sr as f32));
    let mut out = Stereo::zeros(n);
    let mut makeup_out = [0.0f32; 3];
    let mut mean_gr = [0.0f32; 3];
    for b in 0..3 {
        let p = &params[b];
        let (l, r) = (&bands[0][b], &bands[1][b]);
        let att = 1.0 - libm::expf(-1.0 / (p.attack_ms / 1000.0 * sr as f32));
        let rel = 1.0 - libm::expf(-1.0 / (p.release_ms / 1000.0 * sr as f32));
        let (mut env, mut gr) = (0.0f32, 0.0f32);
        let mut gains = vec![0.0f32; n];
        let (mut p_in, mut p_out, mut gr_sum) = (0.0f64, 0.0f64, 0.0f64);
        for i in 0..n {
            let pw = linked_power(l, r, i);
            env += (pw - env) * det_coef;
            let target = gain_computer(10.0 * libm::log10f(env.max(1e-12)), p);
            gr += (target - gr) * if target < gr { att } else { rel };
            let g = libm::powf(10.0, gr / 20.0);
            gains[i] = g;
            p_in += f64::from(pw);
            p_out += f64::from(pw * g * g);
            gr_sum += f64::from(gr);
        }
        let mk = makeup.map_or_else(|| (10.0 * libm::log10(p_in.max(1e-20) / p_out.max(1e-20))) as f32, |m| m[b]);
        makeup_out[b] = mk;
        mean_gr[b] = (gr_sum / n.max(1) as f64) as f32;
        let mg = libm::powf(10.0, mk / 20.0);
        for i in 0..n {
            out.l[i] += l[i] * gains[i] * mg;
            out.r[i] += r[i] * gains[i] * mg;
        }
    }
    DynamicsOutput { audio: out, makeup_db: makeup_out, mean_gain_reduction_db: mean_gr }
}

/// Band split of both channels, for `band_levels`.
pub fn split_stereo(x: &Stereo, sr: u32) -> [[Vec<f32>; 3]; 2] {
    [split3(&x.l, sr), split3(&x.r, sr)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bands_sum_back_to_flat_magnitude() {
        // Allpass sum: same RMS as the input for tones in each band.
        for f in [60.0f32, 150.0, 1000.0, 3000.0, 9000.0] {
            let x: Vec<f32> = (0..96_000).map(|i| libm::sinf(2.0 * core::f32::consts::PI * f * i as f32 / 48_000.0) * 0.5).collect();
            let [a, b, c] = split3(&x, 48_000);
            let y: Vec<f32> = (0..x.len()).map(|i| a[i] + b[i] + c[i]).collect();
            let rms = |v: &[f32]| (v[20_000..].iter().map(|s| s * s).sum::<f32>() / (v.len() - 20_000) as f32).sqrt();
            let db = 20.0 * libm::log10f(rms(&y) / rms(&x));
            assert!(db.abs() < 0.1, "{f} Hz: {db} dB");
        }
    }

    #[test]
    fn keeps_long_term_band_levels_and_reduces_peaks() {
        let n = 10 * 48_000;
        // A quiet 1 kHz tone with a loud second every five seconds: the auto threshold
        // (70th percentile + 2 dB) sits near the quiet level, so the loud parts get compressed.
        let ch: Vec<f32> = (0..n)
            .map(|i| {
                libm::sinf(2.0 * core::f32::consts::PI * 1000.0 * i as f32 / 48_000.0) * if (i / 48_000) % 5 == 0 { 0.5 } else { 0.05 }
            })
            .collect();
        let x = Stereo::new(ch.clone(), ch);
        let levels = band_levels(&split_stereo(&x, 48_000), 48_000);
        let y = compress(&x, 48_000, 0.5, levels, None);
        let p = |v: &[f32]| v.iter().map(|s| f64::from(s * s)).sum::<f64>();
        let total = 10.0 * libm::log10(p(&y.audio.l) / p(&x.l));
        assert!(total.abs() < 0.3, "long-term level change {total} dB");
        assert!(y.mean_gain_reduction_db[1] < -0.1, "mid band should be compressed");
    }
}
