//! Decoding with symphonia (detailed design 8.1). The browser's decodeAudioData is not used
//! because each browser resamples differently.

use std::io::Cursor;

use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

use crate::{DspError, Stereo};

pub struct Decoded {
    pub audio: Stereo,
    pub sample_rate: u32,
    pub channels: usize,
}

/// Decodes WAV / AIFF / FLAC / MP3 / AAC (M4A) / ALAC. Mono is duplicated to stereo.
pub fn decode(bytes: Vec<u8>, extension: Option<&str>) -> Result<Decoded, DspError> {
    let mss = MediaSourceStream::new(Box::new(Cursor::new(bytes)), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = extension {
        hint.with_extension(ext);
    }
    let mut format = symphonia::default::get_probe()
        .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
        .map_err(|e| DspError::Unsupported(format!("この形式には対応していません（{e}）")))?;

    let (track_id, mut decoder) = {
        let track = format.default_track(TrackType::Audio).ok_or_else(|| DspError::Unsupported("音声トラックがありません".into()))?;
        let params = track
            .codec_params
            .as_ref()
            .and_then(|p| p.audio())
            .ok_or_else(|| DspError::Unsupported("音声の形式を判別できません".into()))?;
        let decoder = symphonia::default::get_codecs()
            .make_audio_decoder(params, &AudioDecoderOptions::default())
            .map_err(|e| DspError::Unsupported(format!("このコーデックには対応していません（{e}）")))?;
        (track.id, decoder)
    };

    let mut planes: Vec<Vec<f32>> = Vec::new();
    let mut sample_rate = 0;
    let mut scratch: Vec<Vec<f32>> = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(Some(p)) => p,
            Ok(None) => break,
            Err(Error::ResetRequired) => break,
            Err(e) => {
                return Err(DspError::Decode(format!("読み込み中にエラーが起きました（{e}）")));
            }
        };
        if packet.track_id != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(buf) => {
                let spec = buf.spec();
                sample_rate = spec.rate();
                let nch = spec.channels().count();
                if planes.is_empty() {
                    planes = vec![Vec::new(); nch];
                }
                if nch != planes.len() {
                    return Err(DspError::Unsupported("途中でチャンネル数が変わるファイルには対応していません".into()));
                }
                let frames = buf.frames();
                scratch.resize(nch, Vec::new());
                for s in scratch.iter_mut() {
                    s.resize(frames, 0.0);
                }
                buf.copy_to_slice_planar::<f32, _>(&mut scratch);
                for (p, s) in planes.iter_mut().zip(&scratch) {
                    p.extend_from_slice(&s[..frames]);
                }
            }
            Err(Error::DecodeError(_)) | Err(Error::IoError(_)) => continue,
            Err(e) => return Err(DspError::Decode(format!("デコードできませんでした（{e}）"))),
        }
    }

    let channels = planes.len();
    let audio = match channels {
        0 => return Err(DspError::Decode("音声データがありません".into())),
        1 => Stereo::new(planes[0].clone(), planes.remove(0)),
        2 => {
            let r = planes.pop().unwrap();
            Stereo::new(planes.pop().unwrap(), r)
        }
        n => {
            return Err(DspError::Unsupported(format!(
                "{n} チャンネルの音源には対応していません。ステレオかモノラルを使ってください（E-IN-004）"
            )));
        }
    };
    if audio.is_empty() {
        return Err(DspError::Decode("音声データがありません".into()));
    }
    Ok(Decoded { audio, sample_rate, channels })
}
