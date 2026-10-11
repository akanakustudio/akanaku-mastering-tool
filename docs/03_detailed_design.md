# 03. 詳細設計書：akanaku-mastering-tool

- 文書種別：詳細設計書
- 版：1.1（2026-10-11。v1.0 承認後、P0 の結果を反映）
- 作成日：2026-10-11
- 上位文書：[02_basic_design.md](02_basic_design.md)（v2.1 承認済み）

### 改版履歴

| 版 | 日付 | 内容 |
|---|---|---|
| 0.1 | 2026-10-11 | 初版（macOS デスクトップアプリ：Tauri ＋ Python エンジン） |
| 0.2 | 2026-10-11 | **Web アプリ（ブラウザ内処理）に全面改訂**。DSP を Rust→WASM、再生を AudioWorklet、保存を OPFS/IndexedDB、配信を Cloudflare Pages に変更。信号処理のアルゴリズム（6〜11章）は v0.1 を引き継ぎ、実装手段だけを置き換えた |
| 0.3 | 2026-10-11 | **当面はローカル実行のみ**（D8 の変更）。20章を「ビルド・ローカル実行」に改訂し、Cloudflare での公開は 20.5「将来の公開」に移した。起動 URL の固定（16.0, W-BR-002）、P0-7、U5 を改訂 |
| 1.0 | 2026-10-11 | v0.3 の内容で承認 |
| 1.1 | 2026-10-11 | P0-2 の結果を反映：モード切り替えと区間の差し替えのクロスフェードを**イコールゲイン**に変更（4.5, 12.4, 12.5）。同じ曲どうしのように相関の高い信号をイコールパワーでつなぐと、途中で最大 +3 dB 膨らむため。ループのつなぎ目・アルバムの曲間は相関が低いのでイコールパワーのまま |

### 前提とする確定事項（基本設計 0章）

| # | 内容 |
|---|---|
| D1 | Web アプリ。音声処理はすべてブラウザ内で行う |
| D2 | 自分・チームでの利用。DSP は Rust で自前実装する。ブラウザに配るライブラリは MIT/Apache/BSD を優先し、LGPL・MPL も許容する |
| D3 | React/TypeScript ＋ Rust→WebAssembly（Web Worker）＋ Web Audio API（AudioWorklet） |
| D4 | ML は P4 の任意機能（ONNX Runtime Web ＋ WebGPU が第一候補） |
| D5 | 差分レンダリング方式のプレビュー |
| D6 | 既定のラウドネス目標は Streaming（-14 LUFS / -1.0 dBTP） |
| D7 | UI は日本語・英語に対応（初期表示は日本語） |
| D8 | 当面はローカル実行のみ（`http://localhost:5173`）。将来公開する場合は Cloudflare（Workers の静的アセット配信 ＋ Access） |
| D9 | PC 版の Chrome / Edge / Safari の最新版 |

> 本書の数値のうち **「(要較正)」** と付けたものは、P0（技術検証）でゴールデンセットを試聴して確定する初期値です。`crates/akdsp/presets/calibration.json` に置き、ビルド時に埋め込みます（開発中は URL パラメーター `?calibration=` で差し替えられるようにする）。

---

## 目次

1. リポジトリ構成
2. 技術スタック詳細
3. 実行構成とスレッド間通信
4. オーディオデータ・ストレージ・キャッシュ設計
5. DSP エンジン（Rust）：共通設計
6. DSP エンジン：解析（Analyzer）
7. DSP エンジン：Suno クリーンアップ
8. DSP エンジン：マスタリングチェーン
9. DSP エンジン：Auto Master
10. DSP エンジン：アルバムバランサー
11. DSP エンジン：表示用データ生成
12. 再生エンジン（AudioWorklet）
13. Orchestrator：プロジェクト・ジョブ管理
14. UI：アーキテクチャ
15. UI：波形ビュー
16. UI：画面別詳細
17. データスキーマ
18. API・メッセージ仕様
19. エラー処理・ログ・復旧
20. ビルド・ローカル実行
21. テスト設計
22. P0（技術検証）項目と合格基準
23. 要件トレーサビリティ
24. 未決事項

---

## 1. リポジトリ構成

```
akanaku-mastering-tool/
├── apps/
│   └── web/                          # Web アプリ（Vite + React + TypeScript）
│       ├── public/
│       │   └── fonts/                # フォントは同梱する（COEP のため外部 CDN を使わない）
│       ├── security-headers.ts       # COOP/COEP/CSP の定義（vite.config.ts から読み込む。20.2）
│       ├── src/
│       │   ├── app/                  # ルーティング、レイアウト、起動時チェック（16.0）
│       │   ├── screens/              # S-01〜S-06
│       │   ├── components/           # 共通 UI 部品（Knob, Meter, Button…）
│       │   ├── features/
│       │   │   ├── waveform/         # 波形ビュー（15章）
│       │   │   ├── transport/
│       │   │   ├── meters/
│       │   │   ├── macros/
│       │   │   ├── modules/          # 詳細モジュールパネル
│       │   │   └── album/
│       │   ├── orchestrator/         # ジョブ管理、Worker プール、プロジェクト保存（13章）
│       │   ├── audio/                # AudioContext、Worklet の制御、共有メモリのレイアウト（12章）
│       │   │   └── player.worklet.ts # AudioWorkletProcessor
│       │   ├── workers/
│       │   │   ├── dsp.worker.ts     # WASM を読み込んで処理する Worker（18.3）
│       │   │   └── io.worker.ts      # OPFS の読み書き、ストリーミング供給、ZIP
│       │   ├── storage/              # opfs.ts, idb.ts, projectFile.ts（ZIP の読み書き）
│       │   ├── encoders/             # mp3（LAME の WASM）, aac（WebCodecs）
│       │   ├── stores/               # Zustand
│       │   ├── i18n/                 # ja.json, en.json
│       │   └── styles/               # デザイントークン
│       ├── tests/                    # Vitest
│       ├── e2e/                      # Playwright（Chromium / WebKit）
│       ├── package.json
│       └── vite.config.ts
├── crates/
│   ├── akdsp/                        # DSP の本体（ブラウザ依存のない純粋な Rust）
│   │   ├── src/
│   │   │   ├── lib.rs
│   │   │   ├── buffer.rs             # StereoBuffer（プレーナー f32）
│   │   │   ├── params.rs             # 設定の型（serde）
│   │   │   ├── io/                   # decode.rs, wav.rs, aiff.rs, flac.rs, akpcm.rs, tags.rs
│   │   │   ├── analysis/             # loudness.rs, truepeak.rs, spectrum.rs, stereo.rs,
│   │   │   │                         # sections.rs, artifacts.rs, mod.rs
│   │   │   ├── dsp/
│   │   │   │   ├── conditioning.rs
│   │   │   │   ├── cleanup/          # stft.rs, declick.rs, dehiss.rs, shimmer.rs,
│   │   │   │   │                     # resonance.rs, mud.rs, mod.rs
│   │   │   │   ├── eq.rs             # FIR の設計と畳み込み
│   │   │   │   ├── dynamics.rs
│   │   │   │   ├── saturation.rs
│   │   │   │   ├── stereo.rs
│   │   │   │   ├── limiter.rs
│   │   │   │   ├── output.rs         # SRC、ディザ
│   │   │   │   └── util/             # biquad.rs, crossover.rs, oversample.rs, envelope.rs, median.rs, fft.rs
│   │   │   ├── chain.rs              # ステージの実行、キャッシュキー、区間レンダリング
│   │   │   ├── automaster.rs
│   │   │   ├── album.rs
│   │   │   └── display.rs
│   │   ├── presets/                  # genres/*.json, characters.json, calibration.json
│   │   └── tests/
│   ├── akdsp-wasm/                   # wasm-bindgen によるブラウザ向けのバインディング
│   └── akdsp-cli/                    # ネイティブの CLI（ゴールデンテスト、較正、デバッグ用）
├── research/                         # P0 のアルゴリズム試作・較正用の Python（製品には含めない）
├── tests/
│   └── golden/                       # ゴールデンテストの定義（音源本体はリポジトリ外）
├── scripts/
│   └── start.sh                      # ビルドして起動し、ブラウザを開く（20.2）
├── .github/workflows/                # CI（20.4）
├── docs/
└── README.md
```

---

## 2. 技術スタック詳細

バージョンは P0 の開始時点の最新安定版で固定する（`Cargo.lock` / `package-lock.json`）。

| 層 | 用途 | 採用 | ライセンス |
|---|---|---|---|
| UI | フレームワーク | React, TypeScript, Vite | MIT |
| UI | 状態管理 | Zustand ＋ immer（Undo 用のパッチ） | MIT |
| UI | i18n | i18next / react-i18next | MIT |
| UI | 描画 | Canvas2D（波形）、WebGL2（ヒートマップ） | — |
| UI | IndexedDB | idb | ISC |
| UI | ZIP | fflate | MIT |
| UI | AAC の入れ物（m4a） | mp4-muxer | MIT |
| UI | テスト | Vitest, Testing Library, Playwright | MIT / Apache-2.0 |
| DSP | WASM 化 | wasm-bindgen, wasm-opt（binaryen） | MIT/Apache-2.0 |
| DSP | FFT | rustfft, realfft（WASM SIMD 対応） | MIT/Apache-2.0 |
| DSP | デコード | symphonia（WAV/AIFF/FLAC/MP3/AAC/ALAC） | MPL-2.0 |
| DSP | SRC | rubato | MIT |
| DSP | WAV 書き出し | hound | Apache-2.0 |
| DSP | FLAC 書き出し | flacenc | Apache-2.0 |
| DSP | ID3 タグ | id3 | MIT |
| DSP | 小さな線形代数（LSAR） | nalgebra | Apache-2.0 |
| DSP | 数学関数 | libm（ネイティブと WASM で結果をそろえるため） | MIT/Apache-2.0 |
| DSP | シリアライズ | serde, serde_json, serde-wasm-bindgen | MIT/Apache-2.0 |
| DSP | テスト | proptest | MIT/Apache-2.0 |
| エンコード | MP3 | LAME の WASM ビルド（ライブラリは P0 で選定） | LGPL-2.0 |
| エンコード | AAC | WebCodecs `AudioEncoder`（対応ブラウザのみ） | （ブラウザ標準） |
| 試作 | P0 のアルゴリズム試作・較正 | Python 3.12, numpy, scipy, soundfile, pyloudnorm, Jupyter | BSD/MIT |
| P4 | ML | ONNX Runtime Web（WebGPU）、Mel-Band RoFormer 系の学習済み重み（ONNX 化） | MIT / 重みごとに確認 |

---

## 3. 実行構成とスレッド間通信

### 3.1 スレッド構成

```
[メインスレッド]
  ├─ React UI（画面、波形・メーター描画）
  └─ Orchestrator（ジョブキュー、Worker プール、IndexedDB への保存、再生の制御）

[DSP Worker] × N            … Rust→WASM。1つの Worker が 1 つのジョブ（1曲ぶん）を処理する
  N = clamp(floor(navigator.hardwareConcurrency / 2), 1, 4)。Safari は最大 2（メモリ対策）
  Worker #0 は「表示中の曲」専用（対話的なジョブを待たせないため）。残りはバックグラウンド用

[I/O Worker] × 1           … OPFS の読み書き（音源のコピー、キャッシュ、ZIP 作成）、共有メモリへの読み込み、ストリーミング再生の供給

[AudioWorklet スレッド]     … 再生（モード切り替え、ループ、ゲイン）とリアルタイムメーター
```

- OPFS への書き込みは Safari では Worker 内の `createSyncAccessHandle()` でしかできないため、**すべての OPFS 操作を Worker 側で行う**。DSP Worker もキャッシュの読み書きのために OPFS の同期アクセスハンドルを使う（同じファイルを同時に開かないよう、Orchestrator がファイル単位で排他を管理する）。

### 3.2 通信方式

| 経路 | 方式 | データ |
|---|---|---|
| メイン ⇔ DSP / I/O Worker | `postMessage`（18.3 のプロトコル） | 制御は構造化クローン。中くらいのデータ（波形ピーク、解析結果）は ArrayBuffer を**転送**（コピーしない）。大きな音声データは OPFS を経由する |
| Worker → AudioWorklet | **SharedArrayBuffer** | 再生用の PCM（Before / After / Ref）と制御ブロック（12.2） |
| メイン ⇔ AudioWorklet | SharedArrayBuffer（制御・位置・メーター）＋ `port.postMessage`（初期化だけ） | 30 Hz の位置・メーターは、メインスレッドが rAF で共有メモリを直接読む |
| キャンセル | SharedArrayBuffer の Int32 フラグ（ジョブごと） | WASM はチェックポイントで、JS から渡された関数を通してフラグを確認する |

### 3.3 クロスオリジン分離（必須）

- SharedArrayBuffer を使うため、ローカルサーバー（Vite）がすべての応答に `Cross-Origin-Opener-Policy: same-origin` と `Cross-Origin-Embedder-Policy: require-corp` を付ける（20.2）。`localhost` はブラウザから安全な環境（secure context）として扱われるので、HTTPS は不要。
- 起動時に `self.crossOriginIsolated === true` を確認し、false のときはエラー画面（E-BR-001）を出す。
- 影響：外部ドメインの画像・フォント・スクリプトは読み込めない。フォントやアイコンはすべてアプリに同梱する。

---

## 4. オーディオデータ・ストレージ・キャッシュ設計

### 4.1 内部フォーマット

| 項目 | 値 |
|---|---|
| サンプルレート | 48,000 Hz（`project.internalSampleRate`） |
| チャンネル | 2（モノラル入力は複製してステレオにする） |
| サンプル形式 | float32、リトルエンディアン |
| 並び | **プレーナー**（L のブロックの後に R のブロック） |
| 長さ | 全ステージの出力は**入力と同じサンプル数**（各ステージが自分の遅延を補償する） |

### 4.2 ストレージの配置

| 保存先 | パス・ストア | 内容 |
|---|---|---|
| OPFS | `/sources/<sha256>.<ext>` | 取り込んだ音源のコピー（元ファイルのまま）。同じ内容の音源は1つだけ保存する |
| OPFS | `/cache/<projectId>/<trackId>/<key>.akpcm` | ステージキャッシュ（4.4） |
| OPFS | `/cache/<projectId>/<trackId>/display/<key>/…` | 表示用データ（11章） |
| OPFS | `/tmp/` | 書き出し途中のファイル、ZIP（完了・中止したら削除） |
| IndexedDB | `akmaster` データベース（17.5） | プロジェクト、曲、設定、スナップショット、解析結果、アプリ設定、ログ |

- 起動時に `navigator.storage.persist()` を要求する。拒否されたら W-ST-002 を出し、プロジェクトファイルの書き出し（13.5）を案内する。
- `navigator.storage.estimate()` で使用量と上限を取得し、設定画面に表示する。

### 4.3 キャッシュファイル形式（`.akpcm`）

```
offset 0   : magic "AKPCM\0\0\1"（8 byte）
offset 8   : header_len u32
offset 12  : header JSON（UTF-8）
             { "sr":48000, "ch":2, "frames":N, "layout":"planar",
               "key":"<cache key>", "engine":"0.1.0", "createdAt":"..." }
offset 4096: L[0..N] f32, R[0..N] f32
```

- 書き込みは `/tmp/` に書いてから、移動（`FileSystemFileHandle.move()`。使えなければコピー＋削除）する。
- 読み込みは `SyncAccessHandle.read()` で WASM のメモリ上の領域、または再生用の SharedArrayBuffer に直接読み込む（JS のヒープを経由しない）。

