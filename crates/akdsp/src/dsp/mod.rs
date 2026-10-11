pub mod biquad;
pub mod cleanup;
pub mod limiter;
pub mod oversample;
pub mod resample;
pub mod stereo;
pub mod tone;

/// Kaiser window value for `n` in 0..len (detailed design 8.2).
pub(crate) fn kaiser(n: usize, len: usize, beta: f64) -> f64 {
    let x = 2.0 * n as f64 / (len - 1) as f64 - 1.0;
    bessel_i0(beta * libm::sqrt((1.0 - x * x).max(0.0))) / bessel_i0(beta)
}

fn bessel_i0(x: f64) -> f64 {
    let (mut sum, mut term, mut k) = (1.0, 1.0, 1.0);
    while term > 1e-12 * sum {
        term *= (x / (2.0 * k)) * (x / (2.0 * k));
        sum += term;
        k += 1.0;
    }
    sum
}

pub(crate) fn sinc(x: f64) -> f64 {
    if x.abs() < 1e-12 {
        1.0
    } else {
        libm::sin(core::f64::consts::PI * x) / (core::f64::consts::PI * x)
    }
}
