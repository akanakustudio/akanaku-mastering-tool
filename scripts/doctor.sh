#!/usr/bin/env bash
# Check the local toolchain (detailed design 20.2). Exit 1 if something is missing.
set -uo pipefail
cd "$(dirname "$0")/.."
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

ok=1
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n    → %s\n' "$1" "$2"; ok=0; }

echo "akanaku-mastering-tool: 環境チェック"

if command -v node >/dev/null; then
  major=$(node -p 'process.versions.node.split(".")[0]')
  if [ "$major" -ge 20 ]; then pass "Node.js $(node --version)"; else fail "Node.js $(node --version) は古い" "Node.js 20 以上（LTS）を入れてください"; fi
else
  fail "Node.js がない" "brew install node"
fi

if command -v cargo >/dev/null; then pass "$(cargo --version)"; else fail "Rust（cargo）がない" "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"; fi

if command -v rustup >/dev/null && rustup target list --installed | grep -q '^wasm32-unknown-unknown$'; then
  pass "wasm32-unknown-unknown ターゲット"
else
  fail "wasm32 ターゲットがない" "rustup target add wasm32-unknown-unknown"
fi

want=$(sed -n 's/^wasm-bindgen = "=\(.*\)"/\1/p' crates/akdsp-wasm/Cargo.toml)
if command -v wasm-bindgen >/dev/null; then
  have=$(wasm-bindgen --version | awk '{print $2}')
  if [ "$have" = "$want" ]; then pass "wasm-bindgen $have"; else fail "wasm-bindgen $have（必要なのは $want）" "cargo install wasm-bindgen-cli --version $want --force"; fi
else
  fail "wasm-bindgen がない" "cargo install wasm-bindgen-cli --version $want"
fi

if command -v wasm-opt >/dev/null; then pass "$(wasm-opt --version)"; else fail "wasm-opt（binaryen）がない" "brew install binaryen"; fi

if [ "$ok" = 1 ]; then echo "すべて揃っています。"; else echo "足りないものがあります（上の → の手順で入れてください）。"; exit 1; fi
