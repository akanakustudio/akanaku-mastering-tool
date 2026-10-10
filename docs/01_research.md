# 01. リサーチ資料：Suno生成楽曲のマスタリング

- 文書種別：開発資料（リサーチ）
- 作成日：2026-10-11
- 対象：akanaku-mastering-tool 開発メンバー
- 位置づけ：基本設計書（[02_basic_design.md](02_basic_design.md)）の根拠資料

---

## 1. 要約（TL;DR）

1. **Suno楽曲は「普通のミックス」ではなく「生成時に劣化した音源」として扱う。** 一般的なマスタリング（EQ→コンプ→リミッター）をそのまま当てると、高域のシャリシャリ感（メタリック・シマー）やヒスがかえって強調される。**「修復（Restoration）→ マスタリング」の順番**が業界の共通認識。
2. Suno最新は **v6 ファミリー（2026-09-09 リリース：v6 / v6-wild / v6-mini）**。音質は向上したが、生成由来のアーティファクト層（スペクトル上の痕跡、位相関係）は v5.5 から本質的に残っているとされる。
3. 書き出しは **WAV 48kHz/16bit（通常）**、Premier の Studio からは **32bit/48kHz のマルチトラック・ステム**、Pro/Premier で最大12ステム（44.1kHz）。**ステム入力に対応すると処理品質が大きく上がる**。
4. ラウドネスは **-14 LUFS（Spotify/YouTube/Amazon/Tidal）、約-16 LUFS（Apple Music）、True Peak -1.0 dBTP** が実務上の基準。Spotify は**アルバム再生時はアルバム単位で正規化**するため、アルバム内の曲間の音量差は保たれる＝アルバムの相対バランス設計が重要。
5. 既存ツールは「汎用マスタリング（Logic Mastering Assistant / Ozone 12 / LANDR等）」と「Suno修復特化（Sunofix等のWebサービス）」に二分されていて、**両方を1つのローカルアプリで、しかもアルバム単位で扱えるツールは見当たらない**。ここが本ツールの差別化ポイント。
6. OSSは部品が揃っている：DSP（pedalboard / scipy）、ラウドネス（pyloudnorm / ffmpeg loudnorm）、リファレンスマッチング（Matchering）、音源分離（Mel-Band RoFormer / BS-RoFormer）、圧縮音源修復（Apollo）、帯域拡張（AudioSR）、波形UI（wavesurfer.js v7）。**ライセンス（GPL系）には注意が必要**。

---

## 2. マスタリングの基礎（本ツールに必要な範囲）

### 2.1 マスタリングの目的

| 目的 | 内容 | 主な手段 |
|---|---|---|
| トーンバランス | 再生環境を問わずバランスよく聞こえる周波数特性に整える | EQ（リニアフェーズ/ダイナミック）、トーンマッチング |
| ダイナミクス | 抑揚を保ちつつ密度とまとまりを出す | コンプレッサー、マルチバンドコンプ、トランジェント処理 |
| ステレオイメージ | 広がりとモノラル互換性の両立 | M/S処理、低域モノラル化、幅調整 |
| ラウドネス | 配信基準に対して最適な音圧にする | トゥルーピーク・リミッター |
| 一貫性（アルバム） | 曲間で音量感・音色感が揃っている | 曲間ゲイン調整、トーンの揃え、曲順・曲間・フェード |
| 納品形式 | フォーマット変換・品質保持 | SRC（サンプルレート変換）、ディザ、メタデータ |

### 2.2 標準的な信号チェーン

```
入力 → (修復) → 補正EQ → コンプ/マルチバンド → (サチュレーション) → ステレオ処理 → リミッター → ディザ/SRC → 出力
```

- 内部処理は 32/64bit float。ビット深度を落とすのは最終段だけにし、その際 TPDF ディザを入れる。
- リミッターはオーバーサンプリング付きの **True Peak リミッター** を使う（配信時の非可逆圧縮でインターサンプルピークが起きないように）。

### 2.3 計測指標（ITU-R BS.1770 / EBU R128）

