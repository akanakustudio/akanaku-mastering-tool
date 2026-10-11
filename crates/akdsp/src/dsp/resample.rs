//! Rational polyphase resampler (e.g. 44.1 kHz <-> 48 kHz), Kaiser-windowed sinc.
use super::{kaiser, sinc};

const TAPS_PER_PHASE: usize = 48;
const BETA: f64 = 9.0;

fn gcd(a: u32, b: u32) -> u32 {
    if b == 0 { a } else { gcd(b, a % b) }
}

/// Resamples one channel from `from` Hz to `to` Hz. Output length = ceil(len * to / from).
pub fn resample(x: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to {
        return x.to_vec();
    }
    let g = gcd(from, to);
    let (up, down) = ((to / g) as usize, (from / g) as usize);
    let len = TAPS_PER_PHASE * up;
    // Cutoff just below the lower Nyquist, normalised to the upsampled rate.
    let fc = 0.5 / up.max(down) as f64 * 0.97;
    let center = (len - 1) as f64 / 2.0;
    let h: Vec<f32> =
        (0..len).map(|n| (2.0 * fc * sinc(2.0 * fc * (n as f64 - center)) * kaiser(n, len, BETA) * up as f64) as f32).collect();

    let out_len = (x.len() * up).div_ceil(down);
    let delay = len / 2; // group delay in upsampled samples
    let mut y = vec![0.0f32; out_len];
    for (m, out) in y.iter_mut().enumerate() {
        let t = m * down + delay;
        let phase = t % up;
        let base = t / up;
        let mut acc = 0.0f32;
        for j in 0..TAPS_PER_PHASE {
            if let Some(&s) = base.checked_sub(j).and_then(|i| x.get(i)) {
                acc += h[phase + j * up] * s;
            }
        }
        *out = acc;
    }
    y
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sine_keeps_level_and_frequency_through_44k1_to_48k() {
        let x: Vec<f32> = (0..44_100).map(|n| libm::sinf(2.0 * core::f32::consts::PI * 1000.0 * n as f32 / 44_100.0) * 0.5).collect();
        let y = resample(&x, 44_100, 48_000);
        assert_eq!(y.len(), 48_000);
        // Compare against the ideal 48 kHz sine in the steady middle part.
        let err = (4_000..44_000)
            .map(|n| (y[n] - libm::sinf(2.0 * core::f32::consts::PI * 1000.0 * n as f32 / 48_000.0) * 0.5).abs())
            .fold(0.0f32, f32::max);
        assert!(err < 2e-3, "max error {err}");
    }
}
