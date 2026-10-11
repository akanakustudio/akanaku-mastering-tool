# 04. P0（技術検証）レポート

- 文書種別：検証レポート（P0 の進行に合わせて追記する）
- 対象：[03_detailed_design.md](03_detailed_design.md) 22章の検証項目
- 開始日：2026-10-11

## 検証環境

| 項目 | 内容 |
|---|---|
| Mac | Apple M5 / メモリ 32 GB |
| ブラウザ | Chrome 151、Safari（WebKit 605.1.15） |
| ツール | Node.js 22.23、Rust 1.99.0、wasm-bindgen 0.2.129、wasm-opt 133 |

> 性能目標は M1 を基準にしている（詳細設計 5.6）。M5 での計測値は M1 相当に換算して判定する（換算方法は P0-1 で決める）。

## 進捗

| # | 項目 | 状態 | 結果 |
|---|---|---|---|
| P0-1 | Rust→WASM の処理速度 | 未着手 | |
| P0-2 | AudioWorklet での A/B 同期再生 | 未着手 | |
| P0-3 | 波形描画の性能 | 未着手 | |
| P0-4 | Shimmer Reduction の試作と試聴 | 未着手 | |
| P0-5 | OPFS の読み書き | 一部確認 | Worker での同期アクセスハンドル（1 MB）は両ブラウザで動作。速度は未計測 |
| P0-6 | 区間レンダリングの体感 | 未着手 | |
| P0-7 | ローカル実行環境 | **合格**（2026-10-11） | 下記 |
| P0-8 | Suno 書き出し形式の確認 | 未着手 | テスト用楽曲の提供待ち |
| P0-9 | Safari のメモリ | 未着手 | |
| P0-10 | エンコーダー | 未着手 | |
| P0-11 | WebGL2 `R16F`（Safari） | 未着手 | |

## P0-7 ローカル実行環境：合格

`npm start` で起動した `http://localhost:5173` を開き、起動時チェック（詳細設計 16.0）と Worker 内の自己テストを実行した。

| チェック | Chrome 151 | Safari |
|---|---|---|
| クロスオリジン分離（`crossOriginIsolated`） | ✓ | ✓ |
| WebAssembly SIMD | ✓ | ✓ |
| AudioWorklet | ✓ | ✓ |
| OPFS（API の有無） | ✓ | ✓ |
| ストレージ | ✓ 上限 10.0 GB | ✓ 上限 76.8 GB |
| 起動 URL | ✓ | ✓ |
| WASM を Worker で読み込み（SIMD 有効ビルド） | ✓ | ✓ |
| DSP の計算結果（1 kHz 正弦波 RMS −3.01 dBFS / ピーク 0.00 dBFS） | ✓ | ✓ |
| OPFS の同期アクセスハンドルで 1 MB 書き込み・読み込み（Worker） | ✓ | ✓ |

サーバー側の確認（curl）：

- すべての応答に COOP `same-origin` / COEP `require-corp` / CORP `same-origin` / CSP（`connect-src 'self'`）が付く
- `.wasm` は `Content-Type: application/wasm`
- `localhost` だけで待ち受け、`127.0.0.1:5173` には接続できない（外部からも開けない）

### 気づいた点

- Chrome のストレージ上限が 10.0 GB と小さめに報告された（Safari は 76.8 GB）。シークレットウィンドウなどの影響でなければ、キャッシュの上限（詳細設計 4.4：`min(10 GB, 上限 × 0.5)`）は Chrome では 5 GB になる。通常のウィンドウで再確認する。
- 永続化（`storage.persist()`）は未要求のため「未許可」。プロジェクト保存の実装時に要求処理を入れて、両ブラウザの挙動を記録する（P0-5）。