### 4.4 ステージキャッシュ

全ステージの出力を保存するとストレージを圧迫するため、計算が重い段の境目だけをキャッシュする。

| キャッシュ点 | 内容 | 理由 |
|---|---|---|
| C0：conditioned | 入力整形の後（＝ Before の再生用） | 再生と差分の基準 |
| C1：cleaned | Suno クリーンアップの後 | 最も重い段（STFT 処理） |
| C2：prelimiter | ステレオ処理の後、リミッターの前 | リミッターだけを調整する場合が多い |
| C3：final | リミッターの後（＝ After の再生用） | 再生、書き出しの元 |

- **キャッシュキー**：`sha256(source_sha256 ‖ stage_id ‖ stage_version ‖ canonical_json(stage_params) ‖ …上流のステージ分を連結… ‖ engine_version)`。`canonical_json` はキーをソートし、浮動小数は小数点以下6桁に丸める。
- 容量の上限：`min(10 GB, 上限 × 0.5)`。超えたら LRU で削除する（開いているプロジェクトの C0/C3 は削除しない）。
- LRU の管理情報（キー、サイズ、最終使用日時）は IndexedDB の `cacheIndex` ストアに持つ。

### 4.5 区間（リージョン）レンダリング

差分レンダリング（D5）のため、DSP エンジンは**区間を指定したレンダリング**に対応する。

```
要求：render(range=[s, e])
 1. 状態を持つステージ（コンプ、リミッター、STFT 等）のため、プリロール p を足して [s - p, e + q] を処理する
    p = 各ステージの preroll の合計（既定：dynamics 1.0 s ＋ limiter 0.5 s ＋ STFT 2 フレーム）
    q = 後方の余白（STFT 2 フレーム ＋ スプライス用 10 ms）
 2. 出力から [s - 5ms, e + 5ms] を切り出し、Worker から Orchestrator に転送する
 3. Orchestrator が再生用の After バッファに 5 ms のイコールゲイン・クロスフェードでつなぎ込む（12.5）
```

- 区間と全体のレンダリング結果は、プリロールの効果でほぼ一致する（目標：差 -60 dBFS 以下）。ただし**書き出しは必ず全体レンダリングの結果を使う**（NFR-07 の再現性は全体レンダリングで保証する）。
- **リミッターの入力ゲイン**は曲全体のラウドネスで決まるため、区間プレビューでは次の推定値を使う。
  ```
  G_preview = G_last_full + (L_region_old_prelimiter − L_region_new_prelimiter)
  ```
  `L_region_*`：同じ区間の、リミッター前の Integrated LUFS（変更前と変更後）。全体レンダリングが終わったら確定値に置き換え、UI の「暫定」表示を消す。

### 4.6 メモリ予算（NFR-15）

| 用途 | 4分の曲での目安 |
|---|---|
| 再生用の SharedArrayBuffer（Before ＋ After ＋ Ref） | 約 280 MB（1ソース 92 MB） |
| DSP Worker #0 の WASM メモリ（1曲の処理中のピーク） | 約 600 MB |
| バックグラウンドの DSP Worker（1つあたり） | 約 600 MB（アルバムの処理中だけ。処理が終わったら Worker を終了してメモリを返す） |
| 表示用データ（UI 側のキャッシュ） | 64 MB まで |
| **合計（シングル編集中）** | **約 1.0 GB**（目標 1.5 GB 以下） |

- WASM は wasm32（最大 4GB）を前提にする（Safari の Memory64 対応が不確定なため）。
- アルバムの処理では、同時に動かすバックグラウンド Worker の数を `navigator.deviceMemory`（Chrome のみ）または固定値（Safari は 1）で制限する。

---

## 5. DSP エンジン（Rust）：共通設計

### 5.1 クレート構成

| クレート | 役割 | ビルド先 |
|---|---|---|
| `akdsp` | 解析・処理のすべて。ブラウザの API には依存しない | ネイティブ / wasm32 |
| `akdsp-wasm` | JS 向けの関数（wasm-bindgen）。メモリの受け渡し、キャンセルと進捗のコールバック | wasm32 |
| `akdsp-cli` | ネイティブの CLI。`akdsp-cli render --settings s.json in.wav out.wav` など。ゴールデンテストや較正に使う | ネイティブ |

### 5.2 ステージのインターフェース

```rust
pub trait Stage {
    fn id(&self) -> &'static str;          // "conditioning" | "cleanup" | "eq" | "dynamics" | "saturation" | "stereo" | "limiter"
    fn version(&self) -> u32;              // アルゴリズムを変えたら上げる（キャッシュが無効になる）
    fn latency(&self, p: &Params, sr: u32) -> usize;   // 補償する遅延（サンプル数）
    fn preroll(&self, p: &Params, sr: u32) -> usize;   // 区間レンダリングに必要な助走
    fn process(&mut self, x: &StereoBuffer, sr: u32, p: &Params, ctx: &mut StageContext)
        -> Result<StereoBuffer, DspError>; // 遅延は内部で補償済みであること
}
```

- `StageContext`：解析結果（処理前）、ラウドネス目標、アルバム由来の追加パラメーター、キャンセル確認関数、進捗コールバック。
- **バイパス**：`enabled == false` のときは入力をそのまま返す。全ステージをバイパスすると、出力が C0 とビット単位で一致すること（T-DSP-01）。

### 5.3 チェーン実行（`chain.rs`）

```
render(track, settings, range=None):
  1. 各キャッシュ点のキーを計算する
  2. 最も下流にある「有効なキャッシュ」を探し、そこから処理を始める（キャッシュの読み込みは JS 側が WASM メモリに入れて渡す）
  3. 各ステージを実行する。キャッシュ点に来たら、その出力を JS 側に返して OPFS に保存させる（全体レンダリングのときだけ）
  4. リミッターではラウドネスを目標に合わせる（8.6）
  5. 処理後の解析（6章）と表示用データ生成（11章）を実行する（全体レンダリングのときだけ）
```

### 5.4 WASM との境界（`akdsp-wasm`）

- 音声バッファは WASM のメモリ上に確保し、JS 側には `Float32Array` のビュー（ポインターと長さ）として見せる。JS はそこへ OPFS から直接読み込む（コピーは1回だけ）。
- 設定や結果は `serde-wasm-bindgen` で JS オブジェクトと相互に変換する。
- キャンセル：JS から `should_cancel: js_sys::Function` を受け取り、STFT のチャンクやステージの切れ目で呼ぶ。true なら `DspError::Cancelled` を返す。
- 進捗：`on_progress(stage, fraction)` を受け取り、100 ms に1回まで呼ぶ。
- パニックは `console_error_panic_hook` でログに出し、JS 側では Worker のエラーとして扱う（19.3）。

### 5.5 決定性（NFR-07）

- 三角関数・指数・対数は `libm` を使う（環境ごとの標準ライブラリの差をなくす）。
- 浮動小数の「速い計算」の最適化は使わない。並列化した場合も、足し合わせの順序を固定する。
- ディザの乱数は、トラック ID と設定から作ったシードによる決定的な乱数（xoshiro）を使う。
- 同じ環境（同じブラウザ・同じ WASM）での再現性はビット単位で保証する。**ネイティブと WASM の間**では FFT の SIMD 経路の違いで末尾のビットが変わることがあるため、差が -100 dBFS 以下であることをテストで確認する（T-WASM-01）。

### 5.6 性能予算（4分のステレオ曲、M1、全体レンダリング）

| 処理 | Chrome | Safari（目安） |
|---|---|---|
| デコード＋SRC＋入力整形 | 1.0 s | 1.5 s |
| 処理前の解析 | 3.0 s | 4.5 s |
| クリーンアップ（STFT） | 9.0 s | 13.0 s |
| EQ（FIR の FFT 畳み込み） | 0.7 s | 1.0 s |
| ダイナミクス | 1.5 s | 2.2 s |
| ステレオ | 0.3 s | 0.5 s |
| リミッター（4倍 OS × 最大4回の反復） | 6.0 s | 9.0 s |
| 処理後の解析＋表示用データ | 4.0 s | 6.0 s |
| OPFS への書き込み | 0.5 s | 1.0 s |
| **合計** | **約 26 s**（目標 30 s） | **約 39 s**（目標 45 s） |

- WASM は SIMD128 を有効にしてビルドする（`-C target-feature=+simd128`）。FFT と FIR の畳み込みがおもな恩恵を受ける。
- アルバムでは曲ごとに別の Worker で並列処理する（4.6 の制限の範囲で）。

---

## 6. DSP エンジン：解析（Analyzer）

### 6.1 出力項目と計算方法

| 項目 | 計算方法 |
|---|---|
| Integrated LUFS | BS.1770-4（K 特性、400 ms ブロック、75% オーバーラップ、絶対ゲート -70 LUFS ＋ 相対ゲート -10 LU）。自前実装し、EBU の標準テスト信号で検証する |
| Momentary 時系列 | 400 ms 窓、100 ms ホップ（10 Hz） |
| Short-term 時系列 | 3 s 窓、100 ms ホップ（10 Hz） |
| LRA | EBU Tech 3342（Short-term の分布で、ゲート後の 10〜95 パーセンタイル） |
| True Peak | 4倍のポリフェーズ・オーバーサンプリング（48 タップ/位相）後の絶対値の最大。最終検証は 8倍で行う |
| Sample Peak | 絶対値の最大 |
| PLR | True Peak − Integrated |
| L95 | Short-term LUFS のうちゲートを通った値の 95 パーセンタイル（「一番盛り上がる区間の音量」。アルバムで使う） |
| 平均スペクトル | Welch 法（n_fft 8192、Hann、50% オーバーラップ。realfft）で Mid 信号を処理 → 1/6 オクターブに平滑化 → 20 Hz〜20 kHz の 61 点 |
| 表示用スペクトログラム | 11.3 を参照 |
| 相関 | 100 ms 窓の L/R 相関係数の時系列と、全体の平均 |
| 帯域ごとの幅 | オクターブ帯域ごとに Side / Mid のエネルギー比（dB） |
| モノラル互換性 | `LUFS((L+R)/2 のモノラル) − LUFS(ステレオ)` の低下量（LU） |
| クリップ | 絶対値 ≥ 0.999 のサンプルが 3 つ以上連続する箇所 |
| DC オフセット | チャンネルごとの平均値 |
| セクション | 6.3 |
| アーティファクト指標 | 6.2 |

### 6.2 アーティファクト指標

共通の前処理：Mid 信号に STFT をかける（n_fft 2048、hop 512、Hann）。振幅スペクトルを dB にしたものを `L(t, f)` とする。ラウドネスのゲートで無音のフレームを除外する。

| 指標 | 計算方法 | 出力 |
|---|---|---|
| **Shimmer Score** | 6〜16 kHz を 1/3 オクターブ帯域 b に分ける。`E_b(t)` = 帯域レベル `L_b(t)` の時間方向移動中央値（7 フレーム ≒ 75 ms）。`D_b(t) = L_b(t) − E_b(t)`。トランジェントのフレーム（全帯域のスペクトルフラックスが上位 5%）を除き、`F = mean_b( P90_t( max(D_b, 0) ) )` を求める。帯域のスペクトル平坦度 `SFM`（0〜1）で重み付けし、`S = F × (0.5 + 0.5 × SFM)`。`ShimmerScore = clip((S − 1.0) / (4.0 − 1.0), 0, 1) × 100`（1.0 / 4.0 は要較正） | 0〜100 |
| Hiss Level | Short-term LUFS が下位 10% のフレーム（ゲート通過分）で、10 kHz 以上の平均パワー（dBFS）を求め、同じフレームの 1〜4 kHz の平均パワーとの差をとる | dB（大きいほどヒスが多い） |
| Fizz Index | 平均スペクトルの 5〜8 kHz について、ジャンル目標カーブとの差のうち正の部分の平均（両者は 500 Hz〜2 kHz の平均で正規化）＋ 同じ帯域の包絡線のクレストファクターの超過分 × 0.5 | dB |
| Mud Index | 平均スペクトルの 200〜500 Hz について、目標カーブとの差のうち正の部分の平均。超過が最大になる周波数 `mudFreq` も出力する | dB, Hz |
| Bandwidth Cutoff | 平均スペクトルを高い方から見て、「1〜4 kHz の平均 − 30 dB」を初めて上回る周波数 f_c。f_c の 1/3 オクターブ上での落ち込みが 24 dB を超えるときだけ「帯域の欠け」と判定する | Hz または null |
| Click Count | 7.2 の検出器を感度 5 で走らせたときの検出数 | 件数 |
| Transient Density | スペクトルフラックスのピーク数 / 分 | 回/分 |

### 6.3 セクション推定

1. 特徴量：Short-term LUFS（10 Hz）＋ 12 次元クロマ ＋ 13 次元 MFCC（メルフィルターバンク 40 帯域 → DCT。自前実装）を 0.5 s 平均したもの
2. 自己類似行列からチェッカーボード・カーネル（16 s）でノベルティ曲線を作る
3. ピーク検出（最小間隔 8 s）→ 境界とする
4. 各区間の平均ラウドネスで、相対的なラベルを付ける：最大＝`High`、中央値未満＝`Low`、その他＝`Mid`。UI では「セクション 1（High）」のように表示する（イントロ・サビ等の意味ラベルは付けない。推定の誤りで混乱させないため）

---

## 7. DSP エンジン：Suno クリーンアップ

### 7.1 処理順

```
入力(C0) → De-click（時間領域） → [STFT 共通フレーム：De-hiss × Shimmer × Resonance のゲインマスク] → Mud Control（時間領域の動的EQ） → 出力(C1)
```

- スペクトル処理は**1回の STFT** にまとめる。STFT を何度もかけて位相がにじむのを避け、計算量も減らすため。
- ゲインマスクは L/R で**共通**にする（Mid と Side の大きい方から計算し、両チャンネルに同じゲインをかける）。こうするとステレオ定位が崩れない。

### 7.2 De-click

| 項目 | 内容 |
|---|---|
| 前処理 | 2 kHz 以上をハイパス（4次 Butterworth、前向き・後向きにかけてゼロ位相） |
| 検出 | 32 次の LPC（Levinson-Durbin）の予測残差 `r(n)` を 1 s ブロックごとに計算する。`|r(n)| > k × MAD(r)`、k = 12 − sensitivity（sensitivity は 1〜10、既定 5） |
| まとめ | 検出点の間隔が 0.5 ms 以内なら1つのクリックにまとめる。2 ms を超えるものはクリックとみなさない（トランジェントの誤検出防止） |
| 修復 | 最小二乗の AR 補間（LSAR、次数 32、前後 3 ms の文脈。nalgebra のコレスキー分解で解く） |
| 既定 | Click Count ≥ 3 のときだけ自動で有効にする |

### 7.3 STFT 共通フレーム

| 項目 | 値 |
|---|---|
| n_fft | 2048（42.7 ms @48k） |
| hop | 512（75% オーバーラップ） |
| 窓 | 分析・合成とも √Hann（WOLA で完全再構成） |
| 処理単位 | 10 s のチャンクに前後 8 フレームの余白をつけて処理する（WASM のメモリを抑えるため。全体を一度に複素数で持つと約 0.7 GB になる） |
| マスクの合成 | `G(t,f) = max(G_floor, G_hiss × G_shimmer × G_res)`、`G_floor` = -18 dB |
| マスクの平滑化 | 周波数方向：1/12 オクターブの三角窓。時間方向：アタック 1 フレーム、リリース 50 ms の非対称な1次平滑化（ミュージカルノイズ対策） |
| 遅延 | n_fft − hop を出力のずらしで補償する |

