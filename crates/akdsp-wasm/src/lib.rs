//! Browser-facing bindings for the akdsp engine (detailed design 5.4).

use wasm_bindgen::prelude::*;

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
