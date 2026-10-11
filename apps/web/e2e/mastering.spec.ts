// E2E-01 (detailed design 21.4): open a song, master it, A/B, export.
// Needs a real song: AKM_E2E_SONG=/path/to/song.wav npx playwright test
import { expect, test } from "@playwright/test";
import { statSync } from "node:fs";

const song = process.env.AKM_E2E_SONG;

test("open → auto master → A/B → export", async ({ page }) => {
  test.skip(!song, "AKM_E2E_SONG is not set");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  await page.goto("/");
  const t0 = Date.now();
  await page.locator('.app:not(.album) input[type="file"]').setInputFiles(song!);
  await expect(page.getByRole("status")).toHaveText("準備完了", { timeout: 200_000 });
  const seconds = (Date.now() - t0) / 1000;

  const row = page.getByRole("row", { name: /ラウドネス（LUFS）/ });
  const after = Number(await row.locator("td").nth(1).textContent());
  const tpRow = page.getByRole("row", { name: /True Peak/ });
  const tp = Number(await tpRow.locator("td").nth(1).textContent());
  console.log(`[${test.info().project.name}] load+master ${seconds.toFixed(1)} s, after ${after} LUFS, TP ${tp} dBTP`);
  expect(Math.abs(after - -14)).toBeLessThanOrEqual(0.5);
  expect(tp).toBeLessThanOrEqual(-1.0);

  await page.getByRole("button", { name: "▶ 再生" }).click();
  await page.waitForTimeout(800);
  for (const k of ["1", "3", "2"]) await page.keyboard.press(k);
  await expect(page.getByRole("radio", { name: "After" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "■ 停止" }).click();

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "WAV を書き出す" }).click()]);
  const path = await download.path();
  expect(statSync(path).size).toBeGreaterThan(1_000_000);

  expect(errors).toEqual([]);
});
