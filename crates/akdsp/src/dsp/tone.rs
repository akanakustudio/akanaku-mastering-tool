//! Tone macro: Warm (−) ⇔ Bright (+) tilt with two shelves (simplified detailed design 8.2).
use super::biquad::Biquad;
use crate::Stereo;

/// `tone` in −1..=1: high shelf at 6 kHz ±2 dB, low shelf at 200 Hz ∓1 dB.
pub fn apply_tone(x: &Stereo, sr: u32, tone: f32) -> Stereo {
    if tone == 0.0 {
        return x.clone();
    }
    let sr = f64::from(sr);
    let t = f64::from(tone.clamp(-1.0, 1.0));
    let mut y = x.clone();
    for ch in y.channels_mut() {
        Biquad::high_shelf(sr, 6000.0, 2.0 * t, 0.707).process(ch);
        Biquad::low_shelf(sr, 200.0, -t, 0.707).process(ch);
    }
    y
}