### 7.4 De-hiss

```
N(f)：ノイズプロファイル。全フレームの各ビンのパワーについて 10 パーセンタイル（minimum statistics）を求める。
      ゲートで除いた無音フレームは使わない。
w(f)：適用する帯域の重み。f_low の 1 オクターブ下から f_low まで 0→1 に立ち上がる（コサイン）。
α  ：過剰減算係数 = 1.0 + 2.0 × amount（amount = 0〜1）
g_floor = 10^(floorDb_eff / 20)、floorDb_eff = floorDb × amount（floorDb は設定値。既定 −12 dB）
G_w(t,f)    = sqrt( max( g_floor², 1 − α × N(f) / |X(t,f)|² ) )   … Wiener 型のゲイン
G_hiss(t,f) = 1 − w(f) × (1 − G_w(t,f))                         … 帯域の外では 1（素通り）
```

### 7.5 Shimmer Reduction（中核アルゴリズム）

狙い：高域で**時間方向に細かく上振れする成分**（ガラスっぽいざらつき）だけを抑え、エネルギーの大まかな時間変化（音符・トランジェント）は残す。

```
L(t,f) = 20 log10 |X(t,f)|                              … dB の振幅
E(t,f) = 時間方向の移動中央値(L, W フレーム) を、周波数方向に 1/6 オクターブで平滑化したもの
         W = round(windowMs / hop_ms)（既定 75 ms → 7 フレーム）
τ      = thresholdDb（既定 1.5 dB）                    … これ以下の揺らぎは自然なものとして残す
w(f)   = 帯域の重み（fLow〜fHigh で 1。両端を 1/3 オクターブのコサインで落とす）
T(t)   = トランジェント度 0〜1（2〜16 kHz のスペクトルフラックスを、移動中央値の 3 倍で正規化してクリップ。
         前後 2 フレームに最大値で広げる）
s(t,f) = amount × w(f) × (1 − transientProtect × T(t))
L_out  = (1 − s) × L + s × min(L, E + τ)               … 包絡線＋τ を超えた分だけ削る（谷は埋めない）
G_shimmer(t,f) = 10^((L_out − L) / 20)                  … ≤ 1
```

- 位相は元のままにする（振幅だけを変えるゲインマスク）。
- **移動中央値の実装**：高域のビン（6〜16 kHz ＝ 約 430 ビン）だけを対象に、ビンごとに長さ W の窓を挿入ソートで更新する（W が小さいので O(W) で十分速い）。P0 で予算を超えたら、ソート済みの窓を SIMD でまとめて更新する方式に切り替える。

### 7.6 Resonance / De-ess

```
S_n(t,f) = L を 1/24 オクターブで平滑化（細かい包絡線）
S_w(t,f) = L を 1/3 オクターブで平滑化（大まかな包絡線）
R(t,f)   = S_n − S_w                                    … 突出した共鳴の量
θ        = 12 − sharpness（dB。sharpness 1〜10、既定 5 → 7 dB）  ※ 値が大きいほど鋭いピークだけを抑える
v(f)     = 帯域の重み（fLow〜fHigh）×（1 + deessFocus × 5〜10 kHz のコサイン重み）
cut_dB   = amount × v(f) × max(0, R − θ) × 0.8，上限 12 dB
G_res    = 10^(−cut_dB / 20)
時間方向の平滑化：アタック 1 フレーム、リリース 80 ms
```

### 7.7 Mud Control（時間領域の動的EQ）

計算を軽くするため、「定ピーク 0 dB のバンドパス BP」を使った**並列型ベル**で実装する。

```
BP  = RBJ バンドパス（constant 0 dB peak gain、中心 f0 = freq、Q）
b(n)= BP(x)(n)
y(n)= x(n) + (g(n) − 1) × b(n)                          … g = 1 のとき素通り、g < 1 でカット
検出：e(n) = RMS_50ms(b) / RMS_50ms(x)（dB）
      over(n) = e(n) − e_target，e_target = 目標カーブ上でのこの帯域の相対レベル
g_dB(n) = −clip( amount × max(0, over(n)) × 0.7, 0, maxCutDb )
g(n) は アタック 20 ms／リリース 150 ms で平滑化する
```

---

## 8. DSP エンジン：マスタリングチェーン

### 8.1 入力整形（conditioning）

1. デコード：symphonia で WAV / AIFF / FLAC / MP3 / AAC（M4A）/ ALAC を読む（ブラウザの `decodeAudioData` は使わない。ブラウザごとにサンプルレート変換の挙動が違い、結果がそろわないため）
2. float32 に変換する。モノラルなら複製してステレオにする。3 ch 以上はエラー（E-IN-004）
3. SRC：入力のサンプルレートが内部と違えば rubato（Sinc、sinc_len 256、Blackman-Harris 窓、オーバーサンプリング 256）で 48 kHz に変換する
4. DC 除去：1次の DC ブロッカー（カットオフ 5 Hz）を前向き・後向きにかけてゼロ位相にする
5. 入力がクリップしている場合は警告（W-IN-002）だけを出す（De-clip は P3 で検討）

### 8.2 Tonal EQ

**目標カーブ**：`presets/genres/<id>.json`。20 Hz〜20 kHz の 1/6 オクターブ 61 点の dB 値（500 Hz〜2 kHz の平均が 0 dB になるように正規化）。初期セット：`pop, rock, edm, hiphop, ballad, acoustic, jpop_anime`。`auto` は平均スペクトルとの RMS 距離が最小のカーブを選ぶ。

**補正量の計算**：

```
M(f)  = クリーンアップ後（C1）の平均スペクトル（500 Hz〜2 kHz で正規化）
C(f)  = toneMatch × clip( smooth_1/3oct(T(f) − M(f)), −maxCorrectionDb, +maxCorrectionDb )
        ※ Bandwidth Cutoff f_c がある場合、f > f_c では C(f) を 0 以下に制限する（存在しない帯域を持ち上げない）
Tone(f) = tone/100 × 0.75 dB/oct × log2(f / 1000)  ＋  tone>0 のとき：10 kHz ハイシェルフ +tone/100 × 1.5 dB
A(f)  = アルバムの揃え補正（10.3。シングルでは 0）
Manual(f) = 手動バンドの合成応答（dB）
HPF(f)= hpfHz の 4次 Butterworth 相当の振幅特性
Total(f) = C + Tone + A + Manual + HPF
```

**実装**：`Total(f)` を振幅とする**リニアフェーズ FIR** を周波数サンプリング法で設計する。

1. 16,384 点の周波数グリッドに `Total(f)` を補間する（61 点の対数周波数を3次スプラインで補間）
2. 位相ゼロの振幅スペクトルを逆 FFT し、中心に寄せる
3. 8,191 タップに切り出し、Kaiser 窓（β = 8）をかける
4. 畳み込みは FFT の overlap-save（ブロック 16,384、realfft）。遅延（4,095 サンプル）はずらして補償する

- 手動バンドのタイプ：`bell, lowShelf, highShelf, highPass, lowPass`。RBJ の式で振幅応答を求め、dB で加算する（位相はリニアフェーズになる）。

### 8.3 Dynamics

| 要素 | 仕様 |
|---|---|
| 帯域分割 | Linkwitz-Riley 4次（LR4：2次 Butterworth の biquad を2段）を 2 つのクロスオーバーで使い、3 バンドに分ける。既定 150 Hz / 3 kHz。低域側にオールパス補正をかけ、合成したときの振幅を平坦にする |
| 各バンドのコンプ | 自前実装。RMS 検出（窓 10 ms）→ ソフトニー（6 dB）のゲイン計算 → アタック／リリースの平滑化。ステレオはリンクする（L/R の大きい方で検出） |
| しきい値の自動設定 | 各バンドの Short-term RMS の 70 パーセンタイル + 2 dB を基準にし、`punch` に応じて ±3 dB ずらす（要較正） |
| メイクアップ | 各バンドの「処理前後の平均レベル差」を自動で補償する（トーンを変えないため） |
| トランジェント復元 | 包絡線 fast（アタック 1 ms／リリース 20 ms）と slow（アタック 20 ms／リリース 200 ms）の差 `Δ = env_fast − env_slow`（dB、正の部分のみ）を使い、`gain = +transient.amount/100 × min(Δ, 6) × 0.66`（最大 +4 dB）を全帯域にかける |

**Punch マクロ（0〜100）の対応**：

| パラメーター | Punch 0 | Punch 50 | Punch 100 |
|---|---|---|---|
| 各バンドのアタック倍率 | ×0.6 | ×1.0 | ×1.8 |
| 中低域バンドの比率 | 1.3 | 1.8 | 2.5 |
| しきい値のずれ | +3 dB | 0 | −3 dB |
| transient.amount | 0 | 35 | 80 |

（中間の値は線形補間）

### 8.4 Saturation（既定 OFF）

- 4倍にオーバーサンプリングしてから処理し、元のレートに戻す（ハーフバンド FIR を2段。エイリアス対策）。
- `clean`：`tanh(k·x)/tanh(k)`、`k = 1 + drive/25`
- `warm`：`tanh(k·(x + 0.1·x²))` ＋ DC 除去（偶数次の倍音を足す）
- `tape`：ソフトニー ＋ 16 kHz で -1 dB の緩いシェルフ
- `mix`：原音とのドライ／ウェット比

### 8.5 Stereo

```
M = (L + R)/2,  S = (L − R)/2
S' = S × width/100
低域のモノラル化：S' を LR4 で monoBelowHz において分割し、低域側を捨てる
L' = M + S',  R' = M − S'
ガード：処理後の平均相関 < 0.2、またはモノラル互換性の低下 > 3 LU のときは、
        width を 5% ずつ下げて条件を満たすまで再計算する（最大 10 回）。警告 W-ST-001 を出す
```

### 8.6 Limiter とラウドネスの目標合わせ

**リミッター本体**：

| 項目 | 仕様 |
|---|---|
| 検出 | 入力を 4倍（設定で 8倍）にオーバーサンプリングし、元のレートのサンプルごとに 4 つのサブサンプルの絶対値の最大をとって `p(n)` とする |
| 必要ゲイン | `g_req(n) = min(1, c / p(n))`、c = 10^((ceilingDbtp − 0.1)/20)（0.1 dB の安全マージン） |
| ルックアヘッド | `la` = lookaheadMs（既定 1.5 ms ＝ 72 サンプル）。`g_min(n)` = `g_req` の [n, n+la] の最小値（Lemire のスライディング最小値で O(N)） |
| アタック | `g_min` を長さ la の移動平均（ハン形状）で平滑化する。ゲインは la サンプル前から下がり始めるので、ピークの時点で必ず必要量に達する |
| リリース | 2段階のプログラム依存型。fast（50 ms）と slow（release 設定、既定 auto＝250 ms）。直近 200 ms に GR > 3 dB が続いていたら slow 側に寄せる |
| character | `transparent`：上記のとおり。`punchy`：リリース fast を 30 ms にし、2段階の切り替えを鈍くする |
| 遅延 | la を出力のずらしで補償する |

**ラウドネスの目標合わせ（全体レンダリング）**：

```
L_pre = LUFS(C2)
g0 = target − L_pre                         … 初期ゲイン（dB）
for i in 0..3:
    y = limiter(C2 × 10^(g_i/20))
    L_i = LUFS(y)
    if |target − L_i| ≤ 0.2 LU: break
    g_{i+1} = セカント法（i=0 のときは g_i + (target − L_i)）
True Peak の検証（8倍 OS）：
    TP(y) > ceiling のとき：ceiling_internal −= (TP − ceiling) + 0.05 として、リミッターだけを再実行する（最大 3 回）
    それでも超える場合：全体に −(TP − ceiling) dB のゲインをかける（必ず守るための最終手段）。警告 W-LM-002
```

**かけすぎの検知**：GR の平均 > 6 dB、または PLR < 6 dB のとき、警告 W-LM-001「音圧の上げすぎ」を出す。

### 8.7 Output

| 項目 | 仕様 |
|---|---|
| SRC | rubato（8.1 と同じ設定）で 48 → 44.1 kHz 等に変換する。SRC は**リミッターの後**に行うため、SRC 後に True Peak を再検証し、超えていれば 8.6 の最終手段と同じ方法で補正する |
| ディザ | 16 bit：TPDF（±1 LSB）を既定にする。24 bit：TPDF（任意）。32f：なし。ノイズシェーピング（9次 F-weighted）は任意。乱数は 5.5 の決定的な乱数 |
| WAV / AIFF | WAV は hound、AIFF は自前の書き出し（DSP Worker 内） |
| FLAC | flacenc（圧縮レベル 5 相当） |
| MP3 | LAME の WASM ビルド（320 kbps CBR）を、エンコード用の Worker で実行する |
| AAC | WebCodecs の `AudioEncoder`（`mp4a.40.2`、256 kbps）でエンコードし、mp4-muxer で `.m4a` にする。`AudioEncoder.isConfigSupported()` が false のブラウザでは選択肢から外す（W-BR-001） |
| 非可逆形式の検証 | エンコード後にデコード（symphonia）して True Peak を測る。ceiling を超えていたら警告 W-OUT-001（「MP3/AAC 用に ceiling を -1.5 dBTP 以下にすることをおすすめします」） |
| タグ | WAV：RIFF INFO ＋ `id3 ` チャンク。FLAC：Vorbis コメント。MP3：ID3v2.4（id3 クレート）。M4A：mp4-muxer で可能な範囲（タイトル・アーティスト・アルバム・曲番号） |

---

## 9. DSP エンジン：Auto Master

### 9.1 処理の流れ

```
auto_master(track):
  1. 処理前の解析結果を使う（なければ解析する）
  2. ジャンルが auto なら、目標カーブを推定する（8.2）
  3. 9.2 の規則表でパラメーターの初期値を求める
  4. 全体レンダリング（8.6 のラウドネス合わせを含む）
  5. 処理後の検証：Shimmer Score の減少率 < 30%、かつ処理後の Shimmer Score > 40 なら shimmer.amount を +15 して 4 に戻る（1回まで）
                  高域（8〜16 kHz）のエネルギーが処理前より 6 dB 以上減ったら、cleanup を 0.8 倍して 4 に戻る（1回まで。こもり防止）
  6. 結果を「提案」として返す（設定 ＋ 変更理由の一覧）
```

### 9.2 規則表（初期値。要較正）

| 入力指標 | 条件・式 | 設定先 |
|---|---|---|
| Shimmer Score `S` | `20 + 0.6·S`（0〜80 にクリップ） | `cleanup.shimmer.amount` |
| 目標ラウドネス `T` | `T > −14` のとき `+3 × (T + 14)`（上限 +15） | `cleanup.shimmer.amount`（加算） |
| Hiss Level `H` | `clip((H + 45) × 4, 0, 70)` | `cleanup.dehiss.amount` |
| Fizz Index `F` | `clip(F × 15, 0, 70)` | `cleanup.resonance.amount` |
| Mud Index `M`, `mudFreq` | `clip(M × 20, 0, 80)`、freq = mudFreq | `cleanup.mud.amount`, `.freq` |
| Click Count | ≥ 3 → 有効 | `cleanup.declick.enabled` |
| PLR | < 8 dB → 55、それ以外 → 35 | `macros.punch` |
| モノラル互換性の低下 | > 3 LU → width 90 / monoBelow 150 Hz | `stereo.*` |
| Bandwidth Cutoff | あれば f > f_c をブーストしない（8.2）＋ 情報表示 I-AN-001 | `eq` |
| — | Cleanup マクロの値 = 各 amount の重み付き平均（重み：shimmer 0.4、dehiss 0.2、resonance 0.25、mud 0.15） | `macros.cleanup` |

