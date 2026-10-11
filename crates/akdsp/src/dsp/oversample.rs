//! 4x polyphase oversampling for true-peak detection (detailed design 6.1, 8.6).
use super::{kaiser, sinc};

pub struct Oversampler4 {
    taps: usize,
    phases: [Vec<f32>; 4],
}

impl Oversampler4 {
    /// `taps` per phase: 48 for measurement, fewer for the limiter's detector.
    pub fn new(taps: usize) -> Self {
        let len = taps * 4;
        let fc = 0.5 / 4.0 * 0.9;
        let center = (len - 1) as f64 / 2.0;
        let h: Vec<f64> = (0..len).map(|n| 2.0 * fc * sinc(2.0 * fc * (n as f64 - center)) * kaiser(n, len, 8.0) * 4.0).collect();
        let phases = core::array::from_fn(|p| (0..taps).map(|j| h[p + 4 * j] as f32).collect());
        Self { taps, phases }
    }

    /// Group delay in input samples.
    pub fn delay(&self) -> usize {
        self.taps / 2
    }

    /// Largest absolute value among the 4 sub-samples around input index `n`
    /// (compensated for the filter delay).
    #[inline]
    pub fn peak_at(&self, x: &[f32], n: usize) -> f32 {
        let base = n + self.delay();
        let mut peak = 0.0f32;
        for ph in &self.phases {
            let mut acc = 0.0f32;
            for (j, &c) in ph.iter().enumerate() {
                if let Some(&s) = base.checked_sub(j).and_then(|i| x.get(i)) {
                    acc += c * s;
                }
            }
            peak = peak.max(acc.abs());
        }
        peak
    }

    /// Envelope of oversampled peaks, one value per input sample.
    pub fn peak_envelope(&self, x: &[f32]) -> Vec<f32> {
        (0..x.len()).map(|n| self.peak_at(x, n).max(x[n].abs())).collect()
    }

    /// Upper bound of |peak_at(x, n)| relative to the largest |x| among the samples it uses:
    /// the largest sum of absolute coefficients over the phases.
    pub fn gain_bound(&self) -> f32 {
        self.phases.iter().map(|p| p.iter().map(|c| c.abs()).sum::<f32>()).fold(0.0, f32::max)
    }

    /// For each n, the largest |x| among the samples `peak_at(x, n)` reads
    /// (`n + delay − taps + 1 ..= n + delay`), via a monotonic deque in O(N).
    pub fn window_abs_max(&self, x: &[f32]) -> Vec<f32> {
        let n = x.len();
        let (d, t) = (self.delay(), self.taps);
        let mut out = vec![0.0f32; n];
        let mut dq: std::collections::VecDeque<usize> = std::collections::VecDeque::new();
        let mut next = 0usize; // next input index to push
        for (i, o) in out.iter_mut().enumerate() {
            let hi = (i + d).min(n.saturating_sub(1));
            while next <= hi {
                while dq.back().is_some_and(|&k| x[k].abs() <= x[next].abs()) {
                    dq.pop_back();
                }
                dq.push_back(next);
                next += 1;
            }
            let lo = (i + d + 1).saturating_sub(t);
            while dq.front().is_some_and(|&k| k < lo) {
                dq.pop_front();
            }
            *o = dq.front().map_or(0.0, |&k| x[k].abs());
        }
        out
    }
}
