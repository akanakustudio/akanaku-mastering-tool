//! Display data for the waveform view (detailed design 11.1, 11.2).
use crate::Stereo;

/// Bin sizes of the peak pyramid, in frames.
pub const PYRAMID_BINS: [usize; 4] = [256, 1024, 4096, 16384];

/// Combined-channel `[min, max, rms]` per bin of `bin` frames, from `sample(i) -> (l, r)`.
fn pyramid_level(len: usize, bin: usize, sample: impl Fn(usize) -> (f32, f32)) -> Vec<f32> {
    let n = len.div_ceil(bin);
    let mut out = Vec::with_capacity(n * 3);
    for b in 0..n {
        let (mut lo, mut hi, mut sq) = (0.0f32, 0.0f32, 0.0f64);
        let end = ((b + 1) * bin).min(len);
        for i in b * bin..end {
            let (l, r) = sample(i);
            lo = lo.min(l).min(r);
            hi = hi.max(l).max(r);
            sq += 0.5 * f64::from(l * l + r * r);
        }
        out.extend([lo, hi, (sq / (end - b * bin) as f64).sqrt() as f32]);
    }
    out
}

pub fn peaks(x: &Stereo, bin: usize) -> Vec<f32> {
    pyramid_level(x.len(), bin, |i| (x.l[i], x.r[i]))
}

/// Peaks of `after − gain · before` (the difference signal, 11.1).
pub fn diff_peaks(before: &Stereo, after: &Stereo, gain: f32, bin: usize) -> Vec<f32> {
    pyramid_level(before.len().min(after.len()), bin, |i| {
        (
            after.l[i] - gain * before.l[i],
            after.r[i] - gain * before.r[i],
        )
    })
}

/// Short-time level change after vs. before (50 ms windows, 100 Hz), minus `offset_db`.
/// NaN where both are below −60 dBFS (11.2).
pub fn gain_delta(before: &Stereo, after: &Stereo, sr: u32, offset_db: f32) -> Vec<f32> {
    let hop = (sr / 100) as usize;
    let win = (sr / 20) as usize;
    let len = before.len().min(after.len());
    let power = |x: &Stereo, a: usize, b: usize| {
        (a..b)
            .map(|i| 0.5 * f64::from(x.l[i] * x.l[i] + x.r[i] * x.r[i]))
            .sum::<f64>()
            / (b - a) as f64
    };
    let floor = 1e-6; // −60 dBFS
    (0..len.div_ceil(hop))
        .map(|k| {
            let a = (k * hop).min(len.saturating_sub(1));
            let b = (a + win).min(len).max(a + 1);
            let (pb, pa) = (power(before, a, b), power(after, a, b));
            if pb < floor && pa < floor {
                f32::NAN
            } else {
                (10.0 * libm::log10(pa.max(1e-20) / pb.max(1e-20))) as f32 - offset_db
            }
        })
        .collect()
}
