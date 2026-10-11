"""P0-4 step 1: compare what went into Logic's Mastering Assistant with what came out,
for every album track that has a `user_master` (tests/golden/manifest.json)."""
import json
import sys
from pathlib import Path

from .golden import REPO, load, manifest
from .metrics import analyze


def logic_input(files: dict) -> str | None:
    # The master was made from the user's mix when there is one, otherwise from Suno's export.
    for role in ("user_mix", "suno", "studio_mix"):
        if role in files:
            return role
    return None


def main() -> None:
    m = manifest()
    album = m["albums"]["SUMS"]
    songs = {s["id"]: s for s in m["songs"]}
    rows = []
    for t in album["tracks"]:
        s = songs[t["songId"]]
        role = logic_input(s["files"])
        if role is None or "user_master" not in s["files"]:
            continue
        a, sr = load(s["files"][role])
        b, _ = load(s["files"]["user_master"])
        rows.append({"no": t["no"], "id": s["id"], "title": s["title"], "inputRole": role, "input": analyze(a, sr), "master": analyze(b, sr)})
        print(f"  {t['no']:02d} {s['title']} done", file=sys.stderr)

    out = REPO / "research/out"
    out.mkdir(parents=True, exist_ok=True)
    (out / "compare_logic.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")

    hdr = "| # | 曲 | 入力 | LUFS 入力→マスター | TP | PLR | L95 | 低中域 200-500 | 5-8k | 8-16k | 16k- | Shimmer S（スコア） | モノラル低下 |"
    print(hdr)
    print("|" + "---|" * hdr.count("|")[:-1] if False else "|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for r in rows:
        i, o = r["input"], r["master"]
        arrow = lambda k, fmt="{:+.1f}": f"{i[k]:.1f}→{o[k]:.1f}" if fmt is None else f"{i[k]:.1f}→{o[k]:.1f}"
        print(
            f"| {r['no']:02d} | {r['title']} | {r['inputRole']} | {arrow('lufs')} | {arrow('tp')} | {arrow('plr')} | {arrow('l95')} "
            f"| {i['low_mid']:+.1f}→{o['low_mid']:+.1f} | {i['fizz']:+.1f}→{o['fizz']:+.1f} | {i['air']:+.1f}→{o['air']:+.1f} | {i['top']:+.1f}→{o['top']:+.1f} "
            f"| {i['shimmer']['S']:.2f}→{o['shimmer']['S']:.2f}（{i['shimmer']['score']:.0f}→{o['shimmer']['score']:.0f}） | {i['mono_drop']:+.2f}→{o['mono_drop']:+.2f} |"
        )


if __name__ == "__main__":
    main()
