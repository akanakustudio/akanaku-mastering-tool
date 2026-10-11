# akanaku-mastering-tool

Suno で生成した楽曲（シングル／アルバム）向けのマスタリングツール。
Suno 特有のアーティファクト（シマー、ヒス、こもり等）を除去し、配信に最適な音圧・音質に仕上げる。
音声処理はすべてブラウザ内（Rust→WebAssembly）で行う Web アプリ。当面は各自の Mac でローカル実行する（`http://localhost:5173`）。

## ドキュメント

| 文書 | 状態 |
|---|---|
| [01. リサーチ資料](docs/01_research.md) | 作成済み |
| [02. 基本設計書](docs/02_basic_design.md) | v2.1 承認済み |
| [03. 詳細設計書](docs/03_detailed_design.md) | v1.0 承認済み |
