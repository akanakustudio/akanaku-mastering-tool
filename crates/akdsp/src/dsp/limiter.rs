//! True-peak lookahead limiter (detailed design 8.6).
//! The gain looks ahead instead of delaying the signal, so there is no latency to compensate.
use std::collections::VecDeque;

use super::oversample::Oversampler4;
use crate::Stereo;

#[derive(Clone, Copy, Debug)]
pub struct LimiterParams {
    pub ceiling_dbtp: f32,
    pub lookahead_ms: f32,
    pub release_ms: f32,
}

impl Default for LimiterParams {
    fn default() -> Self {
        Self { ceiling_dbtp: -1.0, lookahead_ms: 1.5, release_ms: 150.0 }
    }
}

pub struct LimiterOutput {
    pub audio: Stereo,
    /// Gain reduction per sample, dB (≤ 0).
    pub gain_reduction_db: Vec<f32>,
}

/// Limits `x` after applying `input_gain_db`.
pub fn limit(x: &Stereo, sr: u32, input_gain_db: f32, p: LimiterParams) -> LimiterOutput {
    let n = x.len();
    let g_in = libm::powf(10.0, input_gain_db / 20.0);
    let xin = x.scaled(g_in);
    // 0.1 dB safety margin under the ceiling.
    let ceiling = libm::powf(10.0, (p.ceiling_dbtp - 0.1) / 20.0);

    // Detector: oversampled peak of either channel (16 taps per phase is enough to steer gain).
    let os = Oversampler4::new(48);
    let bound = os.gain_bound();
    let (wl, wr) = (os.window_abs_max(&xin.l), os.window_abs_max(&xin.r));
    let req: Vec<f32> = (0..n)
        .map(|i| {
            // Exact skip: if no interpolated value can reach the ceiling, there is nothing to compute.
            if wl[i].max(wr[i]) * bound <= ceiling {
                return 1.0;
            }
            let pk = os.peak_at(&xin.l, i).max(xin.l[i].abs()).max(os.peak_at(&xin.r, i)).max(xin.r[i].abs());
            if pk > ceiling { ceiling / pk } else { 1.0 }
        })
        .collect();

    // Look-ahead minimum over [i, i + la] (monotonic deque).
    let la = ((p.lookahead_ms / 1000.0) * sr as f32).round().max(1.0) as usize;
    let mut gmin = vec![1.0f32; n];
    let mut dq: VecDeque<usize> = VecDeque::new();
    for j in (0..n).rev() {
        while dq.back().is_some_and(|&k| req[k] >= req[j]) {
            dq.pop_back();
        }
        dq.push_back(j);
        while dq.front().is_some_and(|&k| k > j + la) {
            dq.pop_front();
        }
        gmin[j] = req[*dq.front().unwrap()];
    }

    // Attack: moving average over the la + 1 preceding look-ahead minima. Every one of them is
    // ≤ the requirement at the peak, so the peak is always fully reduced.
    let w = la + 1;
    let mut att = vec![1.0f32; n];
    let mut acc = 0.0f64;
    for i in 0..n {
        acc += f64::from(gmin[i]);
        if i >= w {
            acc -= f64::from(gmin[i - w]);
        }
        // Before the start, repeat the first minimum so a peak at sample 0 is still caught.
        att[i] = ((acc + w.saturating_sub(i + 1) as f64 * f64::from(gmin[0])) / w as f64) as f32;
    }

    // Release: the gain drops instantly to the attack curve but recovers exponentially.
    let rel = 1.0 - libm::expf(-1.0 / (p.release_ms / 1000.0 * sr as f32));
    let mut audio = Stereo::zeros(n);
    let mut gr = vec![0.0f32; n];
    let mut g = 1.0f32;
    for i in 0..n {
        g = if att[i] < g { att[i] } else { g + (att[i] - g) * rel };
        let gi = g.min(att[i]);
        audio.l[i] = xin.l[i] * gi;
        audio.r[i] = xin.r[i] * gi;
        gr[i] = 20.0 * libm::log10f(gi.max(1e-6));
    }
    LimiterOutput { audio, gain_reduction_db: gr }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::truepeak::true_peak_dbtp;

    #[test]
    fn output_true_peak_stays_under_the_ceiling() {
        // Loud square-ish wave plus noise bursts, pushed 12 dB into the limiter.
        let n = 96_000;
        let mut seed = 7u32;
        let ch: Vec<f32> = (0..n)
            .map(|i| {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                let noise = (seed as f32 / u32::MAX as f32 - 0.5) * if (i / 4000) % 3 == 0 { 1.0 } else { 0.1 };
                0.6 * libm::sinf(2.0 * core::f32::consts::PI * 997.0 * i as f32 / 48_000.0).signum() + noise
            })
            .collect();
        let x = Stereo::new(ch.clone(), ch.iter().map(|s| -s).collect());
        let y = limit(&x, 48_000, 12.0, LimiterParams::default());
        let tp = true_peak_dbtp(&y.audio);
        assert!(tp <= -1.0 + 0.05, "true peak {tp}");
    }
}