| 指標 | 意味 | 本ツールでの用途 |
|---|---|---|
| Integrated LUFS | 曲全体の平均ラウドネス | 目標値への調整、アルバムの揃え |
| Short-term LUFS（3秒） | 短時間ラウドネス | 波形上のラウドネス曲線、サビ同士の比較 |
| Momentary LUFS（400ms） | 瞬間ラウドネス | リアルタイムメーター |
| LRA | ラウドネスレンジ | 抑揚の潰れ具合の評価 |
| True Peak (dBTP) | インターサンプルピーク込みの最大値 | 上限 -1.0 dBTP の保証 |
| PLR / PSR | ピーク対ラウドネス比 | 音圧の上げすぎ（潰しすぎ）の検知 |
| 相関係数 / ゴニオメーター | 位相の整合 | モノラル互換性チェック（Suno の疑似ステレオ対策） |

### 2.4 配信プラットフォームのラウドネス基準（2026年時点）

| プラットフォーム | 正規化ターゲット | 備考 |
|---|---|---|
| Spotify | -14 LUFS | 小さい曲は持ち上げる（ヘッドルームを考慮）。**アルバム再生時はアルバム単位で正規化** |
| Apple Music | 約 -16 LUFS | Sound Check は下げる方向のみ |
| YouTube | -14 LUFS | 下げる方向のみ |
| Amazon Music | -14 LUFS | True Peak -2 dBTP を推奨する情報あり |
| Tidal / Deezer | -14 / -14〜-15 LUFS | |

**設計への示唆**
- -14 LUFS を「必ず守る値」と考える必要はない。ジャンルによっては -9〜-11 LUFS で作り込むのも一般的。ただ、大きすぎる音源は配信先で下げられるので、潰した分だけ損をする。
- そのため **「配信プリセット（-14 / -16）」「ラウド（-10前後）」「カスタム」** の3系統を用意し、**配信先で正規化された後にどう聞こえるかのシミュレーション**を出すのが効果的。

### 2.5 シングルとアルバムの違い

| 観点 | シングル | アルバム |
|---|---|---|
| 目標 | その曲単体で最適化 | アルバム全体で一貫させる。曲ごとの抑揚（バラードは小さく等）は意図どおり残す |
| ラウドネス | 目標 LUFS に合わせる | 「アンカー曲」（最も大きい曲）を基準にして、相対差を設計する |
| トーン | 曲ごとに最適化 | アルバム平均のトーンに近づける（ただし個性は残す） |
| 作業方法 | 1曲ずつ | **全曲を同じセッションで並べて比較しながら**（耳の基準がぶれないようにする） |
| 付帯作業 | なし | 曲順、曲間（通常2〜4秒。曲の流れに合わせて調整）、フェード、クロスフェード、CD用の DDP/CUE |

---

## 3. Suno生成楽曲に特有の問題

### 3.1 アーティファクトの分類

| # | 症状 | 聞こえ方 | 帯域・特徴 | 原因（推定） |
|---|---|---|---|---|
| A1 | **メタリック・シマー** | ガラスっぽい・水っぽい・「アルミ缶をこする」ような質感。ボーカル、シンバル、リバーブの残響部分に出る | 主に 6〜16kHz。時間方向に揺らぐ（ゆらぎ、粒状感） | ニューラルコーデック／ボコーダーによる合成の痕跡 |
| A2 | **デジタル・フィズ** | ハイハットや歯擦音（サ行）のジリジリ感 | 5〜8kHz | 生成アルゴリズム由来 |
| A3 | **高域ヒス／ノイズ** | 書き出したファイルに乗る高域のサー音 | 10kHz 以上が広く持ち上がる | 生成由来のノイズフロア |
| A4 | **クラックル／ポップ** | ボーカルやシンバルにパチパチ音 | 突発的な広帯域ノイズ | 生成のつなぎ目、クリップ |
| A5 | **歯擦音の歪み** | 「スー」にノイズが混じる | 5〜10kHz | A1・A2 の複合 |
| A6 | **低中域のこもり** | 箱っぽい、詰まった感じ（小型スピーカーで目立つ） | 200〜800Hz（中心 400〜500Hz） | 楽器同士が同じ帯域で重なる |
| A7 | **潰れたダイナミクス** | トランジェント（音の立ち上がり）が弱く、パンチがない | 全帯域 | 生成時点ですでにコンプがかかったような出力 |
| A8 | **疑似ステレオ** | モノラルにすると音が痩せる・消える。低域が不安定 | 位相差で作った広がり | 生成モデルのステレオ表現 |
| A9 | **帯域の欠け** | 高域が不自然に途切れる・こもる | ある周波数より上がない（スペクトルの急な落ち込み） | 生成・エンコード時の帯域制限 |
| A10 | **ボーカル音色の不安定さ** | 伸ばした音がうなる・ホロー（中が抜けた感じ）・キーキーする | ボーカル帯域 | 生成の不安定さ |

