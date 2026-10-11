#!/usr/bin/env bash
# Development server with hot reload. Rebuild WASM with `npm run build:wasm:dev` after Rust changes.
set -euo pipefail
cd "$(dirname "$0")/.."
scripts/build-wasm.sh --dev
[ -d node_modules ] || npm install
npm run dev -w apps/web