### 9.3 Cleanup マクロと各 amount の連動

- Auto Master が出した各 amount を**基準値 `a_i`**、そのときのマクロ値を `m0` として保存する。
- マクロを `m` に動かしたとき：`amount_i = clip(a_i × m / m0, 0, 100)`（`m0 = 0` のときは `amount_i = m × w_i'`。`w_i'` は 9.2 の重みを正規化したもの）。
- 個別の amount を手で変えた場合は、その値を新しい `a_i` とする（マクロ値はそのまま）。

---

## 10. DSP エンジン：アルバムバランサー

### 10.1 設定の2層構造

```
有効な設定(track) = deepMerge(album.common, track.overrides)
```

- `album.common`：キャラクター、ジャンルカーブ、リミッターの性格、ceiling、ラウドネス目標（アンカー曲用）
- `track.overrides`：クリーンアップ（曲ごとに Auto Master が決める）、EQ の手動バンド、相対ゲイン、その他ユーザーが曲ごとに変えたもの

### 10.2 ラウドネスの相対設計

```
入力：各曲の処理前 L95_before(i)、アンカー曲 a、意図の保持率 k（既定 0.5、0〜1）、ユーザーの相対オフセット o(i)
1. アンカー曲：目標 = album.common.targetLufs（Integrated）で 8.6 を実行 → L95_after(a) を得る
2. 他の曲 i：
     L95_goal(i) = L95_after(a) − k × (L95_before(a) − L95_before(i)) + o(i)
     リミッターのラウドネス合わせ（8.6）を「Integrated」ではなく「L95」に対して行う（同じセカント法）
3. 安全策：L95_goal(i) が L95_after(a) を超える場合は L95_after(a) に制限する（アンカーより大きくしない）
```

- アンカー曲の既定は、`L95_before` が最大の曲とする。
- 曲がアンカーより大きくなる設定は、警告 W-AL-002 を出したうえで許可する（3 の制限を外す）。

### 10.3 トーンの揃え

```
1. 各曲を、曲ごとの Tonal EQ（A = 0）まで処理し、その平均スペクトル S_i(f) を求める（40 Hz〜16 kHz、500 Hz〜2 kHz で正規化）
2. アルバム基準 R(f) = 各曲の S_i(f) の中央値（外れた曲に引っ張られないよう、平均ではなく中央値を使う）
3. A_i(f) = toneMatchAmount × clip( smooth_1oct(R − S_i), −2 dB, +2 dB )
4. A_i を 8.2 の Total(f) に足して、FIR を作り直す（ステージは増やさない）
```

### 10.4 全体の手順

アルバムの処理は複数の Worker にまたがるため、**Orchestrator が手順を進め**、各 Worker は1曲ぶんの処理だけを行う。

```
album_auto_balance():                                     （Orchestrator）
  1. 全曲を解析する                                         → Worker に並列で依頼
  2. 全曲に Auto Master を行い、C2 まで処理して S_i(f) を得る  → 並列
  3. トーンの基準 R(f) と各曲の A_i(f) を計算する              → WASM の関数 albumTonePlan()（どの Worker でもよい。小さな計算）
  4. アンカー曲を全体レンダリング → L95_after(a)
  5. 他の曲を 10.2 の L95 目標で全体レンダリング               → 並列
  6. 検証：
       |L95_after(i) − L95_goal(i)| > 1.0 LU → W-AL-001
       トーン偏差 = RMS_f( S_i_after − R )（100 Hz〜10 kHz）> 1.5 dB → W-AL-003
  7. 各曲の設定差分・指標・警告をプロジェクトに保存する
```

### 10.5 曲順・曲間・フェード

| 項目 | 仕様 |
|---|---|
| 曲間 | `gapAfterSec`：0〜10 s（既定 2.0）。最終曲は無視する |
| クロスフェード | `crossfadeSec` > 0 のとき、ギャップの代わりに重ねる（0〜8 s）。カーブはイコールパワー |
| フェード | `fadeIn` / `fadeOut`：`{ durationSec: 0〜20, curve: "linear" | "equalPower" | "log" | "exp" }`。マスタリングチェーンの**後**、ディザの**前**にかける |
| 連続ファイル | 書き出し時のサンプルレートで、各曲（フェード済み）＋ギャップ（デジタル無音）をつなげる。OPFS の `/tmp/` に順に書き足していく（メモリに全体を載せない） |
| CD 互換オプション | 曲の開始位置を CD フレーム（44.1 kHz で 588 サンプル）の境界に合わせる（ギャップを調整） |
| CUE | `FILE "album.wav" WAVE` / 曲ごとに `TRACK nn AUDIO`、`TITLE`、`PERFORMER`、`INDEX 01 mm:ss:ff`（75 フレーム/秒） |
| つなぎ目の試聴 | 曲 i の最後の 10 s ＋ ギャップ ＋ 曲 i+1 の最初の 10 s を一時的にレンダリングして再生する |

---

## 11. DSP エンジン：表示用データ生成

全体レンダリングの後に作成し、OPFS（`/cache/<projectId>/<trackId>/display/<key>/`）に保存する。

### 11.1 波形ピラミッド（`.akpeaks`）

| 項目 | 仕様 |
|---|---|
| 対象ソース | `before`（C0）、`after`（C3）、`diff_gm`（after − g·before）、`diff_raw`（after − before） |
| チャンネル | `L`, `R`, `C`（Combined：各ビンで L と R の min の小さい方・max の大きい方、RMS は二乗平均） |
| レベル | level0 = 64 サンプル/ビン、以降 ×4（256, 1024, 4096, 16384） |
| 値 | 各ビンの `min, max, rms`（float32。int16 だと dB 表示で小さい音がつぶれるため） |
| ファイル | ヘッダー JSON ＋ レベルごとの連続ブロック `[ch][bin][3]` |
| サイズの目安 | 4分の曲 × 1ソース ≒ 6 MB |

- `diff_gm` の g = 10^((LUFS_after − LUFS_before)/20)（Before を After のラウドネスに合わせる）。

### 11.2 ゲイン差（Gain Δ）

```
K 特性をかけた信号の短時間パワー（窓 50 ms、ホップ 10 ms ＝ 100 Hz）を Pa(t)（after）, Pb(t)（before）とする
ΔdB(t) = 10 log10(Pa/Pb) − offset
offset = gain-match ON のとき (LUFS_after − LUFS_before)、OFF のとき 0
どちらも −60 dBFS 未満のフレームは NaN（描画しない）
出力：float32 配列（100 Hz）
```

### 11.3 スペクトログラムとスペクトル差（Spectral Δ）

```
STFT：n_fft 4096、hop 2400（20 列/秒）、Hann、Mid 信号
周波数軸：30 Hz〜20 kHz を対数で 256 ビンに再サンプリング（三角フィルターバンク）
値：dB（float16 で保存）
Spectral Δ(t, k) = Sa(t,k) − Sb(t,k) − offset（offset は 11.2 と同じ）を 3×3 の中央値で平滑化
Sb, Sa のどちらかが −90 dB 未満のセルは NaN
```

- 4分の曲で 4,800 列 × 256 ビン ≒ 1.2M 値。WebGL2 のテクスチャ1枚に収まる。

### 11.4 その他の表示用系列

| 系列 | 内容 | レート |
|---|---|---|
| `loudness_st` | Short-term LUFS（before/after） | 10 Hz |
| `gr` | リミッターのゲインリダクション（dB） | 100 Hz |
| `markers` | TP 超え（before：クリップ箇所／after：ceiling − 0.05 dB 超え）、セクション境界 | — |

---

## 12. 再生エンジン（AudioWorklet）

### 12.1 構成

```
                  ┌──────────── 再生用の共有メモリ（表示中の曲）──────────┐
                  │ before: ChunkPool（C0）                              │
                  │ after : ChunkPool（C3。区間レンダリングの結果で差し替え）│
                  │ ref   : ChunkPool（リファレンス曲。48k に変換済み）     │
                  │ control: 制御ブロック（モード、位置、ループ、ゲイン…）  │
                  │ meters : メーターの値                                  │
                  └──────────────────────────────────────────────────────┘
  I/O Worker ──(OPFS から読み込み)──▶ ChunkPool      ▲ 読み取りのみ
  Orchestrator ──(区間の差し替え・制御の書き込み)──▶   │
                                     [AudioWorkletProcessor] ─▶ AnalyserNode ─▶ destination
```

- `AudioContext({ sampleRate: 48000, latencyHint: "interactive" })`。出力デバイスのレートが違えば、ブラウザが変換する。
- AudioContext は最初のユーザー操作（再生ボタン等）で作成・再開する（ブラウザの自動再生の制限のため）。

### 12.2 共有メモリのレイアウト

**ChunkPool**（ソースごと）：

| 領域 | 型 | 内容 |
|---|---|---|
| `slots` | Float32Array（SharedArrayBuffer） | `slotCount × 2ch × 48,000` フレーム。1スロット＝1秒ぶん |
| `table` | Int32Array（SharedArrayBuffer） | `table[i]` = 曲の i 秒目のデータが入っているスロット番号 |
| 予備スロット | — | 差し替え用に `slotCount = 曲の秒数 + 16` を確保する |

**制御ブロック**（Int32Array / Float32Array / BigInt64Array のビュー）：

| フィールド | 型 | 内容 |
|---|---|---|
| `playing` | Int32 | 0/1 |
| `mode` | Int32 | 0=before, 1=after, 2=delta, 3=reference |
| `position` | BigInt64 | 再生位置（フレーム）。Worklet が書き、メインスレッドが読む |
| `seekRequest` | BigInt64 | −1 以外ならその位置へ移動（Worklet が処理したら −1 に戻す） |
| `loopStart` / `loopEnd` | BigInt64 | ループ範囲（無効なら −1） |
| `gainBefore` / `gainDelta` / `gainRef` / `gainPlatform` | Float32 | 12.3 のゲイン（直線値） |
| `mono` | Int32 | 0/1 |
| `epoch` | Int32 | Worklet が1クォンタム（128 フレーム）ごとに 1 増やす（スロット解放の判定に使う） |

**メーターブロック**：Float32Array（`momentary, shortTerm, peakL, peakR, tpL, tpR, correlation, gonio[512]`）。Worklet が書き、メインスレッドが rAF で読む（30 Hz に間引く）。

### 12.3 モードと出力式

| モード | 出力 `y(n)` |
|---|---|
| Before | `g_b × before(n)` |
| After | `after(n)` |
| Delta | `after(n) − g_d × before(n)` |
| Reference | `g_r × ref(n)` |

| ゲイン | 値 |
|---|---|
| `g_b` | Loudness Match が ON のとき `10^((LUFS_after − LUFS_before)/20)`、OFF のとき 1 |
| `g_d` | Delta の gain-match が ON（既定）のとき `g_b` と同じ、OFF のとき 1 |
| `g_r` | Loudness Match が ON のとき `10^((LUFS_after − LUFS_ref)/20)` |
| 範囲合わせ | 設定「ループ範囲で合わせる」が ON のときは、Integrated の代わりにループ範囲の LUFS を使う（解析の Short-term 系列から算出） |

**Platform Sim**：上の出力にさらに `g_p` をかける。

| プラットフォーム | `g_p`（dB） |
|---|---|
| Spotify（通常） | `−14 − LUFS_after`。正の場合は `min(値, −1 − TP_after)` で制限する |
| Spotify（アルバム） | アルバム全体の LUFS（全曲をつなげて計測）で上と同じ計算をし、全曲に同じ値を使う |
| Apple Music | `min(0, −16 − LUFS_after)` |
| YouTube | `min(0, −14 − LUFS_after)` |

※ 各社の実装を簡略化した近似であることを UI に注記する。

**Mono**：`(L + R)/2` を両チャンネルに出す。

### 12.4 Worklet の処理（`process()`、128 フレームごと）

```
1. seekRequest を確認し、あれば 5 ms のフェードアウト → 移動 → フェードインを行う
2. mode が前回と違えば、10 ms（480 フレーム）のイコールゲイン・クロスフェード（新 = sin²、旧 = 1 − sin²）で旧モードから新モードへ移す
   （同じ位置のサンプル同士を混ぜる。Before/After は同じ曲で相関が高いため、イコールパワーだと途中で最大 +3 dB 膨らむ）
3. 各フレームについて：table を引いてスロットを特定し、12.3 の式で出力を作る
   ループ範囲の終わりに来たら、5 ms のイコールパワー・クロスフェード（曲の別の場所どうしで相関が低いため）で loopStart に戻る
4. メーターの計算（12.7）
5. position を更新し、epoch を 1 増やす
```

- **切り替えの遅延**＝ 1 クォンタム（2.7 ms）＋ クロスフェード（10 ms）＋ 出力の遅延（`baseLatency + outputLatency`、通常 10〜40 ms）。目標 60 ms 以内（NFR-03）。
- Worklet 内ではメモリを確保しない（GC による音切れを防ぐ）。

### 12.5 区間の差し替え

1. Worker から区間の PCM（`[s − 5ms, e + 5ms]`）が届く
2. Orchestrator は、区間にかかる秒ごとに**予備スロット**を取り、既存のデータをコピーしたうえで、先頭と末尾の 5 ms をイコールゲインでクロスフェードし（同じ区間の新旧のレンダリングで相関が高いため）、内側を新しいデータで上書きする
3. `Atomics.store(table, i, 新スロット)` で、秒ごとに差し替える
4. 古いスロットは、`epoch` が 2 以上進んだ後（Worklet がもう読んでいないことが確実になってから）予備に戻す
5. UI に `after_updated(range)` を通知する → 波形を部分的に取り直す

### 12.6 ストリーミング再生（アルバムの連続再生・つなぎ目の試聴）

- アルバム全曲の After をメモリに載せると 1 GB を超えるため、**ストリーミングモード**を設ける。
- I/O Worker が OPFS から曲順・ギャップ・クロスフェードどおりに C3 を読み、リングバッファ（SharedArrayBuffer、4 s ぶん）に書き込む。Worklet はリングバッファから読む。
- ストリーミングモードでは After だけを再生する（A/B 切り替えは使えない。UI ではボタンを無効にする）。
- 曲の境目をまたぐシークは、I/O Worker が読む位置を変え、リングバッファを詰め直す（遅延 200 ms 以内）。

### 12.7 リアルタイムメーター

| メーター | 計算場所・方法 |
|---|---|
| Momentary / Short-term LUFS | Worklet：K 特性の biquad ＋ 400 ms / 3 s のスライディング二乗和 |
| Integrated | 再生中には計算しない。解析値（モードに応じて before/after/ref）を表示する |
| サンプルピーク / TP（近似） | Worklet：4倍 OS（16 タップ/位相）。ピークホールド 1.5 s はメインスレッドで行う |
| 相関 | Worklet：300 ms 窓 |
| スペクトル | `AnalyserNode`（fftSize 8192、smoothingTimeConstant 0.6）。メインスレッドが `getFloatFrequencyData()` で取り、1/6 オクターブにまとめる。30 fps |
| ゴニオメーター | Worklet：直近 2048 サンプルを（M, S）に変換し、1/4 に間引いて書き込む |

### 12.8 出力デバイス