### 3.2 業界で一般的な対処の流れ

1. 最新モデルで生成し、**WAV で書き出す**（MP3 は使わない）
2. **修復（Restoration）**：シマー低減、ヒス除去、帯域の再構築。強さは 50〜70% 程度が目安とされる
3. 必要なら **ステム分離**して、問題のあるパート（ボーカル・シンバル）だけを処理する
4. 軽いミックス調整
5. マスタリング（EQ → ダイナミクス → リミッター）

### 3.3 典型的な補正値（出発点として）

| 対象 | 処理 | 値の目安 |
|---|---|---|
| 低中域のこもり（A6） | ダイナミック EQ でカット | 200〜500Hz、-3〜-5 dB、Q 中程度 |
| フィズ（A2） | カットまたはディエッサー | 6kHz 付近 -2〜-3 dB、ディエッサー 5〜8kHz |
| 高域ハッシュ（A3） | 緩やかなシェルビング | 14〜16kHz を緩やかに下げる |
| 目標ラウドネス | リミッター | -14〜-11 LUFS、-1 dBTP |

### 3.4 設計上の重要な示唆

- **普通の「明るくする」EQ は逆効果**になる（A1〜A3 が持ち上がるため）。高域を持ち上げるのは、修復の後でダイナミックに行う。
- **リミッターで音圧を上げると A1 がより目立つ**。修復の強さとラウドネス目標は連動させて考える必要がある（例：ラウドプリセットのときは修復を強める）。
- A1 は「時間方向に揺らぐ高域の成分」という特徴があるので、**STFT の高域で時間方向のスムージング／揺らぎ抑制**を行う方法が有効と考えられる（トランジェントは保護する）。
- A8 への対処として、**低域（〜120Hz）のモノラル化**と**相関係数の監視**は必須。
- **ステム入力（Suno Studio の書き出し、またはツール内での分離）** があると、ボーカル・シンバルだけに修復をかけられるので副作用が少ない。

---

## 4. 既存ツールの調査

### 4.1 DAW 内蔵：Logic Pro Mastering Assistant

- 10.8（2023）で追加。最新の **Logic Pro 12** では Transparent モードが 192kHz に対応。
- ミックスを解析して、EQ カーブ・ダイナミクス・ラウドネスを提案する。
- キャラクターは **Clean / Transparent / Valve / Punch** から選ぶ。
- ラウドネスのノブ、ステレオ幅、**LUFS メーター、相関メーター**付き。
- **UX から学べる点**：解析 → 提案 → 少数のマクロで微調整、という流れ。提案した EQ カーブが目に見えること。キャラクターを「名前」で選べること。
- **足りない点**：Suno 特有のアーティファクト対策がない。アルバム単位で揃える機能がない。前後の差分を波形で見る機能がない。

### 4.2 プラグイン

