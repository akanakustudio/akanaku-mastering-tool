import { describe, expect, it } from "vitest";
import { anchorId, initialOrder, l95Goal, titleFromFileName } from "../src/features/album/plan";

const t = (id: string, l95Before: number, offsetDb = 0) => ({ id, l95Before, offsetDb });

describe("album plan (detailed design 10.2)", () => {
  it("picks the loudest track as the anchor unless one is chosen", () => {
    const tracks = [t("a", -14), t("b", -11), t("c", -13)];
    expect(anchorId(tracks, "auto")).toBe("b");
    expect(anchorId(tracks, "c")).toBe("c");
    expect(anchorId(tracks, "gone")).toBe("b");
  });

  it("keeps the given share of the original loudness difference", () => {
    const anchor = t("a", -11);
    expect(l95Goal(t("b", -15), anchor, -10, 0.5)).toBeCloseTo(-12);
    expect(l95Goal(t("b", -15), anchor, -10, 0)).toBeCloseTo(-10);
    expect(l95Goal(t("b", -15), anchor, -10, 1)).toBeCloseTo(-14);
  });

  it("never makes a track louder than the anchor, except by the user's offset", () => {
    const anchor = t("a", -12);
    expect(l95Goal(t("b", -11), anchor, -10, 0.5)).toBeCloseTo(-10);
    expect(l95Goal(t("b", -11, 1.5), anchor, -10, 0.5)).toBeCloseTo(-8.5);
  });

  it("orders by leading track numbers, then by name", () => {
    const names = ["10 x.wav", "2 b.wav", "a.wav", "✦12 c.wav", "01 a.wav"].map((name) => ({ name }));
    expect(initialOrder(names).map((n) => n.name)).toEqual(["01 a.wav", "2 b.wav", "10 x.wav", "✦12 c.wav", "a.wav"]);
  });

  it("derives a title from the file name", () => {
    expect(titleFromFileName("03 三番タルト-Mix.wav")).toBe("三番タルト-Mix");
    expect(titleFromFileName("遮断機.wav")).toBe("遮断機");
    expect(titleFromFileName("✦5 アカナクニ (SUMS Ver.)-SunoMaster.wav")).toBe("アカナクニ (SUMS Ver.)-SunoMaster");
    expect(titleFromFileName("0808-1545モノクロの花.wav")).toBe("0808-1545モノクロの花");
  });
});