- `AudioContext.setSinkId()` があるブラウザ（Chrome / Edge）だけ、設定画面に出力デバイスの選択を出す。Safari では OS の既定の出力を使う。

---

## 13. Orchestrator：プロジェクト・ジョブ管理

### 13.1 プロジェクトの保存（IndexedDB）

- 変更から 1 s 後（デバウンス）に自動で IndexedDB に保存する。IndexedDB はトランザクション単位で書き込まれるので、途中でタブが閉じても壊れた状態にはならない。
- 保存の単位：プロジェクトのメタ情報、曲ごとの設定、スナップショット、解析結果を別々のレコードにする（設定を1つ変えただけで全体を書き直さないため）。
- 手動保存（Cmd+S）は「保存済み」の表示を更新するだけで、実際には常に自動保存されている。

### 13.2 Undo/Redo

- UI 側で immer のパッチを使って管理する（14.3）。履歴はタブを開いている間だけ保持する（再読み込みで消える）。スナップショットは永続化する。

### 13.3 ジョブキュー

| 優先度 | ジョブの種類 | 実行先 |
|---|---|---|
| P0（最優先） | 表示中の曲の区間レンダリング（ループ範囲・再生位置付近） | Worker #0 |
| P1 | 表示中の曲の全体レンダリング、解析 | Worker #0 |
| P2 | アルバム内の他の曲のレンダリング | バックグラウンド Worker |
| P3 | 書き出し | バックグラウンド Worker（なければ #0 の空き時間） |
| P4 | キャッシュの事前生成 | バックグラウンド Worker |

- **設定が変わると、同じ曲の古いレンダリングジョブは取り消す**（実行中のものはキャンセルフラグを立てる）。
- P1 の実行中に P0 が来たら、P1 をキャンセルして P0 を先に実行し、その後で P1 をやり直す（全体レンダリングは数十秒かかるため）。
- パラメーターの変更は 150 ms デバウンスしてからジョブにする。
- 書き出しは、開始時点の設定を固定して実行する。

### 13.4 複数タブ・複数端末

- 同じプロジェクトを2つのタブで開くと保存が衝突するため、**Web Locks API**（`navigator.locks.request("project:<id>")`）で排他する。ロックが取れないタブでは「別のタブで開いています」と表示し、読み取り専用にする（E-LK-001）。
- データはそのブラウザの中にしかないので、別の PC やブラウザで作業を続けるときは、プロジェクトファイル（13.5）を使う。

### 13.5 プロジェクトファイル（`.akmaster`）

- ZIP 形式（fflate）。構成は基本設計 11.2 のとおり。
- 書き出し：「音源を含める」（既定 ON）を選べる。含める場合のサイズは「音源の合計 ＋ 数 MB」。I/O Worker が OPFS の `/tmp/` に ZIP を作り、完成したら保存またはダウンロードする（16.5 と同じ方法）。
- 読み込み：ZIP を展開し、音源を `/sources/` にコピーし、IndexedDB に登録する。プロジェクト ID が既存と重なる場合は「上書き」か「複製として読み込む」を選ばせる。音源を含まない場合は、曲ごとに音源の再指定を求める（sha256 で一致を確認する）。
- キャッシュはファイルに含めない（読み込み後に再生成する）。

---

## 14. UI：アーキテクチャ

### 14.1 ストア構成（Zustand）

| ストア | 内容 | 永続化 |
|---|---|---|
| `projectStore` | プロジェクト、曲リスト、各曲の設定、アルバム設定、スナップショット | IndexedDB（13.1） |
| `analysisStore` | 解析結果、警告 | IndexedDB |
| `jobStore` | ジョブの進捗、レンダリング済みの範囲 | なし |
| `transportStore` | 再生状態、モード、ループ、Loudness Match、Platform Sim、Mono | モードとトグルだけ localStorage |
| `viewStore` | 波形のレイアウト、表示するソース、差分の表現、ズーム・スクロール、縦軸、オーバーレイの ON/OFF | プロジェクトごとに IndexedDB |
| `prefsStore` | テーマ、言語、ショートカット、出力デバイス | IndexedDB |

- 再生位置とメーターは、ストアに入れずに共有メモリ（12.2）を rAF で直接読む（React の再レンダリングを避けるため）。

### 14.2 設定変更の流れ

```
Knob ドラッグ → projectStore.updateSettings(trackId, patch, {gestureId})
   → immer でパッチを記録（同じ gestureId の間は1つの Undo 単位にまとめる）
   → orchestrator.settingsChanged(trackId)（150 ms デバウンス → 区間レンダリング → 全体レンダリング）
   → 区間の結果が届く → 再生バッファを差し替える（12.5）→ after_updated → 波形を取り直す
```

### 14.3 Undo/Redo

- 対象：設定の変更、曲順、曲間、フェード、アルバム設定。
- 1回のジェスチャー（ドラッグ開始〜終了）を1つの Undo 単位にする。履歴は最大 200 件。
- 再生操作・表示の切り替えは Undo の対象外。

### 14.4 デザイントークン

```css
:root {                       /* ダーク（既定） */
  --bg: #121417; --surface: #1b1e23; --surface-2: #23272e; --border: #2f343c;
  --text: #e6e8eb; --text-muted: #9aa1ab;
  --accent: #3cc8d8;          /* After */
  --neutral-wave: #7d8590;    /* Before */
  --boost: #f2994a;           /* 差分：ブースト（橙） */
  --cut: #4a90e2;             /* 差分：カット（青） */
  --warn: #f2c94c; --danger: #eb5757; --ok: #6fcf97;
  --font-ui: "Inter", "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif;
  --font-num: "JetBrains Mono", ui-monospace, monospace;   /* メーターの数値 */
}
:root[data-theme="light"] { --bg: #f7f8fa; --surface: #ffffff; /* …対応する値… */ }
```

- フォント（Inter, JetBrains Mono）は `public/fonts/` に同梱する（COEP のため外部 CDN は使えない）。日本語は OS のフォント（ヒラギノ、Noto Sans JP 等）を使う。
- 数値（LUFS 等）は等幅フォントで表示し、値が変わっても桁がずれないようにする。
- 増減は色だけでなく、**符号（+/−）と形（上向き/下向き）**でも表す（NFR-12）。

### 14.5 共通 UI 部品

| 部品 | 操作仕様 |
|---|---|
| `Knob` | 縦ドラッグ（200 px で全範囲。Pointer Events とポインターキャプチャ）、Shift＋ドラッグで微調整（×0.1）、ダブルクリックで既定値、ホイール、フォーカス中は ↑↓（1 ステップ）/ Shift＋↑↓（10 ステップ）、値をクリックすると数値入力。`role="slider"` と `aria-valuenow` などを設定する |
| `SegmentedControl` | レイアウトやモードの切り替え。←→ キーで移動 |
| `Meter` | 縦・横のバー。ピークホールド、目標値の目盛り |
| `Badge` | 警告・情報（アイコン＋文言） |
| `Toast` | ジョブの完了・エラー |

### 14.6 キーボードショートカット

- 基本設計 10.6 のとおり（A/B 切り替えは `T` または `` ` ``）。追加：`D`（差分表現の切り替え）、`Shift+V`（逆順にレイアウト切り替え）、`F`（全体表示）、`Z`（ループ範囲にズーム）、`Alt+1/2/3`（S-03 / S-04 / S-05）。
- ブラウザの操作と重なるキーの扱い：
  - `Space`・`Cmd+S`・`Cmd+E`・`Cmd+Z` は `preventDefault()` して、ページのスクロールやブラウザの保存ダイアログを止める。
  - `Cmd+数字`（ブラウザのタブ切り替え）と `Tab`（フォーカス移動）は割り当てない。
- テキスト入力中は1文字のショートカットを無効にする。
- 割り当ては `prefsStore.shortcuts` で変更できる（P3）。

### 14.7 i18n

- `i18n/ja.json`, `i18n/en.json`。キーは `screen.component.label` の形式。
- 専門用語（LUFS, True Peak 等）は両言語とも英語表記のままにし、ツールチップで説明する。

### 14.8 画面幅

- 最小幅 1,024 px を想定する。それより狭い場合は「PC のブラウザで、ウィンドウを広げてお使いください」と表示する（モバイルは対象外：D9）。

---

## 15. UI：波形ビュー

### 15.1 コンポーネント構成

```
<WaveformView>                         … viewStore を購読
  <Minimap/>                           … 曲全体の After（level 4）＋ 表示範囲の枠
  <WaveformToolbar/>                   … レイアウト／ソース／差分の表現／縦軸／オーバーレイ
  <LaneStack>                          … レイアウトに応じてレーンを並べる
     <WaveLane source="before"/>       … Canvas2D
     <WaveLane source="after"/>
     <DiffLane kind="signal|gain|spectral"/>  … signal/gain は Canvas2D、spectral は WebGL2
  </LaneStack>
  <OverlayCanvas/>                     … 再生ヘッド、選択範囲、ループ、マーカー、ホバーの読み取り値（全レーン共通の1枚）
  <SectionBar/>                        … セクションのボタン（クリックでループ）
</WaveformView>
```

### 15.2 ビューポート

```ts
type Viewport = { startFrame: number; framesPerPixel: number; widthPx: number };
```

- 全レーンで同じ `Viewport` を共有する（スクロール・ズームは同期）。
- ズーム：`Cmd + ホイール`（ブラウザのページ拡大を `preventDefault()` で止める）、トラックパッドのピンチ（`ctrlKey` 付きの wheel イベント）、`+`/`−`。カーソル位置を中心に拡大する。`framesPerPixel` の範囲は 1〜（曲全体が収まる値）。
- スクロール：ホイール（横）、ミニマップのドラッグ。再生中は「ページ送り追従」（再生ヘッドが右端 90% に来たら 1 ページ送る）。

### 15.3 データの取得と描画

```
levelFor(fpp) = 次の条件を満たす最大のレベル：binSize(level) ≤ fpp
fpp < 64 のとき：再生用の共有メモリ（Before/After）から表示範囲のサンプルを直接読み、折れ線で描く（fpp < 4 では点も描く）
                 Diff の生サンプルは before と after から計算する
