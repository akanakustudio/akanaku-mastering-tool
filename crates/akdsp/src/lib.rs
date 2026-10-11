//! akdsp: DSP engine for akanaku-mastering-tool.
//!
//! This crate has no browser dependencies. It is built natively (tests, CLI,
//! golden tests) and for wasm32 via `akdsp-wasm`. Math functions go through
//! `libm` so native and WASM builds produce the same results (detailed design 5.5).

pub mod album;
pub mod analysis;
pub mod buffer;
pub mod display;
pub mod dsp;
pub mod error;
pub mod io;
pub mod level;
pub mod master;

pub use buffer::Stereo;
pub use error::DspError;

/// Engine version. Part of every cache key (detailed design 4.4).
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Internal processing sample rate (detailed design 4.1).
pub const INTERNAL_SAMPLE_RATE: u32 = 48_000;
