# research/

P0 のアルゴリズム試作と較正用の Python（製品には含めない。詳細設計 1章・22章）。
ここで試作して効果を確かめたものを、`crates/akdsp`（Rust）に移植する。

```sh
cd research
uv sync
AKM_GOLDEN_DIR=/path/to/testdata uv run python -m akresearch.compare_logic   # Logic のマスターとの比較
```

- 音源は `$AKM_GOLDEN_DIR`（リポジトリの外）から読む。曲と役割の一覧は `tests/golden/manifest.json`。
- 出力（`research/out/`）は Git に入れない。
