#!/usr/bin/env bash
# Build crates/akdsp-wasm for the browser (detailed design 20.1).
#   scripts/build-wasm.sh          release build + wasm-opt
#   scripts/build-wasm.sh --dev    debug build (faster, no wasm-opt)
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

OUT_DIR=apps/web/src/wasm/pkg
if [ "${1:-}" = "--dev" ]; then
  PROFILE_FLAG=""; PROFILE_DIR=debug
else
  PROFILE_FLAG="--release"; PROFILE_DIR=release
fi

RUSTFLAGS="-C target-feature=+simd128" \
  cargo build -p akdsp-wasm --target wasm32-unknown-unknown $PROFILE_FLAG

wasm-bindgen "target/wasm32-unknown-unknown/$PROFILE_DIR/akdsp_wasm.wasm" \
  --target web --out-dir "$OUT_DIR"

if [ "$PROFILE_DIR" = release ]; then
  wasm-opt -O3 \
    --enable-simd --enable-bulk-memory --enable-sign-ext --enable-mutable-globals \
    --enable-nontrapping-float-to-int --enable-reference-types --enable-multivalue \
    "$OUT_DIR/akdsp_wasm_bg.wasm" -o "$OUT_DIR/akdsp_wasm_bg.wasm"
fi

echo "wasm: $OUT_DIR/akdsp_wasm_bg.wasm ($(wc -c < "$OUT_DIR/akdsp_wasm_bg.wasm" | tr -d ' ') bytes)"