| 製品 | 特徴 | 参考になる点 |
|---|---|---|
| **iZotope Ozone 12**（2025-09） | 20モジュール。**Stem EQ**（ステレオ音源の中のボーカル/ドラム/ベース等に個別に EQ）、**Unlimiter**（潰れたダイナミクスの復元）、**Bass Control**（ML による低域の安定化）、IRC 5 Maximizer、カスタマイズ可能な Master Assistant | Stem EQ と Unlimiter は Suno 対策（A7・A10）と直接対応する。Assistant → モジュール単位で調整、という2層構造 |
| **iZotope RX** | スペクトル修復（De-noise、De-click、De-clip、Spectral Repair） | 修復処理とスペクトログラム上での編集の UX |
| **FabFilter Pro-Q 4 / Pro-L 2 / Pro-MB / Pro-C** | 定番の EQ・リミッター・マルチバンド。Pro-L 2 は詳細なラウドネスメーター付き | EQ カーブの直接操作、リミッターのゲインリダクション履歴表示 |
| **Soundtheory Gullfoss** | 聴覚モデルによる自動トーン補正（Master 版あり） | 「マスキングの自動解消」という考え方。パラメーターがごく少ない |
| **oeksound soothe2**（参考） | ダイナミックなレゾナンス抑制 | シマー・歯擦音（A1・A5）対策のアルゴリズムとして参考になる |

### 4.3 AI マスタリングサービス

| サービス | 価格帯 | 特徴 |
|---|---|---|
| LANDR | 約 $4/曲〜 | 老舗。配信機能と一体。ポップ/EDM/ヒップホップに強い。アコースティック系は音圧が強すぎる傾向 |
| eMastered | 約 $15/月 | キャラクタープリセット（Warm/Open/Punch）。リファレンス曲マッチング |
| BandLab Mastering | 無料 | プリセットを選ぶだけ。初心者向け |
| RoEx Automix | $9.99/月 | 最大32ステムのミックス/マスタリング |
| Masterchannel | — | 新しめの選択肢 |
| **Sunofix など Suno 特化** | — | シマー、ロボット感、耳に痛い高域の除去に特化。アレンジは維持したまま |

**共通する課題**：クラウドへのアップロードが必要、中身がブラックボックス、アルバム単位の一貫性処理が弱い、前後の比較が「再生して聞き比べる」だけ。

### 4.4 OSS・ライブラリ

| 分類 | 名称 | 概要 | ライセンス（要再確認） |
|---|---|---|---|
| DSP 全般 | **pedalboard**（Spotify） | Python のエフェクト処理・ファイル入出力・VST3/AU ホスト。高速（JUCE ベース） | **GPL-3.0** |
| DSP 全般 | numpy / scipy | STFT、フィルター設計 | BSD |
| ラウドネス | **pyloudnorm** | BS.1770 準拠の LUFS 計測 | MIT |
| ラウドネス | FFmpeg `loudnorm` / `ebur128` | 計測・正規化・SRC | LGPL/GPL |
| リファレンスマッチング | **Matchering 2.0** | リファレンス曲の RMS・周波数特性・ピーク・ステレオ幅に合わせる | **GPL-3.0** |
| 音源分離 | **Mel-Band RoFormer / BS-RoFormer** | 現時点で最高水準の音源分離（SDX23 で1位） | 実装は MIT 等。**学習済み重みは個別に確認** |
| 音源分離 | python-audio-separator / Demucs | 分離モデルを手軽に呼び出せるラッパー | MIT |
| 圧縮音源の修復 | **Apollo** | 帯域分割モデル（GAN）。低ビットレート MP3 をロスレスに近い品質へ | 要確認 |
| 帯域拡張 | **AudioSR** | 拡散モデルによる高域の再生成。Suno 修復の事例でも使われている | 要確認。処理が重い |
| 研究 | Diff-MST / DeepAFx-ST / ITO-Master | 微分可能なエフェクトでリファレンスからパラメーターを推定する | 研究用途 |
| 波形 UI | **wavesurfer.js v7** | TypeScript。Regions / Timeline / Minimap / Spectrogram プラグイン | BSD-3 |
| リアルタイム音声 | cpal + rtrb（Rust） | 低レイテンシの音声出力、ロックフリーのリングバッファ | Apache/MIT |

> **ライセンス上の注意**：pedalboard と Matchering は GPL-3.0。**配布形態（個人利用か、クローズドソースで配布するか）によっては採用できない**。基本設計書の「レビュー論点」にも挙げている。

