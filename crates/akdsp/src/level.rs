//! Simple level measurements.

/// Floor returned for digital silence, in dBFS.
pub const SILENCE_DBFS: f32 = -200.0;

/// RMS level of `x` in dBFS (full-scale sine = -3.01 dBFS).
pub fn rms_dbfs(x: &[f32]) -> f32 {
    if x.is_empty() {
        return SILENCE_DBFS;
    }
    let sum_sq: f64 = x.iter().map(|&s| f64::from(s) * f64::from(s)).sum();
    let mean_sq = sum_sq / x.len() as f64;
    if mean_sq <= 0.0 {
        return SILENCE_DBFS;
    }
    (10.0 * libm::log10(mean_sq)) as f32
}

/// Absolute sample peak of `x` in dBFS.
pub fn peak_dbfs(x: &[f32]) -> f32 {
    let peak = x.iter().fold(0.0f32, |m, &s| m.max(s.abs()));
    if peak <= 0.0 {
        return SILENCE_DBFS;
    }
    20.0 * libm::log10f(peak)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(len: usize, amp: f32) -> Vec<f32> {
        (0..len).map(|n| amp * libm::sinf(2.0 * core::f32::consts::PI * 1000.0 * n as f32 / 48_000.0)).collect()
    }

    #[test]
    fn full_scale_sine_rms_is_minus_3_db() {
        let x = sine(48_000, 1.0);
        assert!((rms_dbfs(&x) - (-3.0103)).abs() < 0.01);
    }

    #[test]
    fn half_scale_sine_peak_is_minus_6_db() {
        let x = sine(48_000, 0.5);
        assert!((peak_dbfs(&x) - (-6.0206)).abs() < 0.01);
    }

    #[test]
    fn silence_returns_floor() {
        assert_eq!(rms_dbfs(&[0.0; 16]), SILENCE_DBFS);
        assert_eq!(peak_dbfs(&[]), SILENCE_DBFS);
    }
}
