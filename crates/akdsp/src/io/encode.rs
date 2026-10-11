//! WAV export with sample-rate conversion, ceiling check and TPDF dither (detailed design 8.7).
use std::io::Cursor;

use crate::analysis::truepeak;
use crate::dsp::resample::resample;
use crate::{DspError, Stereo};

pub struct Encoded {
    pub bytes: Vec<u8>,
    pub true_peak_dbtp: f64,
}

/// Small deterministic PRNG so the dither (and therefore the file) is reproducible (5.5).
struct XorShift(u64);
impl XorShift {
    fn next_f32(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 40) as f32 / (1u64 << 24) as f32
    }
}

pub fn encode_wav(x: &Stereo, sr_in: u32, sr_out: u32, bits: u16, ceiling_dbtp: f32) -> Result<Encoded, DspError> {
    if bits != 16 && bits != 24 {
        return Err(DspError::Encode(format!("{bits} bit には対応していません")));
    }
    let mut y = Stereo::new(resample(&x.l, sr_in, sr_out), resample(&x.r, sr_in, sr_out));
    // SRC can raise inter-sample peaks slightly; re-check the ceiling at the output rate.
    let mut tp = truepeak::true_peak_dbtp(&y);
    if tp > f64::from(ceiling_dbtp) {
        let trim = ceiling_dbtp - tp as f32 - 0.02;
        y.scale(libm::powf(10.0, trim / 20.0));
        tp = truepeak::true_peak_dbtp(&y);
    }

    let spec = hound::WavSpec { channels: 2, sample_rate: sr_out, bits_per_sample: bits, sample_format: hound::SampleFormat::Int };
    let full = ((1i64 << (bits - 1)) - 1) as f32;
    let mut rng = XorShift(0x9E37_79B9_7F4A_7C15 ^ (y.len() as u64));
    let mut cursor = Cursor::new(Vec::with_capacity(y.len() * 2 * usize::from(bits / 8) + 64));
    {
        let mut w = hound::WavWriter::new(&mut cursor, spec).map_err(|e| DspError::Encode(e.to_string()))?;
        for i in 0..y.len() {
            for s in [y.l[i], y.r[i]] {
                // TPDF dither of ±1 LSB.
                let d = rng.next_f32() - rng.next_f32();
                let v = (s * full + d).round().clamp(-full - 1.0, full) as i32;
                w.write_sample(v).map_err(|e| DspError::Encode(e.to_string()))?;
            }
        }
        w.finalize().map_err(|e| DspError::Encode(e.to_string()))?;
    }
    Ok(Encoded { bytes: cursor.into_inner(), true_peak_dbtp: tp })
}