それ以外：display.getPeaks(source, level, binRange) を取得し、ピクセル列ごとに再集約する
```

- ピークの取得は I/O Worker が OPFS から読み、ArrayBuffer を転送で返す。表示範囲の前後 1 画面ずつを先読みする。`(source, level, binBlock[4096 ビン])` 単位で UI 側に LRU キャッシュ（上限 64 MB）。
- 描画（1 列ごと）：
  1. ピーク層：`min〜max` を縦線で塗る（`fillRect` をまとめて `Path2D` 1つにする）
  2. RMS 層：`−rms〜+rms` を濃い色で重ねる
- 縦軸：
  - リニア：`y = mid − v × h/2`
  - dB：`d = max(−60, 20 log10 |v|)`、`y_off = (d + 60)/60 × h/2`（符号を保つ）
- devicePixelRatio を考慮してキャンバスを高解像度にする。リサイズは ResizeObserver で検知する。

### 15.4 レイアウト別の描画仕様

| レイアウト | 内容 |
|---|---|
| Single | 選んだソースを1レーン（高さ 100%）。`1/2/3` キーで切り替わるのは**表示と再生の両方**（連動 ON のとき。設定で切り離せる） |
| Overlay | 1レーンに Before（`--neutral-wave`、塗り 45%）→ After（`--accent`、塗り 25% ＋ 輪郭 1.5 px）の順に重ねる。Diff を ON にすると、その下に高さ 30% の Diff レーンを付ける |
| Stacked | Before / After / Diff を縦に並べる（ON にしたものだけ。高さは均等。境目をドラッグして変更可能） |

**再生中のソースの強調**：再生モードに対応するレーン（Before / After / Delta → Diff:signal）は不透明度 100%＋左端に「▶」バッジ、それ以外は 55%。Overlay では、再生中の方を前面に描く。

### 15.5 差分レーン

| 表現 | 描画 |
|---|---|
| Signal | `diff_gm` または `diff_raw`（ツールバーの「gain-match」トグルに従う）を 15.3 と同じ方法で描く。色は `--boost`。縦軸は自動スケール（表示範囲の最大値の 110%）で、スケールの値を表示する（例：「×8」） |
| Gain Δ | 0 dB を中心線として、`ΔdB > 0` を上向きに `--boost`、`< 0` を下向きに `--cut` で塗る。範囲 ±12 dB（±6 / ±24 に切り替え可能）。NaN の区間は描かない。ホバーすると値を表示 |
| Spectral Δ | WebGL2：`R16F` テクスチャ（列 = 時間、行 = 対数周波数）。フラグメントシェーダーで、表示範囲の時間と周波数を引き、発散カラーマップ（`--cut` → 背景に近い無彩色 → `--boost`、±6 dB。±3 / ±12 に切り替え可能）を当てる。NaN は透明。左に周波数軸（100, 1k, 10k）、右にカラーバー |

- 3つの表現とも、ホバー時に「時刻、値（dB）、周波数（Spectral のみ）」をツールチップで表示する。
- Safari の WebGL2 で `R16F` のフィルタリングが使えない場合は、`R8` に量子化（±12 dB を 256 段階）して代わりに使う（P0-11）。

### 15.6 オーバーレイ要素

| 要素 | 仕様 | 既定 |
|---|---|---|
| 再生ヘッド | 縦線 1 px（`--text`）。rAF で描く。オーバーレイ用のキャンバスだけを描き直す | ON |
| ループ範囲 | 半透明の帯＋両端のハンドル（ドラッグで調整） | — |
| 選択範囲 | ドラッグで作る。`L` キーでループにする | — |
| ラウドネス曲線 | `loudness_st` を折れ線で表示（Before は破線、After は実線）。右軸 −40〜0 LUFS。目標値を水平の点線で表示 | OFF |
| GR の帯 | After レーンの上端に高さ 6 px で、GR の量を濃淡で表示 | OFF |
| マーカー | TP 超え：▲（`--danger`）＋ツールチップ。クリップ：◆。セクション境界：細い縦の点線 | ON |
| 未レンダリング範囲 | After / Diff レーンに斜線のパターン＋「処理中」ラベル | 自動 |
| 暫定ゲイン | 区間プレビュー中（4.5）は、ツールバーに「暫定」バッジを表示 | 自動 |

### 15.7 性能目標と対策（NFR-04）

- 1 フレームの予算：レーン 3 本 × 幅 2,000 px ＋ オーバーレイで 8 ms 以内。
- ズーム・スクロール中は、手元のキャッシュにあるデータだけで描画し、足りない部分は粗いレベルで仮表示する（データ待ちで止めない）。
- 描画は rAF で間引く（1フレームに1回）。React の状態更新は、ビューポートの確定時（操作の終了から 100 ms 後）だけ行う。
- P0 で 60 fps に届かない場合は、波形レーンも WebGL2 で描く方式に切り替える。

### 15.8 アルバム俯瞰ビュー（S-04 のタイムライン）

- 各曲の After（level 4）を、曲の長さに比例した幅で並べる。ギャップは空白、クロスフェードは重ねて表示する。
- ギャップの境界をドラッグすると `gapAfterSec` が変わる（0.1 s 単位。Shift で 0.01 s 単位）。
- 各曲の上に Integrated LUFS と L95 を表示する。外れている曲には警告アイコンを付ける。

---

## 16. UI：画面別詳細

### 16.0 起動時チェック

アプリの読み込み時に次を確認し、満たさない場合はエラー画面（E-BR-001）に必要な条件と対応ブラウザを表示する。

| 確認項目 | 方法 |
|---|---|
| クロスオリジン分離 | `crossOriginIsolated === true` |
| WebAssembly SIMD | 小さな SIMD 命令を含む WASM の `WebAssembly.validate()` |
| AudioWorklet | `"audioWorklet" in AudioContext.prototype` |
| OPFS | `navigator.storage.getDirectory` が存在し、Worker で `createSyncAccessHandle` が使える |
| ストレージの空き | `storage.estimate()` で 2 GB 以上の空き（不足なら W-ST-003 を出して続行） |
| 起動 URL | `location.origin === "http://localhost:5173"`。違う場合（`127.0.0.1` やポート違い）は W-BR-002 を出す。ブラウザ内のデータは URL ごとに分かれるため、別の URL で開くと保存済みのプロジェクトが見えない |

### 16.1 S-01 ホーム

- ボタン：「シングルを作成」「アルバムを作成」「プロジェクトファイルを開く」。ブラウザ内に保存されたプロジェクトの一覧（更新日時順。サムネイル波形、曲数、容量、削除ボタン付き）。
- 画面全体がドロップ領域。1ファイルをドロップ → シングル、複数ファイル → 「アルバムとして作成しますか？／ステムとして読み込みますか？」を確認する。「ファイルを選択」ボタン（`<input type="file" multiple accept="audio/*,.wav,.aif,.aiff,.flac,.mp3,.m4a">`）も用意する。
- 取り込みの処理：I/O Worker が File を OPFS の `/sources/` にコピーしながら sha256 を計算する（ストリーミング）。完了したら DSP Worker がデコードして C0 を作り、解析する。
- ステムかどうかの判定：同じ長さ（±1 サンプル）で、ファイル名に `vocals|drums|bass|other|instrumental|backing|synth|guitar|piano` などを含む場合に「ステムの可能性あり」とする。
- `storage.persist()` が拒否された場合は、バナーで「ブラウザのデータが自動削除される可能性があります。大事なプロジェクトはファイルに書き出してください」と案内する。

### 16.2 S-02 解析サマリー

- 取り込みが終わったら自動で解析し、カードで表示する：

| カード | 表示の例 |
|---|---|
| 音圧 | `−17.8 LUFS` / TP `−0.3 dBTP` / PLR `17.5` |
| シャリシャリ感（Shimmer） | メーター 0〜100 ＋ 段階（弱 < 30 ≤ 中 < 60 ≤ 強） |
| ヒス | 段階 |
| 耳障りな高域（Fizz） | 段階 |
| こもり（Mud） | 段階 ＋ 中心周波数 |
| ステレオ | 相関の平均、モノラル互換性 |
| 帯域 | 「16.2 kHz より上が欠けています」（該当時のみ） |
| 入力形式 | 「MP3 です。WAV での書き出しをおすすめします」（該当時のみ） |

- ボタン：「Auto Master」（主ボタン）、「手動で始める」。ジャンル選択（既定 Auto）、ラウドネス目標の選択（既定 Streaming）。
- Auto Master が完了すると S-03 に移り、「提案された変更」パネルを表示する（変更理由の一覧。例：「シャリシャリ感が強いため Shimmer Reduction を 62% に設定」）。

### 16.3 S-03 マスタリング画面

- レイアウトは基本設計 10.4 のとおり。ウィンドウ幅が 1,280 px 未満のときは、メーターをマクロの下に回す。
- **モジュールパネル**（折りたたみ。タブで切り替え）：

| タブ | 主な表示 |
|---|---|
| Cleanup | サブモジュールごとに ON/OFF、amount、詳細パラメーター。「この処理だけを試聴（ソロ）」ボタン ＝ 処理前とクリーンアップ後の差分を Delta で再生する |
| EQ | 周波数特性のグラフ：平均スペクトル（Before/After）、目標カーブ（破線）、補正カーブ（実線）。手動バンドはグラフ上のノードをドラッグして調整 |
| Dynamics | 3バンドのクロスオーバー（グラフ上でドラッグ）、各バンドのパラメーター、GR メーター |
| Saturation | type、drive、mix |
| Stereo | width、monoBelowHz、ゴニオメーター、帯域ごとの幅のグラフ |
| Limiter | 目標 LUFS、ceiling、lookahead、release、character、GR の履歴 |

- 各タブの見出しにバイパス（⏻）トグルを置く。
- 「ソロ」の試聴では、比較の組み合わせを一時的に変える（例：Cleanup のソロでは C0 と C1 の差分を再生する）。そのための中間キャッシュ（C1）を再生用の共有メモリに読み込む。

### 16.4 S-04 アルバム画面

- 基本設計 10.5 のとおり。追加で次を設ける：
  - 「自動バランス」ボタン → 10.4 の処理（進捗はトラックごとに表示）
  - アルバム共通設定パネル：ジャンル、キャラクター、目標 LUFS（アンカー曲用）、ceiling、意図の保持率 `k`、トーンの揃え量
  - 行ごとに：相対オフセット（±6 dB、0.1 dB 単位）、フェードイン/アウト、ギャップ、「この曲を開く」
  - 「つなぎ目を確認」：選んだ境目の前後を再生する（10.5、12.6）
  - 「全曲を連続再生」：アルバムの順序・ギャップどおりに After をストリーミング再生する（12.6）

### 16.5 S-05 書き出し

| 項目 | 選択肢（既定） |
|---|---|
| 対象 | この曲 / アルバム全曲 / 選んだ曲 |
| 形式 | WAV（既定）/ AIFF / FLAC / MP3 / AAC（対応ブラウザのみ）。複数を同時に選べる |
| サンプルレート / ビット深度 | 44.1 kHz / 24 bit（既定）。16 bit を選ぶとディザが自動で有効になる |
| ファイル名ルール | `{track:02} {title}`（既定）。使える変数：`{track} {title} {artist} {album} {lufs}` |
| アルバム連続ファイル | ON/OFF ＋ CUE |
| レポート | JSON / CSV（任意） |
| 書き出し前のチェック | 基本設計 10.7 のとおり。警告があっても書き出せる（エラーの場合は不可） |

**保存方法（ブラウザごと）**：

| ブラウザ | 1ファイル | 複数ファイル（アルバム） |
|---|---|---|
| Chrome / Edge | `showSaveFilePicker()` で保存先を選び、書き込む | `showDirectoryPicker()` でフォルダーを選び、順に書き込む |
| Safari（・Firefox） | OPFS の `/tmp/` に作ったファイルを `getFile()` で取り出し、`<a download>` でダウンロード | OPFS の `/tmp/` に ZIP（無圧縮）を作り、同じ方法でダウンロード |

- OPFS 上の File はディスクに置かれたままなので、大きなファイルでもメモリを圧迫しない。
- `/tmp/` のファイルは、次回起動時またはプロジェクトを閉じたときに削除する。

### 16.6 S-06 設定

- オーディオ：出力デバイス（Chrome / Edge のみ）
- 表示：テーマ（ダーク/ライト/OS に合わせる）、言語、モード切り替えと波形表示の連動
- ストレージ：使用量と上限、永続化の状態（許可／未許可）、キャッシュの削除、プロジェクトごとの容量と削除
- 処理：内部サンプルレート、同時に動かす Worker の数（自動／1〜4）
- 診断：ログのダウンロード（19.2）、ブラウザの対応状況（16.0 の結果）
- ショートカット（P3）

---

## 17. データスキーマ

TypeScript の型で記載する（Rust 側は serde で同じ構造を定義する。`schemaVersion` で互換性を管理する）。

### 17.1 Project / Track

```ts
interface Project {
  schemaVersion: 1;
  id: string;                    // UUID v7
  name: string;
  type: "single" | "album";
  internalSampleRate: 48000;
  trackIds: string[];            // 曲順どおり
  album?: AlbumSettings;         // type = album のとき
  reference?: { sourceSha256: string; originalName: string; lufs: number };
  createdAt: string; updatedAt: string;
}
interface Track {
  projectId: string;
  id: string; title: string; artist?: string; isrc?: string;
  source: SourceRef;
  gapAfterSec: number;           // 既定 2.0
  crossfadeSec: number;          // 既定 0
  fadeIn:  { durationSec: number; curve: FadeCurve };
  fadeOut: { durationSec: number; curve: FadeCurve };
  overrides: Partial<ProcessingSettings>;
  autoBase?: { amounts: Record<string, number>; macro: number };   // 9.3 の基準値
}
type FadeCurve = "linear" | "equalPower" | "log" | "exp";
interface AlbumSettings {
  anchorTrackId: string | "auto";
  intentPreservation: number;    // k：0〜1、既定 0.5
  toneMatchAmount: number;       // 0〜1、既定 0.5
  common: Partial<ProcessingSettings>;
  cdFrameAlign: boolean;         // 既定 false
}
```

### 17.2 SourceRef

```ts
interface SourceRef {
  sha256: string;                // OPFS の /sources/<sha256>.<ext>
  ext: string; originalName: string; size: number;
  format: string; sampleRate: number; bitDepth?: number;
  channels: number; frames: number;
  stems?: { role: StemRole; sha256: string; originalName: string }[];
}
type StemRole = "vocals" | "drums" | "bass" | "other" | "instrumental" | "unknown";
```

### 17.3 ProcessingSettings（全パラメーター）

| パス | 型・範囲 | 既定 | 単位 |
|---|---|---|---|
| `macros.cleanup` | 0〜100 | 自動 | % |
| `macros.tone` | −100〜100 | 0 | — |
| `macros.punch` | 0〜100 | 40 | % |
| `macros.width` | 0〜150 | 100 | % |
| `macros.loudnessPreset` | `streaming / apple / loud / dynamic / custom` | streaming | — |
| `cleanup.enabled` | bool | true | |
| `cleanup.declick.enabled` | bool | 自動 | |
| `cleanup.declick.sensitivity` | 1〜10 | 5 | |
| `cleanup.dehiss.amount` | 0〜100 | 自動 | % |
| `cleanup.dehiss.fLow` | 4,000〜16,000 | 8,000 | Hz |
| `cleanup.dehiss.floorDb` | −24〜0 | −12 | dB |
| `cleanup.shimmer.amount` | 0〜100 | 自動 | % |
| `cleanup.shimmer.fLow` | 3,000〜10,000 | 6,000 | Hz |
| `cleanup.shimmer.fHigh` | 10,000〜20,000 | 16,000 | Hz |
| `cleanup.shimmer.thresholdDb` | 0〜6 | 1.5 | dB |
| `cleanup.shimmer.windowMs` | 40〜200 | 75 | ms |
| `cleanup.shimmer.transientProtect` | 0〜100 | 70 | % |
| `cleanup.resonance.amount` | 0〜100 | 自動 | % |
| `cleanup.resonance.fLow` | 1,000〜6,000 | 2,000 | Hz |
| `cleanup.resonance.fHigh` | 8,000〜16,000 | 12,000 | Hz |
| `cleanup.resonance.sharpness` | 1〜10 | 5 | |
| `cleanup.resonance.deessFocus` | 0〜100 | 50 | % |
| `cleanup.mud.amount` | 0〜100 | 自動 | % |
| `cleanup.mud.freq` | 150〜600 | 自動（300） | Hz |
| `cleanup.mud.q` | 0.5〜2.0 | 1.0 | |
| `cleanup.mud.maxCutDb` | 0〜9 | 6 | dB |
| `eq.enabled` | bool | true | |
| `eq.genre` | `auto / pop / rock / edm / hiphop / ballad / acoustic / jpop_anime` | auto | |
| `eq.toneMatch` | 0〜100 | 60 | % |
| `eq.maxCorrectionDb` | 1〜8 | 4 | dB |
| `eq.hpfHz` | 0（OFF）/ 20〜40 | 25 | Hz |
| `eq.bands[]` | 最大 6：`{type, freq 20〜20k, gainDb ±12, q 0.3〜10, enabled}` | [] | |
| `dynamics.enabled` | bool | true | |
| `dynamics.crossovers` | [60〜400, 1,000〜8,000] | [150, 3,000] | Hz |
| `dynamics.bands[3]` | `{thresholdDb −40〜0 または "auto", ratio 1〜4, attackMs 1〜100, releaseMs 30〜500}` | auto, 1.5/1.8/1.5, 30/20/10, 200/150/100 | |
| `dynamics.transient.amount` | 0〜100 | Punch に連動 | % |
| `saturation.enabled` | bool | false | |
| `saturation.type` | `clean / warm / tape` | warm | |
| `saturation.drive` | 0〜100 | 20 | % |
| `saturation.mix` | 0〜100 | 100 | % |
| `stereo.enabled` | bool | true | |
| `stereo.width` | 0〜150 | 100 | % |
| `stereo.monoBelowHz` | 0（OFF）/ 60〜250 | 120 | Hz |
| `stereo.guard` | bool | true | |
| `limiter.targetLufs` | −24〜−6 | −14 | LUFS |
| `limiter.targetMode` | `integrated / l95` | integrated（アルバムの非アンカー曲は l95） | |
| `limiter.ceilingDbtp` | −3.0〜−0.1 | −1.0 | dBTP |
| `limiter.lookaheadMs` | 0.5〜5 | 1.5 | ms |
| `limiter.release` | `"auto"` または 20〜500 | auto | ms |
| `limiter.character` | `transparent / punchy` | transparent | |
| `limiter.oversampling` | 4 / 8 | 4 | × |
| `album.toneOffset` | 計算値（読み取り専用）：61 点の dB | — | |
| `album.gainOffsetDb` | −6〜+6 | 0 | dB |

**ラウドネスプリセットの値**（基本設計 6.2）：streaming −14 / apple −16 / loud −10 / dynamic −17 / custom（任意）。ceiling はすべて −1.0 dBTP。

**キャラクタープリセット**（`presets/characters.json`）：

| キャラクター | 主な設定 |
|---|---|
| clean | 既定値のまま、saturation OFF |
| warm | tone −30、saturation warm 20%、limiter release 300 ms |
| bright | tone +35（ハイシェルフはクリーンアップの後に効く）、cleanup の各 amount ×1.1 |
| punch | punch 70、limiter character punchy |
| wide | width 125、monoBelowHz 140、guard ON |

### 17.4 AnalysisResult

```ts
interface AnalysisResult {
  key: string;                  // 対象バッファのキャッシュキー
  loudness: { integrated: number; lra: number; truePeak: number; samplePeak: number; plr: number; l95: number;
              momentary: Float32Array; shortTerm: Float32Array };   // 10 Hz
  spectrum: { freqs: number[]; db: number[] };                     // 61 点
  stereo: { correlationMean: number; monoLoudnessDrop: number; bandWidthDb: number[]; correlation: Float32Array };
  artifacts: { shimmerScore: number; hissLevelDb: number; fizzIndexDb: number; mudIndexDb: number; mudFreq: number;
               bandwidthCutoffHz: number | null; clickCount: number; transientDensity: number };
  sections: { startSec: number; endSec: number; level: "High" | "Mid" | "Low" }[];
  clipping: { count: number; positions: number[] };
  dcOffset: [number, number];
  warnings: WarningRef[];
}
```

- 時系列（Float32Array）は IndexedDB に構造化クローンでそのまま保存できる。

### 17.5 IndexedDB のスキーマ（DB 名 `akmaster`、version 1）

| ストア | キー | インデックス | 内容 |
|---|---|---|---|
| `projects` | `id` | `updatedAt` | Project |
| `tracks` | `[projectId, id]` | `projectId` | Track |
| `snapshots` | `id` | `[projectId, trackId]` | `{ id, projectId, trackId, name, settings, createdAt }` |
| `analyses` | `[projectId, trackId, which]` | `projectId` | AnalysisResult（which = before / after） |
| `cacheIndex` | `path` | `lastUsedAt`, `projectId` | `{ path, projectId, size, lastUsedAt, pinned }` |
| `prefs` | `key` | — | アプリ設定 |
| `logs` | 自動採番 | `ts` | ログ（19.2） |

- スキーマの変更は `onupgradeneeded` でマイグレーションする。

---

## 18. API・メッセージ仕様

### 18.1 Orchestrator の API（UI から呼ぶ。TypeScript）

| メソッド | 引数 | 戻り値 |
|---|---|---|
| `project.create` | `{type, name}` | `Promise<Project>` |
| `project.open` / `project.close` | `{id}` / — | `Promise<Project>` / `Promise<void>` |
| `project.list` / `project.delete` | — / `{id}` | `Promise<ProjectSummary[]>` / `Promise<void>` |
| `project.exportFile` | `{id, includeSources}` | `Promise<void>`（保存またはダウンロード） |
| `project.importFile` | `{file: File, mode?: "overwrite" | "duplicate"}` | `Promise<Project>` |
| `track.import` | `{files: File[], asStems?: boolean}` | `Promise<Track[]>` |
| `track.remove` / `track.reorder` / `track.updateMeta` | `{trackId}` / `{order}` / `{trackId, patch}` | `Promise<void>` |
| `settings.update` | `{trackId, patch, gestureId?}` | `void`（非同期でレンダリングされる） |
| `album.update` | `{patch}` | `void` |
| `jobs.analyze` / `jobs.autoMaster` / `jobs.renderFull` | `{trackId}` | `JobHandle` |
| `jobs.albumAutoBalance` | — | `JobHandle` |
| `jobs.cancel` | `{jobId}` | `void` |
| `snapshot.create` / `apply` / `delete` / `compare` | `{trackId, name}` / `{snapshotId}` / `{snapshotId}` / `{trackId, a, b}` | — |
| `reference.set` | `{file: File}` | `Promise<void>` |
| `transport.load` | `{trackId}` または `{album: true}` | `Promise<void>` |
| `transport.play` / `pause` / `seek(frame)` / `setMode(mode)` / `setLoop(range)` / `setOptions(opts)` | — | `void` |
| `transport.previewTransition` | `{fromTrackId}` | `Promise<void>` |
| `display.getPeaks` | `{trackId, source, channel, level, binStart, binCount}` | `Promise<Float32Array>` |
| `display.getSeries` | `{trackId, name: "gainDelta" | "loudnessSt" | "gr" | "markers", gainMatch?}` | `Promise<Float32Array | Marker[]>` |
| `display.getSpectralDelta` | `{trackId, gainMatch}` | `Promise<{cols, rows, data: Uint16Array}>`（float16） |
| `export.start` | `ExportOptions` | `JobHandle` |
| `storage.estimate` / `storage.clearCache` / `storage.requestPersist` | — | — |
| `prefs.get` / `prefs.set` | — | — |

`JobHandle = { id: string; done: Promise<Result>; onProgress(cb): Unsubscribe }`

`setOptions(opts)` の `opts`：`{ loudnessMatch?, deltaGainMatch?, matchScope?: "track" | "loop", platformSim?: "off" | "spotify" | "spotifyAlbum" | "apple" | "youtube", mono? }`

### 18.2 Orchestrator のイベント（UI が購読）

| イベント | ペイロード |
|---|---|
| `job_progress` | `{jobId, kind, trackId?, stage, fraction, etaSec?}`（最大 10 Hz） |
| `job_done` / `job_error` | `{jobId, result?}` / `{jobId, error: AppError}` |
| `after_updated` | `{trackId, range: [f0, f1], provisional: boolean}` |
| `analysis_ready` | `{trackId, which}` |
| `warnings_changed` | `{trackId, warnings: WarningRef[]}` |
| `worker_status` | `{workerId, state: "starting" | "ready" | "restarting" | "failed"}` |
| `storage_warning` | `{usage, quota, persisted}` |

※ 再生位置とメーターはイベントではなく共有メモリから読む（14.1）。

### 18.3 Worker メッセージプロトコル

```ts
// メイン → Worker
type Req = { kind: "req"; id: number; method: string; params: unknown; cancelIndex?: number };
// Worker → メイン
type Res = { kind: "res"; id: number; ok: true; result: unknown } | { kind: "res"; id: number; ok: false; error: AppError };
type Progress = { kind: "progress"; id: number; stage: string; fraction: number };
type Log = { kind: "log"; level: "debug" | "info" | "warn" | "error"; msg: string; ctx?: object };
```

- `cancelIndex`：キャンセルフラグ用の共有 Int32Array の位置。Worker は WASM にこのフラグを読む関数を渡す。
- 大きな結果（ピーク、区間の PCM など）は `postMessage(res, [buffer])` で転送する。

**DSP Worker のメソッド**：

| メソッド | params | result |
|---|---|---|
| `init` | `{wasmUrl, calibration?, cancelSab}` | `{engineVersion, simd: boolean}` |
| `analyze` | `{projectId, trackId, sourceSha256, which, inputKey?}` | `AnalysisResult` |
| `render` | `{projectId, trackId, sourceSha256, settings, albumContext?, range?}` | `{cacheKeys, appliedGainDb, provisional, pcm?（区間のとき）, analysisAfter?, displayKey?}` |
| `autoMaster` | `{projectId, trackId, sourceSha256, baseSettings, target}` | `{settings, reasons, cacheKeys, analysisAfter}` |
| `renderToC2` | `{projectId, trackId, sourceSha256, settings}` | `{cacheKeyC2, spectrum: number[]}`（アルバム用） |
| `albumTonePlan` | `{spectra: number[][], amount}` | `{reference: number[], offsets: number[][]}` |
| `renderTransition` | `{a, b, gapSec, crossfadeSec}` | `{pcm}` |
| `exportTrack` | `{projectId, trackId, cacheKeyC3, options}` | `{tmpPath, truePeakAfterEncode?}` |

**I/O Worker のメソッド**：

| メソッド | 内容 |
|---|---|
| `importSource` | `{file: File}` → OPFS にコピーし sha256 を返す |
| `loadIntoPool` | `{path, poolSab, tableSab}` → OPFS の `.akpcm` を ChunkPool に読み込む |
| `streamStart` / `streamSeek` / `streamStop` | ストリーミング再生（12.6） |
| `readPeaks` | `{path, level, ch, binStart, binCount}` → Float32Array |
| `zipCreate` / `zipExtract` | プロジェクトファイル、Safari 用のアルバム ZIP |
| `saveToHandle` | `{tmpPath, handle: FileSystemFileHandle}` → 保存先に書き込む（Chrome / Edge） |
| `cacheEvict` | `{paths}` |

### 18.4 エラーコード

| コード | 意味 | ユーザーへの表示（例） |
|---|---|---|
| E-BR-001 | ブラウザが必要な機能に対応していない | 「このブラウザでは使えません。最新の Chrome / Edge / Safari を使ってください」＋足りない機能 |
| E-IN-001 | ファイルが読めない | 「ファイルを読み込めませんでした（形式が未対応か、破損しています）」 |
| E-IN-002 | 対応していない形式 | 「この形式には対応していません。WAV/AIFF/FLAC/MP3/M4A を使ってください」 |
| E-IN-003 | ステムの長さ・レートが一致しない | 「ステムの長さが揃っていません」 |
| E-IN-004 | 3 チャンネル以上 | 「ステレオかモノラルの音源を使ってください」 |
| E-SRC-001 | 音源のデータがブラウザ内に見つからない | 「音源のデータが見つかりません（ブラウザのデータが削除された可能性があります）。もう一度音源を指定してください」 |
| E-ST-001 | ストレージの容量不足 | 「ブラウザの保存容量が足りません。設定画面でキャッシュや不要なプロジェクトを削除してください」 |
| E-WK-001 | Worker が異常終了した | 「処理を再開しています…」（自動で再起動） |
| E-WK-002 | WASM のメモリ不足 | 「メモリが足りませんでした。他のタブを閉じるか、同時に処理する曲数を減らしてください」 |
| E-RND-001 | レンダリングに失敗 | 「処理に失敗しました」＋詳細 |
| E-OUT-001 | 保存できない（ユーザーのキャンセル以外の失敗） | 「保存できませんでした」＋詳細 |
| E-AU-001 | 音声出力を開始できない | 「音声を再生できません。出力デバイスを確認してください」 |
| E-LK-001 | 別のタブで開いている | 「このプロジェクトは別のタブで開かれています（読み取り専用で表示しています）」 |

**警告・情報コード**：

| コード | 内容 |
|---|---|
| W-IN-001 | MP3/M4A が入力された |
| W-IN-002 | 入力がクリップしている |
| W-CL-001 | クリーンアップのかけすぎ（高域が 6 dB 以上減少） |
| W-ST-001 | ステレオのガードが働いた |
| W-ST-002 | ストレージの永続化が許可されなかった |
| W-ST-003 | ストレージの空きが少ない |
| W-LM-001 | 音圧の上げすぎ |
| W-LM-002 | TP を守るために最終手段を使った |
| W-OUT-001 | 非可逆形式で TP を超えた |
| W-BR-001 | このブラウザでは AAC で書き出せない |
| W-BR-002 | 決められた URL（`http://localhost:5173`）以外で開いている（保存済みのプロジェクトが表示されない） |
| W-AL-001 | アルバムのラウドネスの外れ |
| W-AL-002 | アンカーより大きい曲 |
| W-AL-003 | アルバムのトーンの外れ |
| I-AN-001 | 帯域の欠けを検出 |

