"""Access to the golden set (tests/golden/manifest.json + $AKM_GOLDEN_DIR)."""
import json
import os
from pathlib import Path

import numpy as np
import soundfile as sf

REPO = Path(__file__).resolve().parents[2]


def manifest() -> dict:
    return json.loads((REPO / "tests/golden/manifest.json").read_text(encoding="utf-8"))


def golden_dir() -> Path:
    d = os.environ.get("AKM_GOLDEN_DIR")
    if not d:
        raise SystemExit("AKM_GOLDEN_DIR を設定してください（テスト用楽曲のフォルダー）")
    return Path(d)


def load(name: str) -> tuple[np.ndarray, int]:
    """Returns float64 audio shaped [2, N] and the sample rate."""
    x, sr = sf.read(golden_dir() / name, dtype="float64", always_2d=True)
    x = x.T
    if x.shape[0] == 1:
        x = np.vstack([x, x])
    return x[:2], sr