### 4.5 アプリの技術基盤

| 選択肢 | 長所 | 短所 |
|---|---|---|
| **Tauri 2 + Web UI + ネイティブ/サイドカーのエンジン** | 軽い。Web 技術で凝った波形 UI が作れる。Rust で音声 I/O（cpal）。採用事例が増えている（WebView + Rust Audio） | Python ML を同梱するとサイズが大きくなる |
| Electron + Web UI | エコシステムが成熟 | 重い |
| JUCE 8（WebView UI 対応） | プロ用オーディオの定番。プラグイン化もしやすい | C++。ML の統合は手間がかかる |
| Web アプリ（ブラウザ＋サーバー） | 配布が簡単 | 大きな WAV のアップロード、プライバシー、オフラインで使えない |

---

## 5. UX/UI 調査のまとめ（音楽制作の流れに合わせる）

### 5.1 制作者の作業の流れ

```
Suno で生成・選曲 → WAV/ステムを書き出し → 取り込み → 状態確認（どこが悪いか）
→ 修復 → マスタリング → 比較試聴（前後・リファレンス） → 微調整 → 書き出し → 配信
```

### 5.2 良いツールに共通する UX パターン

1. **解析 → 提案 → マクロ調整 → 詳細調整** の段階的な操作（Logic / Ozone の Assistant）
2. **ラウドネスを揃えた A/B 比較**：音量が大きい方を「良い」と感じてしまう錯覚を防ぐ。必須機能
3. **デルタ試聴（差分だけを聴く）**：処理で何が削られたか・足されたかを耳で確認する（Ozone 等）
4. **目に見えるフィードバック**：EQ カーブ、ゲインリダクションの履歴、LUFS 履歴、相関メーター
5. **キャラクターを名前で選ぶ**（Clean / Warm / Punch）：専門用語を知らなくても方向性を決められる
6. **キーボード中心の操作**：再生/停止、A/B 切り替え、ループ、セクション移動
7. **非破壊編集**：いつでも元に戻せる。バージョン（スナップショット）を比較できる
8. **アルバム全体の俯瞰**：全曲のラウドネスとトーンを一覧して、外れている曲がすぐわかる

### 5.3 波形表示の調査

- 一般的な DAW の波形はピーク（min/max）表示。マスタリングでは**RMS/ラウドネスを重ねて表示**し、ピークと音圧の差（クレストファクター）を目で見られると便利。
- **前後の重ね表示**（前＝グレー、後＝色付き）は、リミッターによる潰れ具合を直感的に示せる（Ozone の Maximizer 等）。
- **差分の表し方**は目的ごとに3種類が考えられる：
  1. **差分信号の波形**（後 − 前）：処理で変わった成分そのもの
  2. **ゲイン変化のエンベロープ（dB）**：どの時間でどれだけ下げた/上げたか（リミッターやコンプの効き具合）
  3. **スペクトル差分のヒートマップ**（時間 × 周波数 × dB 変化）：シマーやヒスをどこで除去したか
- 色覚多様性に配慮し、増減は「赤/緑」ではなく **青（カット）/ 橙（ブースト）の発散配色**＋記号で表す。

---

## 6. 本ツールの差別化ポイント（仮説）

1. **Suno 対策の修復処理とマスタリングを1つのパイプラインで**、しかも修復の強さとラウドネス目標が連動する
2. **アルバム単位で自動的に揃える**（ラウドネスの相対設計、トーンの揃え、曲間・フェード）
3. **前・後・差分の3種類の波形**を、切り替え表示・同時表示（重ね／上下並び）で表示し、差分は3つの表現から選べる
4. **ローカル処理**（アップロード不要、プライバシー保護）
5. **配信先での正規化シミュレーション**（Spotify / Apple でどう聞こえるか）

---

## 7. スコープ外とする事項（倫理・法的配慮）

- **AI 生成の痕跡を検出させないようにする処理（配信事業者の AI 検出の回避、ウォーターマーク除去等）は対象外**とする。本ツールの目的は音質の改善であり、修復処理もその目的に限る。
- Suno の利用規約（プランごとの商用利用権）は利用者が確認する前提とする。

