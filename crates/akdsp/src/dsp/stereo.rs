//! Mid/side width and low-end mono (detailed design 8.5).
use super::biquad::Biquad;
use crate::Stereo;

/// `width` scales the side signal (1 = unchanged); side content below `mono_below_hz` is removed
/// with a 4th-order Linkwitz-Riley high pass (0 = off).
pub fn apply_stereo(x: &Stereo, sr: u32, width: f32, mono_below_hz: f32) -> Stereo {
    if width == 1.0 && mono_below_hz <= 0.0 {
        return x.clone();
    }
    let mut side: Vec<f32> = x.l.iter().zip(&x.r).map(|(l, r)| 0.5 * (l - r)).collect();
    if mono_below_hz > 0.0 {
        let q = core::f64::consts::FRAC_1_SQRT_2;
        Biquad::high_pass(f64::from(sr), f64::from(mono_below_hz), q).process(&mut side);
        Biquad::high_pass(f64::from(sr), f64::from(mono_below_hz), q).process(&mut side);
    }
    let mut y = Stereo::zeros(x.len());
    for i in 0..x.len() {
        let m = 0.5 * (x.l[i] + x.r[i]);
        let s = side[i] * width;
        y.l[i] = m + s;
        y.r[i] = m - s;
    }
    y
}