---

## 19. エラー処理・ログ・復旧

### 19.1 方針

- **エラー**（E-）：処理を中止し、トーストまたはダイアログで「何が起きたか＋どうすればよいか」を表示する。
- **警告**（W-）：処理は続ける。該当する画面にバッジを表示し、書き出し前のチェックにも表示する。
- **情報**（I-）：解析サマリーに表示するだけ。
- ユーザーが保存ダイアログをキャンセルした場合（`AbortError`）はエラーとして扱わない。

### 19.2 ログ

- メモリ上のリングバッファ（直近 5,000 件）に記録し、1 分ごとに IndexedDB の `logs` ストアへ書き出す（直近 7 日分を保持）。
- 記録内容：ジョブの開始・終了・所要時間、エラーのスタック、エンジンのバージョン、ブラウザの情報（User-Agent、対応機能）、設定のハッシュ。**音声データは記録しない**。ファイル名は記録する。
- 外部へは送信しない。設定画面の「ログのダウンロード」で JSON Lines として保存でき、不具合の報告に使う。

### 19.3 Worker の監視

- Worker の `error` / `messageerror` イベント、または進捗の通知がないまま 120 s たったジョブを異常とみなし、Worker を終了して作り直す。
- 異常終了したときは、実行中だったジョブを 1 回だけ再実行する。2 回続けて失敗したら E-RND-001 にする。
- WASM のメモリ確保の失敗（`RangeError` やパニックメッセージ）は E-WK-002 として扱い、同時に動かす Worker の数を 1 減らして再実行する。

### 19.4 復旧（NFR-10）

- データの正本は IndexedDB と OPFS にあり、常に自動保存されているので、タブを閉じても再読み込みで元の状態に戻る（Undo の履歴だけは消える）。
- キャッシュは再生成できるので、壊れていたら（ヘッダーの検証に失敗したら）削除して作り直す。
- 起動時に `/tmp/` の残りファイルを削除する。
- `/sources/` の音源が見つからない場合（ブラウザによる削除など）は E-SRC-001 を出し、音源の再指定を求める（sha256 で同じファイルか確認する）。

---

## 20. ビルド・ローカル実行

### 20.1 ビルド

| 対象 | 手順 |
|---|---|
| WASM | `cargo build -p akdsp-wasm --target wasm32-unknown-unknown --release`（`RUSTFLAGS="-C target-feature=+simd128"`）→ `wasm-bindgen --target web` → `wasm-opt -O3` |
| Web アプリ | Vite でビルドする。Worker は `new Worker(new URL("./workers/dsp.worker.ts", import.meta.url), { type: "module" })`、Worklet は `audioWorklet.addModule(workletUrl)` で読み込む |
| サイズの目標 | WASM は gzip 後 3 MB 以下（ローカル実行なので読み込み時間の制約はゆるいが、起動の速さのため） |
| アセットの名前 | ファイル名にハッシュを付ける（更新後に古いファイルがブラウザのキャッシュに残らないようにする） |

### 20.2 ローカル実行

**必要な環境（初回のみ準備）**：

| ツール | 用途 | 導入方法の例 |
|---|---|---|
| Node.js（LTS） | Web アプリのビルドとローカルサーバー | 公式インストーラー、または Homebrew（`brew install node`） |
| Rust（stable） | DSP のビルド | rustup（`curl https://sh.rustup.rs -sSf \| sh`） |
| wasm32 ターゲット | WASM のビルド | `rustup target add wasm32-unknown-unknown` |
| wasm-bindgen-cli | WASM と JS をつなぐコードの生成 | `cargo install wasm-bindgen-cli`（`Cargo.lock` の wasm-bindgen と同じバージョン） |
| binaryen（wasm-opt） | WASM の最適化 | `brew install binaryen` |

**起動コマンド**：

| コマンド | 内容 | 用途 |
|---|---|---|
| `npm start` | WASM とアプリをビルドし、`vite preview` で `http://localhost:5173` を起動して、既定のブラウザで開く（`scripts/start.sh`） | **普段の利用**（最適化済みで速い） |
| `npm run dev` | 開発用サーバー（ホットリロード）。WASM は変更を検知して再ビルドする | 開発 |
| `npm run doctor` | 必要なツールとバージョンを確認し、足りないものを表示する | 初回・トラブル時 |

**Vite の設定（`vite.config.ts`）**：

```ts
import { securityHeaders } from "./security-headers";

export default defineConfig({
  server:  { host: "localhost", port: 5173, strictPort: true, headers: securityHeaders },
  preview: { host: "localhost", port: 5173, strictPort: true, headers: securityHeaders },
  // …
});
```

```ts
// security-headers.ts
export const securityHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; " +
    "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; " +
    "connect-src 'self' ws://localhost:5173; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
```

- **`host: "localhost"` と `strictPort: true`**：ブラウザ内のデータ（OPFS / IndexedDB）は「URL のオリジン」ごとに分かれるため、URL を `http://localhost:5173` に固定する。ポートが使用中なら別のポートに逃げずにエラーで止め、原因（すでに起動しているなど）を表示する。
- **外部からのアクセスを受け付けない**：`localhost` だけで待ち受けるので、同じネットワークの他の PC からは開けない。
- `connect-src 'self'` によって、アプリから外部への通信を CSP でも禁止する（NFR-09）。`ws://localhost:5173` は開発用サーバーのホットリロード用で、`npm start` では含めない。
- 開発用サーバー（`npm run dev`）では、CSP の `script-src` に Vite が必要とする設定を追加する（開発時のみ）。

**更新のしかた**：`git pull` → `npm start`（ビルドし直して起動する）。DSP のバージョンが変わるとキャッシュキーが変わるため、古いキャッシュは LRU で自然に消える。プロジェクトのデータ（IndexedDB / OPFS）はそのまま引き継がれる。

**チームで使う場合**：各メンバーがリポジトリを clone し、20.2 の手順で自分の Mac で起動する。プロジェクトの受け渡しは、プロジェクトファイル（13.5）で行う。

