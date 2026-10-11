//! Browser-facing bindings for the akdsp engine (detailed design 5.4).
//! One `Engine` holds one track: the decoded source and the latest render.

use akdsp::analysis::{Analysis, analyze};
use akdsp::display;
use akdsp::dsp::resample::resample;
use akdsp::io::{decode::decode, encode::encode_wav};
use akdsp::master::{ChainCache, MasterSettings, RenderReport, render};
use akdsp::{INTERNAL_SAMPLE_RATE, Stereo};
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn engine_version() -> String {
    akdsp::ENGINE_VERSION.to_string()
}

/// True when this module was compiled with WASM SIMD128 enabled.
#[wasm_bindgen]
pub fn simd_enabled() -> bool {
    cfg!(target_feature = "simd128")
}

#[wasm_bindgen]
pub fn rms_dbfs(x: &[f32]) -> f32 {
    akdsp::level::rms_dbfs(x)
}

#[wasm_bindgen]
pub fn peak_dbfs(x: &[f32]) -> f32 {
    akdsp::level::peak_dbfs(x)
}

fn to_js<T: Serialize>(v: &T) -> Result<JsValue, JsError> {
    serde_wasm_bindgen::to_value(v).map_err(|e| JsError::new(&e.to_string()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadInfo<'a> {
    sample_rate_in: u32,
    channels_in: usize,
    frames: usize,
    sample_rate: u32,
    before: &'a Analysis,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RenderInfo<'a> {
    after: &'a Analysis,
    report: &'a RenderReport,
    settings: MasterSettings,
}

#[wasm_bindgen]
pub struct Engine {
    source: Stereo,
    before: Option<Analysis>,
    cache: ChainCache,
    after: Option<(Stereo, Analysis, MasterSettings)>,
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Engine {
        Engine {
            source: Stereo::default(),
            before: None,
            cache: ChainCache::default(),
            after: None,
        }
    }

    /// Decodes a file (bytes + extension hint), converts it to 48 kHz and analyses it.
    pub fn load(&mut self, bytes: Vec<u8>, extension: Option<String>) -> Result<JsValue, JsError> {
        let d = decode(bytes, extension.as_deref()).map_err(|e| JsError::new(&e.to_string()))?;
        let source = if d.sample_rate == INTERNAL_SAMPLE_RATE {
            d.audio
        } else {
            Stereo::new(
                resample(&d.audio.l, d.sample_rate, INTERNAL_SAMPLE_RATE),
                resample(&d.audio.r, d.sample_rate, INTERNAL_SAMPLE_RATE),
            )
        };
        let before = analyze(&source, INTERNAL_SAMPLE_RATE);
        self.source = source;
        self.cache = ChainCache::default();
        self.after = None;
        let info = LoadInfo {
            sample_rate_in: d.sample_rate,
            channels_in: d.channels,
            frames: self.source.len(),
            sample_rate: INTERNAL_SAMPLE_RATE,
            before: &before,
        };
        let js = to_js(&info);
        self.before = Some(before);
        js
    }

    /// Runs the mastering chain. `on_progress(stage, fraction)` is called along the way.
    pub fn render(
        &mut self,
        settings: JsValue,
        on_progress: &js_sys::Function,
    ) -> Result<JsValue, JsError> {
        if self.source.is_empty() {
            return Err(JsError::new("音源が読み込まれていません"));
        }
        let s: MasterSettings =
            serde_wasm_bindgen::from_value(settings).map_err(|e| JsError::new(&e.to_string()))?;
        let mut progress = |stage: &str, f: f32| {
            let _ = on_progress.call2(
                &JsValue::NULL,
                &JsValue::from_str(stage),
                &JsValue::from_f64(f64::from(f)),
            );
        };
        let r = render(
            &self.source,
            INTERNAL_SAMPLE_RATE,
            &s,
            &mut self.cache,
            &mut progress,
        );
        let after = analyze(&r.audio, INTERNAL_SAMPLE_RATE);
        let js = to_js(&RenderInfo {
            after: &after,
            report: &r.report,
            settings: s,
        });
        self.after = Some((r.audio, after, s));
        js
    }

    fn pick(&self, which: &str) -> Result<&Stereo, JsError> {
        match which {
            "before" => Ok(&self.source),
            "after" => self
                .after
                .as_ref()
                .map(|a| &a.0)
                .ok_or_else(|| JsError::new("まだマスタリングしていません")),
            _ => Err(JsError::new("which must be before or after")),
        }
    }

    /// One channel (0 = L, 1 = R) of "before" or "after", for the player.
    pub fn channel(&self, which: &str, ch: u32) -> Result<Vec<f32>, JsError> {
        let x = self.pick(which)?;
        Ok(if ch == 0 { x.l.clone() } else { x.r.clone() })
    }

    /// Peak pyramid level (`[min, max, rms]` per bin) of "before", "after" or "diff".
    pub fn peaks(&self, which: &str, bin: u32) -> Result<Vec<f32>, JsError> {
        let bin = bin as usize;
        if which == "diff" {
            let (after, a, _) = self
                .after
                .as_ref()
                .ok_or_else(|| JsError::new("まだマスタリングしていません"))?;
            let gain = self.loudness_match_gain(a);
            return Ok(display::diff_peaks(&self.source, after, gain, bin));
        }
        Ok(display::peaks(self.pick(which)?, bin))
    }

    /// Level change after vs. before at 100 Hz, loudness-matched (0 dB = average change).
    pub fn gain_delta(&self) -> Result<Vec<f32>, JsError> {
        let (after, a, _) = self
            .after
            .as_ref()
            .ok_or_else(|| JsError::new("まだマスタリングしていません"))?;
        let offset = (a.lufs - self.before.as_ref().map_or(a.lufs, |b| b.lufs)) as f32;
        Ok(display::gain_delta(
            &self.source,
            after,
            INTERNAL_SAMPLE_RATE,
            offset,
        ))
    }

    /// Encodes the latest render as WAV.
    pub fn export_wav(&self, sample_rate: u32, bits: u16) -> Result<Vec<u8>, JsError> {
        let (after, _, s) = self
            .after
            .as_ref()
            .ok_or_else(|| JsError::new("まだマスタリングしていません"))?;
        let enc = encode_wav(
            after,
            INTERNAL_SAMPLE_RATE,
            sample_rate,
            bits,
            s.ceiling_dbtp,
        )
        .map_err(|e| JsError::new(&e.to_string()))?;
        Ok(enc.bytes)
    }

    fn loudness_match_gain(&self, after: &Analysis) -> f32 {
        let before = self.before.as_ref().map_or(after.lufs, |b| b.lufs);
        libm_pow10((after.lufs - before) / 20.0) as f32
    }
}

fn libm_pow10(x: f64) -> f64 {
    10f64.powf(x)
}
