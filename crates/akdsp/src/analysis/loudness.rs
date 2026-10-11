//! ITU-R BS.1770-4 loudness (detailed design 6.1).
use crate::Stereo;
use crate::dsp::biquad::Biquad;

/// Mean square of the K-weighted signal, summed over channels, per 100 ms segment.
pub struct Segments {
    pub power: Vec<f64>,
}

const ABS_GATE: f64 = -70.0;

fn k_weighting(sr: f64) -> [Biquad; 2] {
    // Stage 1: high shelf (+4 dB, 1.5 kHz); stage 2: RLB high pass (38 Hz). Same design as pyloudnorm.
    [
        Biquad::high_shelf(sr, 1500.0, 4.0, 1.0 / core::f64::consts::SQRT_2),
        Biquad::high_pass(sr, 38.0, 0.5),
    ]
}

pub fn segments(x: &Stereo, sr: u32) -> Segments {
    let seg_len = (sr / 10) as usize;
    let n_seg = x.len() / seg_len;
    let mut power = vec![0.0f64; n_seg];
    for ch in x.channels() {
        let [mut shelf, mut hp] = k_weighting(f64::from(sr));
        for (i, chunk) in ch.chunks(seg_len).take(n_seg).enumerate() {
            let mut acc = 0.0;
            for &s in chunk {
                let y = hp.tick(shelf.tick(f64::from(s)));
                acc += y * y;
            }
            power[i] += acc / seg_len as f64;
        }
    }
    Segments { power }
}

fn to_lufs(z: f64) -> f64 {
    -0.691 + 10.0 * libm::log10(z.max(1e-20))
}

fn window_means(seg: &Segments, w: usize) -> Vec<f64> {
    if seg.power.len() < w {
        return Vec::new();
    }
    let mut acc: f64 = seg.power[..w].iter().sum();
    let mut out = vec![acc / w as f64];
    for i in w..seg.power.len() {
        acc += seg.power[i] - seg.power[i - w];
        out.push(acc / w as f64);
    }
    out
}

/// Integrated loudness with absolute (-70 LUFS) and relative (-10 LU) gates.
pub fn integrated(seg: &Segments) -> f64 {
    let blocks = window_means(seg, 4); // 400 ms blocks, 100 ms hop
    let gated: Vec<f64> = blocks
        .into_iter()
        .filter(|&z| to_lufs(z) > ABS_GATE)
        .collect();
    if gated.is_empty() {
        return f64::NEG_INFINITY;
    }
    let rel = to_lufs(gated.iter().sum::<f64>() / gated.len() as f64) - 10.0;
    let kept: Vec<f64> = gated.into_iter().filter(|&z| to_lufs(z) > rel).collect();
    to_lufs(kept.iter().sum::<f64>() / kept.len() as f64)
}

/// Short-term loudness (3 s window, 100 ms hop).
pub fn short_term(seg: &Segments) -> Vec<f64> {
    window_means(seg, 30).into_iter().map(to_lufs).collect()
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    let idx = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[idx]
}

/// 95th percentile of gated short-term loudness: "the loud part" (detailed design 10.2).
pub fn l95(st: &[f64]) -> f64 {
    let mut v: Vec<f64> = st.iter().copied().filter(|&l| l > ABS_GATE).collect();
    if v.is_empty() {
        return f64::NEG_INFINITY;
    }
    v.sort_by(f64::total_cmp);
    percentile(&v, 0.95)
}

/// Loudness range (EBU Tech 3342).
pub fn lra(st: &[f64]) -> f64 {
    let abs: Vec<f64> = st.iter().copied().filter(|&l| l > ABS_GATE).collect();
    if abs.is_empty() {
        return 0.0;
    }
    let mean_pow = abs
        .iter()
        .map(|&l| libm::pow(10.0, (l + 0.691) / 10.0))
        .sum::<f64>()
        / abs.len() as f64;
    let rel = to_lufs(mean_pow) - 20.0;
    let mut v: Vec<f64> = abs.into_iter().filter(|&l| l > rel).collect();
    if v.len() < 2 {
        return 0.0;
    }
    v.sort_by(f64::total_cmp);
    percentile(&v, 0.95) - percentile(&v, 0.10)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(sr: u32, secs: f64, freq: f64, amp: f64) -> Stereo {
        let n = (f64::from(sr) * secs) as usize;
        let ch: Vec<f32> = (0..n)
            .map(|i| {
                (amp * libm::sin(2.0 * core::f64::consts::PI * freq * i as f64 / f64::from(sr)))
                    as f32
            })
            .collect();
        Stereo::new(ch.clone(), ch)
    }

    #[test]
    fn ebu_1khz_sine_at_minus_20dbfs_is_minus_23_lufs() {
        // EBU Tech 3341 case 1: stereo 1 kHz sine at -23 dBFS reads -23 LUFS.
        let x = sine(48_000, 20.0, 1000.0, libm::pow(10.0, -23.0 / 20.0));
        let l = integrated(&segments(&x, 48_000));
        assert!((l - (-23.0)).abs() < 0.1, "got {l}");
    }

    #[test]
    fn works_at_44k1() {
        let x = sine(44_100, 20.0, 1000.0, libm::pow(10.0, -33.0 / 20.0));
        let l = integrated(&segments(&x, 44_100));
        assert!((l - (-33.0)).abs() < 0.1, "got {l}");
    }
}
