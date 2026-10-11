// Album E2E (detailed design 10, 21.4 E2E-03): add songs → auto balance → listen → export ZIP.
// AKM_E2E_ALBUM="/a.wav|/b.wav|/c.wav" npx playwright test e2e/album.spec.ts
import { unzipSync } from "fflate";
import { readFileSync, statSync } from "node:fs";
import { expect, test } from "./fixtures";

const songs = process.env.AKM_E2E_ALBUM?.split("|").filter(Boolean) ?? [];

test("album: auto balance and export", async ({ page }) => {
  test.skip(songs.length < 2, "AKM_E2E_ALBUM is not set");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  // Force the ZIP download path (the folder picker needs a real user).
  await page.addInitScript(() => delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker);

  await page.goto("/");
  await page.getByRole("tab", { name: "アルバム" }).click();
  await page.locator(".album input[type=file]").setInputFiles(songs);
  const rows = page.locator(".tracks tbody tr");
  await expect(rows).toHaveCount(songs.length);
  await expect(page.getByRole("button", { name: /自動バランス/ })).toBeEnabled({ timeout: 120_000 });

  // A 3-second fade-out on the first track (applied at export and playback, no re-render needed).
  await rows.nth(0).getByRole("spinbutton", { name: "フェードアウト（秒）" }).fill("3");

  const t0 = Date.now();
  await page.getByRole("button", { name: /自動バランス/ }).click();
  await expect(page.getByRole("status").filter({ visible: true })).toHaveText("準備完了", { timeout: 600_000 });
  console.log(`[${test.info().project.name}] balanced ${songs.length} songs in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  // After L95 of every track; none louder than the anchor's.
  const after = await rows.locator("td:nth-child(5)").allTextContents();
  const nums = (s: string) => (s.match(/-?\d+\.\d/g) ?? []).map(Number); // LUFS, L95, TP[, tone]
  const l95 = after.map((s) => nums(s)[1]);
  const tp = after.map((s) => nums(s)[2]);
  console.log("after LUFS / L95 / TP:", after.join(" | "));
  const anchorRow = await rows.filter({ hasText: "基準曲" }).locator("td:nth-child(5)").textContent();
  const anchorL95 = nums(anchorRow!)[1];
  for (const v of l95) expect(v).toBeLessThanOrEqual(anchorL95 + 0.5);
  for (const v of tp) expect(v).toBeLessThanOrEqual(-1.0);
  // Album tone harmonisation (default 50 %) reports how much each track was nudged.
  await expect(rows.first().locator("td:nth-child(5)")).toContainText("音色 ±");

  // Continuous playback, then the transition from track 1 into track 2.
  await page.getByRole("button", { name: "▶ 最初から" }).click();
  await expect(page.locator(".playback-row .now")).toContainText(/^01 .*0:0[1-9]/, { timeout: 15_000 });
  await page.getByRole("button", { name: "■ 停止" }).click();
  await rows.nth(0).getByRole("button", { name: "▶ つなぎ目" }).click();
  await expect(page.locator(".playback-row .now")).toContainText("（曲間）", { timeout: 20_000 });
  await expect(page.locator(".playback-row .now")).toContainText(/^02 /, { timeout: 10_000 });
  await page.getByRole("button", { name: "■ 停止" }).click();

  // Reload: the album (order, results) is restored from the saved session.
  await page.waitForTimeout(1500); // autosave debounce
  await page.reload();
  await page.getByRole("tab", { name: "アルバム" }).click();
  await expect(rows).toHaveCount(songs.length);
  expect(await rows.locator("td:nth-child(5)").allTextContents()).toEqual(after);
  await expect(page.getByRole("button", { name: "アルバムを書き出す" })).toBeEnabled();

  await rows.nth(1).getByRole("button", { name: "聴く" }).click();
  await expect(page.getByRole("button", { name: "▶ 再生" })).toBeEnabled({ timeout: 60_000 });

  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 600_000 }), page.getByRole("button", { name: "アルバムを書き出す" }).click()]);
  const path = await download.path();
  const zip = unzipSync(readFileSync(path), { filter: () => true });
  const names = Object.keys(zip);
  console.log("zip:", names.join(", "), `${(statSync(path).size / 1e6).toFixed(0)} MB`);
  expect(names.filter((n) => n.endsWith(".wav")).length).toBe(songs.length + 1);
  expect(names.some((n) => n.endsWith(".cue"))).toBe(true);
  expect(new TextDecoder().decode(zip[names.find((n) => n.endsWith(".cue"))!])).toContain("TRACK 03 AUDIO");
  // The fade-out reaches silence at the end of track 1 (24-bit PCM, last 10 ms).
  const first = zip[names.find((n) => n.startsWith("01 "))!];
  const tail = new DataView(first.buffer, first.byteOffset + first.length - 441 * 6, 441 * 6);
  let peak = 0;
  for (let i = 0; i < 441 * 2; i++) {
    const v = tail.getUint8(i * 3) | (tail.getUint8(i * 3 + 1) << 8) | (tail.getInt8(i * 3 + 2) << 16);
    peak = Math.max(peak, Math.abs(v) / 8388608);
  }
  expect(peak).toBeLessThan(1e-3);

  expect(errors).toEqual([]);
});
