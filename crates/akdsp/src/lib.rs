//! akdsp: DSP engine for akanaku-mastering-tool.
//!
//! This crate has no browser dependencies. It is built natively (tests, CLI,
//! golden tests) and for wasm32 via `akdsp-wasm`. Math functions go through
//! `libm` so native and WASM builds produce the same results (detailed design 5.5).

pub mod level;

/// Engine version. Part of every cache key (detailed design 4.4).
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");