---

## 8. 参考文献

- Suno 関連
  - [Suno v6: Everything You Need to Know (RouteNote)](https://routenote.com/radar/suno-v6-everything-you-need-to-know-about-sunos-new-ai-music-model/)
  - [Suno Release Notes](https://suno.com/release-notes)
  - [Suno v6 Review (sunowatermarkremover.com)](https://sunowatermarkremover.com/blog/suno-v6-review/)
  - [Exporting from Studio (Suno Help)](https://help.suno.com/en/articles/8128193)
  - [suno-to-ableton: suno-export.md](https://github.com/steven-ahfu/suno-to-ableton/blob/main/docs/suno-export.md)
  - [How to Export Suno Stems to Your DAW (Melodex)](https://melodex.app/blog/how-to-export-suno-stems-to-daw)
  - [Suno Artifacts and Mastering (Replayed Studio)](https://replayedstudio.com/blog/why-suno-song-sounds-bad/)
  - [Fix Suno v5.5 Hiss, Crackle & High-End Export Hiss (Neural Analog)](https://neuralanalog.com/fix-suno-hiss)
  - [How to Mix and Master Suno AI Tracks (MixMasterAI)](https://www.mixmasterai.co/mix-and-master-suno)
  - [Suno Mastering vs AI Artifact Removal (Sunofix)](https://sunofix.app/suno-mastering-vs-artifact-removal/)
- ラウドネス・配信
  - [Loudness normalization on Spotify](https://support.spotify.com/artists/article/loudness-normalization/)
  - [Mastering for Streaming: Your 2026 Platform Guide (Soundbridge)](https://www.soundbridge.io/mastering-for-streaming-your-2026-platform-guide)
  - [How to Master Your Music for Streaming (RoEx)](https://www.roexaudio.com/blog/how-to-master-music-for-streaming-spotify-apple-music-deezer-youtube)
- アルバムマスタリング
  - [How to Master an Album for Consistency (Violet Recording)](https://violetrecording.com/how-to-master-an-album/)
  - [Mastering Albums vs Singles (Production Expert)](https://www.production-expert.com/production-expert-1/mastering-albums-vs-singles-whats-the-difference)
- 商用ツール
  - [Logic Pro 10.8 Mastering Assistant (MusicTech)](https://www.musictech.net/news/apple-logic-pro-updates-for-mac-and-ipad/)
  - [Apple releases Logic Pro 12 (rekkerd.org)](https://rekkerd.org/apple-releases-logic-pro-12/)
  - [iZotope announces Ozone 12 (Attack Magazine)](https://www.attackmagazine.com/news/izotope-announces-ozone-12-with-new-stem-eq-bass-control-and-unlimiter/)
  - [Best AI Mastering Services in 2026 (MixingGPT)](https://mixinggpt.com/blog/best-ai-mastering-services-2026)
  - [Best AI Mastering Tools 2026 (fast.io)](https://fast.io/resources/best-ai-mastering-tools-2026/)
- OSS・研究
  - [Matchering (GitHub)](https://github.com/sergree/matchering)
  - [Pedalboard (Spotify Engineering)](https://engineering.atspotify.com/introducing-pedalboard-spotifys-audio-effects-library-for-python/)
  - [Apollo: Band-sequence Modeling for High-Quality Audio Restoration (arXiv)](https://arxiv.org/pdf/2409.08514)
  - [Mel-Band RoFormer for Music Source Separation (arXiv)](https://arxiv.org/pdf/2310.01809)
  - [Diff-MST (ISMIR 2024)](https://ismir2024program.ismir.net/poster_299.html)
  - [ITO-Master (arXiv)](https://arxiv.org/pdf/2506.16889)
  - [wavesurfer.js Docs / Plugins](https://wavesurfer.xyz/docs/plugins/)
  - [Write 0 lines of C++: Rust + Web GUI audio plugins (Speaker Deck)](https://speakerdeck.com/novonotes/write-0-lines-of-c-plus-plus-building-commercial-audio-plugins-with-rust-and-web-gui)
