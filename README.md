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
| [04. P0 レポート](docs/04_p0_report.md) | 進行中 |

## 起動方法

初回だけ、必要なツールが揃っているか確認します（足りないものは入れ方が表示されます）。

```sh
npm run doctor
```

起動（ビルドしてから `http://localhost:5173` をブラウザで開きます）：

```sh
npm start
```

- 必ず `http://localhost:5173` で開いてください。ブラウザ内に保存されるデータは URL ごとに分かれるため、別のポートや `127.0.0.1` で開くと保存済みのプロジェクトが見えません。
- 対応ブラウザ：PC 版の Chrome / Edge / Safari の最新版

開発用（ホットリロード）：`npm run dev` ／ テスト：`npm test`