### 20.3 CI（GitHub Actions）

| ジョブ | 内容 | 実行するタイミング |
|---|---|---|
| rust | `cargo fmt --check`、`cargo clippy`、`cargo test`（ネイティブ） | push / PR |
| wasm | WASM のビルド、サイズの確認、T-WASM-01（ネイティブとの差） | push / PR |
| web | `tsc --noEmit`、ESLint、Vitest | push / PR |
| e2e | Playwright（Chromium と WebKit）で 21.4 のシナリオ。CI 上でもローカルと同じく `vite preview` を起動して実行する | PR |

### 20.4 ライセンス表記

- 同梱したライブラリのライセンス一覧（`cargo about` と `license-checker` で生成）を「このアプリについて」に表示する。LGPL の LAME は、使っているバージョンとソースの入手先を明記する。

### 20.5 将来の公開（現時点では実施しない）

チームで URL を共有して使いたくなった場合は、次の方法で公開できる。アプリはブラウザ内で完結しているので、**ビルド結果（`apps/web/dist`）を配置するだけ**で、設計の変更はほぼ不要。

| 項目 | 方法 |
|---|---|
| 配信 | Cloudflare Workers の静的アセット配信（2026 年時点で Cloudflare が新規プロジェクトに推奨。Pages も利用可能） |
| ヘッダー | `security-headers.ts` と同じ内容を `_headers` ファイルに書き出して配置する（ビルド時に自動生成する） |
| アクセス制限 | Cloudflare Access（Self-hosted アプリ。許可するメールアドレスの一覧、ワンタイム PIN でログイン。50 ユーザーまで無料） |
| 注意点 | 公開 URL はローカル（`localhost:5173`）とは別のオリジンになるため、ブラウザ内のデータは引き継がれない。移行はプロジェクトファイル（13.5）で行う |

---

## 21. テスト設計

### 21.1 DSP の単体テスト（Rust、`cargo test`。ネイティブで実行）

| ID | 内容 | 合格基準 |
|---|---|---|
| T-DSP-01 | 全ステージをバイパス | 出力が C0 とビット単位で一致 |
| T-DSP-02 | 各ステージの遅延補償 | インパルスを入れたとき、出力のピーク位置が入力と ±0 サンプル（リニアフェーズ FIR）／±1 サンプル以内（その他） |
| T-DSP-03 | ラウドネス計測 | EBU Tech 3341 / 3342 のテスト信号で ±0.1 LU（LRA は ±1 LU） |
| T-DSP-04 | True Peak 計測 | ITU-R BS.1770 の True Peak テスト信号で ±0.2 dB |
| T-DSP-05 | リミッターの TP 保証 | ランダムな音楽・ノイズ・正弦波の掃引（proptest で生成）で、出力の TP（8倍 OS）≤ ceiling |
| T-DSP-06 | ラウドネスの目標合わせ | 目標 −8〜−20 LUFS で、誤差 ±0.5 LU 以内（シングル）。アルバムの L95 は ±1.0 LU 以内 |
| T-DSP-07 | STFT の完全再構成 | マスクがすべて 1 のとき、誤差 −120 dBFS 以下 |
| T-DSP-08 | Shimmer Reduction の選択性 | 合成信号（定常な正弦波＋高域の揺らぎノイズ）で、揺らぎ成分が 6 dB 以上減少し、正弦波の変化は 0.5 dB 以内 |
| T-DSP-09 | トランジェント保護 | スネアのサンプルで、transientProtect 100% のときアタック部（最初の 10 ms）のピークの変化が 1 dB 以内 |
| T-DSP-10 | LR4 クロスオーバー | 3 バンドを合成したときの振幅特性が平坦（±0.1 dB） |
| T-DSP-11 | 区間レンダリングの一致 | 区間と全体のレンダリングの差が −60 dBFS 以下（暫定ゲインの影響を除く） |
| T-DSP-12 | 再現性 | 同じ入力・設定で2回レンダリングし、ビット単位で一致 |
| T-DSP-13 | SRC 後の TP | 48k → 44.1k の後も TP ≤ ceiling |
| T-DSP-14 | デコーダー | WAV 16/24/32f、AIFF、FLAC、MP3、M4A のテストファイルを読み、参照値との差が規定内 |
| T-ANA-01 | アーティファクト指標 | ゴールデンセットのラベル（試聴者の評価：弱/中/強）と Shimmer Score の段階の一致率 ≥ 70%（要較正） |
| T-ALB-01 | アルバムバランス | 合成アルバム（同じ曲を −6 / −3 / 0 dB に変えた 3 曲）で、k = 0 のとき処理後の L95 の差が ±0.5 LU 以内 |

### 21.2 WASM・ブラウザのテスト

| ID | 内容 | 合格基準 |
|---|---|---|
| T-WASM-01 | ネイティブと WASM の出力の差 | 同じ入力・設定で、差が −100 dBFS 以下 |
| T-WASM-02 | WASM のメモリ | 6分の曲の全体レンダリングで、WASM メモリのピークが 1 GB 以下 |
| T-PLAY-01 | 出力式（12.3）とクロスフェード | Worklet のミックス関数を純粋関数として切り出し、Vitest で検証。切り替え時の不連続（隣接サンプルの差）が、入力信号の最大差の 1.1 倍以内 |
| T-PLAY-02 | スロットの差し替え | Playwright（Chromium / WebKit）で、再生中に 1,000 回差し替えても、音の欠落（無音のクォンタム）が出ない |
| T-PLAY-03 | ゲイン計算 | Loudness Match / Platform Sim の各ゲインが仕様どおり（Vitest） |
| T-ST-01 | IndexedDB / OPFS | 保存 → 再読み込みで内容が一致。古い schemaVersion からのマイグレーション |
| T-ST-02 | プロジェクトファイル | 書き出し → 別のプロファイルで読み込み → 設定・解析結果が一致 |
| T-CUE-01 | CUE の生成 | 時刻の換算（mm:ss:ff）が正しく、CD フレームに揃っている |

### 21.3 UI のテスト（Vitest）

- ストア：Undo/Redo（ジェスチャー単位でまとまる）、設定のマージ（album.common ＋ overrides）。
- 波形：`levelFor()`、dB 軸の変換、ビューポートの計算、ピラミッドの再集約。
- 部品：Knob のキー操作と ARIA 属性。

### 21.4 E2E テスト（Playwright：Chromium と WebKit）

| シナリオ | 確認内容 |
|---|---|
| E2E-01 シングルの基本経路 | テスト音源をドロップ → 解析サマリー → Auto Master → 書き出し（WAV）→ ダウンロードしたファイルを `akdsp-cli analyze` で計測し、LUFS と TP が目標どおり |
| E2E-02 A/B と波形 | 再生 → `1/2/3` で切り替え → 再生位置が変わらない。レイアウトを3種類切り替えて、スクリーンショットを比較 |
| E2E-03 アルバム | 3曲を取り込み → 自動バランス → 警告がない → アルバム ZIP を書き出し |
| E2E-04 復旧 | 設定を変える → ページを再読み込み → 設定が残っている |
| E2E-05 プロジェクトファイル | 書き出し → 削除 → 読み込み → 同じ状態に戻る |

- Playwright の WebKit は Safari と完全に同じではないため、リリース前に**実機の Safari で手動チェックリスト**（`apps/web/e2e/safari-checklist.md`）を実施する。

### 21.5 ゴールデンテスト

- 対象：Suno の楽曲 15 曲（v5.5 を 5 曲、v6 を 10 曲。ジャンルを分散）。ユーザーが用意し、リポジトリの外（`AKM_GOLDEN_DIR`）に置く。
- `akdsp-cli` でネイティブ実行する（速いので、CI ではなく開発者の Mac で実行する）。
- 記録する指標：処理前後の LUFS、TP、LRA、PLR、Shimmer Score、Hiss、Fizz、Mud、高域エネルギーの変化。
- 前回の結果からの変化が閾値（LUFS ±0.3 LU、Shimmer Score ±5）を超えたら失敗とし、意図した変更なら基準を更新する。

### 21.6 試聴評価

- P0 と P1 の終わりに、ラウドネスを揃えたブラインド A/B テスト（ABX 形式。Suno の原音 / 本ツール / 比較対象（Logic の Mastering Assistant など））を行う。
- 評価項目：シャリシャリ感、明瞭さ、パンチ、全体の好み（5 段階）。結果をもとに、9.2 の規則表と calibration.json を調整する。

### 21.7 性能テスト

| ID | 内容 | 目標 |
|---|---|---|
| T-PERF-01 | 4分の曲の全体レンダリング（M1） | Chrome 30 s 以内 / Safari 45 s 以内 |
| T-PERF-02 | 30 s の区間をレンダリング（クリーンアップを変更した場合） | Chrome 1.0 s 以内 / Safari 1.5 s 以内 |
| T-PERF-03 | モード切り替えの遅延 | 60 ms 以内 |
| T-PERF-04 | 波形のズーム・スクロール | 60 fps を保つ（フレーム時間の 95 パーセンタイルが 16.7 ms 以内） |
| T-PERF-05 | 12 曲のアルバムの自動バランス（M1） | Chrome 5 分以内 / Safari 8 分以内 |
| T-PERF-06 | 100 MB の音源の取り込み（OPFS へのコピー＋sha256） | 3 s 以内 |

---

## 22. P0（技術検証）項目と合格基準

| # | 検証項目 | 合格基準 | 不合格だった場合の代替案 |
|---|---|---|---|
| P0-1 | Rust→WASM の処理速度（クリーンアップ、リミッター、FIR） | 4分の曲のクリーンアップが Chrome 9 s / Safari 13 s 以内 | hop を 1024 に広げる。WASM Threads（rayon）でチャンクを並列化する |
| P0-2 | AudioWorklet での A/B 同期再生とスロットの差し替え | T-PLAY-01/02 と T-PERF-03 に合格し、聴感上クリックがない（Chrome / Safari） | クロスフェードを長くする（20 ms）。差し替えを再生位置から離れた区間に限る |
| P0-3 | 波形描画の性能 | T-PERF-04 に合格（3 レーン、4分の曲、Chrome / Safari） | 波形も WebGL2 で描く |
| P0-4 | Shimmer Reduction の試作と試聴（Python で試作 → Rust に移植） | ゴールデンセットの 70% 以上で「シャリシャリ感が減った」と評価され、かつ「こもった」という評価が 20% 以下 | アルゴリズムを見直す（7.5 のパラメーター、または ML 方式を前倒しで検討） |
| P0-5 | OPFS の読み書き | 100 MB の書き込み 2 s 以内、読み込み 1 s 以内（Chrome / Safari）。`persist()` の挙動を記録 | キャッシュ点を減らす（C2 を省く） |
| P0-6 | 区間レンダリングの体感 | パラメーター変更から試聴まで 1 s 以内（T-PERF-02） | 区間を 15 s に縮める |
| P0-7 | ローカル実行環境 | `npm start` で起動した `http://localhost:5173` で、3 ブラウザとも `crossOriginIsolated === true`。`npm run doctor` が足りないツールを正しく案内できる | ヘッダーの設定を見直す。Safari で問題があれば、自己署名証明書による `https://localhost` を検討する |
| P0-8 | Suno 書き出し形式の確認 | v6 の WAV・ステムのサンプルレート・ビット深度・長さを実ファイルで確認し、基本設計書 12章（入出力仕様）と食い違いがない | 仕様を修正する |
| P0-9 | Safari のメモリ | 12 曲のアルバムの自動バランスをタブが落ちずに完走する。ピークのメモリ使用量を記録 | 同時に処理する曲数を 1 に固定し、表示中の曲以外の再生バッファを解放する |
| P0-10 | エンコーダー | MP3（LAME の WASM ビルド）の選定と速度（4分の曲 5 s 以内）。Safari の WebCodecs で AAC をエンコードできるか | AAC は Chrome / Edge 限定にする |
| P0-11 | WebGL2 の `R16F` テクスチャ（Safari） | フィルタリング付きで表示できる | `R8` に量子化する（15.5） |

P0 の結果は `docs/04_p0_report.md` にまとめ、本書に反映する（必要なら版を上げる）。

---

## 23. 要件トレーサビリティ

| 要件 | 本書の該当箇所 |
|---|---|
| FR-01 / FR-02 | 13.1, 16.1, 17.1, 18.1 |
| FR-03 | 6章 |
| FR-04 | 9章, 16.2 |
| FR-05 | 7章 |
| FR-06 | 8章 |
| FR-07 | 8.2（Tone）, 8.3（Punch）, 8.5（Width）, 9.3（Cleanup）, 17.3 |
| FR-08 | 16.3, 17.3 |
| FR-09 | 10.1〜10.4 |
| FR-10 | 10.5, 15.8, 16.4 |
| FR-11 | 12.3, 12.4 |
| FR-12 | 12.3（Delta） |
| FR-13 | 15.1〜15.4 |
| FR-14 | 11.1〜11.3, 15.5 |
| FR-15 | 12.7, 16.3 |
| FR-16 | 12.3（Reference）, 17.1 |
| FR-17 | 12.3（Platform Sim） |
| FR-18 | 18.1（snapshot.*）, 13.2 |
| FR-19 | 8.2（ジャンル）, 17.3（キャラクター・ラウドネス） |
| FR-20 | 8.7, 10.5, 16.5 |
| FR-21 | 16.5（レポート） |
| FR-22 / FR-23 | 17.2（stems）。処理の詳細は P4 の着手時に本書へ追記する |
| NFR-01〜04 | 5.6, 4.5, 12.4, 15.7, 21.7 |
| NFR-05 / 06 | 8.6, 8.7, T-DSP-05/13 |
| NFR-07 | 4.5, 5.5, T-DSP-12, T-WASM-01 |
| NFR-08 | 16.1（元ファイルは読むだけで、OPFS にコピーする） |
| NFR-09 | 3章（ブラウザ内で完結）, 19.2（ログを送信しない）, 20.2（localhost のみで待ち受け、CSP の connect-src 'self'） |
| NFR-10 | 13.1, 19.4 |
| NFR-11 | 16.1 → 16.2（Auto Master）→ 16.5：ドロップ → Auto Master → 書き出し |
| NFR-12 | 14.4, 14.5, 15.5 |
| NFR-13 | 5.2 |
| NFR-14 | 3.1, 16.0, 16.5（保存方法の差）, 21.4 |
| NFR-15 | 4.6, 12.6, T-WASM-02, P0-9 |
| NFR-16 | 3.3（外部リソースなし）, 20.2（ローカル実行） |

---

## 24. 未決事項

| # | 内容 | 決める時期 |
|---|---|---|
| U1 | (要較正) の各値（Shimmer Score の閾値、9.2 の規則表、ダイナミクスのしきい値など） | P0〜P1（ゴールデンセットの試聴） |
| U2 | ジャンル目標カーブの作り方（市販曲の平均スペクトルから作るか、手作業で作るか）。市販曲を使う場合、測定値（スペクトルの統計値）だけを保存し、音源は保存しない | P1 開始時 |
| U3 | ゴールデンセットの楽曲の提供（ユーザーに依頼） | P0 開始時 |
| U4 | アプリの正式名称とアイコン | P1 終了まで |
| U5 | 将来チームに公開するかどうか、その時期（公開する場合の方法は 20.5） | 必要になった時点 |
| U6 | P4（ステム分離・帯域拡張）で使う学習済み重みのライセンスと、ブラウザで動かせるサイズ・速度か | P4 開始時 |
