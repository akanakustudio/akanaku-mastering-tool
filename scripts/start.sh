#!/usr/bin/env bash
# Build everything and serve on http://localhost:5173 (detailed design 20.2).
set -euo pipefail
cd "$(dirname "$0")/.."

scripts/doctor.sh >/dev/null || { scripts/doctor.sh; exit 1; }

if lsof -nP -iTCP:5173 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "ポート 5173 はすでに使われています（アプリが起動済みかもしれません）。"
  echo "ブラウザで http://localhost:5173 を開くか、起動中のサーバーを止めてから再実行してください。"
  exit 1
fi

scripts/build-wasm.sh
[ -d node_modules ] || npm install
npm run build -w apps/web
echo "起動します: http://localhost:5173 （止めるときは Ctrl+C）"
npm run preview -w apps/web -- --open
