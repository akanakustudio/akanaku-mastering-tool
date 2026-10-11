// E2E-01 (detailed design 21.4): open a song, master it, A/B, export.
// Needs a real song: AKM_E2E_SONG=/path/to/song.wav npx playwright test
import { expect, test } from "./fixtures";
import { unzipSync } from "fflate";
import { readFileSync, statSync } from "node:fs";

const song = process.env.AKM_E2E_SONG;

test("open → auto master → A/B → export", async ({ page }) => {
  test.skip(!song, "AKM_E2E_SONG is not set");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  await page.goto("/");
  const t0 = Date.now();
  await page.locator('.app:not(.album) .app-header input[type="file"]').setInputFiles(song!);
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

  // Moving a control: the region around the playhead is re-rendered first (detailed design 4.5).
  const slider = page.getByRole("slider", { name: /自動トーン補正/ });
  const t1 = Date.now();
  await slider.evaluate((el: HTMLInputElement) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, "90");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.getByRole("status")).toContainText("試聴用", { timeout: 30_000 });
  const regionSec = (Date.now() - t1) / 1000;
  await expect(page.getByRole("status")).toHaveText("準備完了", { timeout: 200_000 });
  console.log(`[${test.info().project.name}] change → region audible ${regionSec.toFixed(1)} s, full ${((Date.now() - t1) / 1000).toFixed(1)} s`);
  expect(regionSec).toBeLessThan(5);
  await page.getByRole("button", { name: "■ 停止" }).click();

  // Reload: the song, settings and render are restored without rendering again.
  await page.waitForTimeout(1500); // autosave debounce
  const t2 = Date.now();
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("準備完了", { timeout: 120_000 });
  console.log(`[${test.info().project.name}] restore after reload ${((Date.now() - t2) / 1000).toFixed(1)} s`);
  await expect(page.getByRole("slider", { name: /自動トーン補正/ })).toHaveValue("90");

  // Project file round trip (detailed design 13.5): save with renders, close, load it back.
  page.on("dialog", (d) => void d.accept());
  await page.getByRole("checkbox", { name: /処理結果も含める/ }).check();
  const [projectDl] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), page.getByRole("button", { name: /プロジェクトファイルに保存/ }).click()]);
  const projectPath = test.info().outputPath("p.akmaster");
  await projectDl.saveAs(projectPath);
  await page.getByRole("button", { name: "閉じる" }).click();
  await expect(page.getByRole("button", { name: "プロジェクトファイルを読み込む" })).toBeVisible();
  await page.locator('.project input[type="file"]').first().setInputFiles(projectPath);
  await expect(page.getByRole("status")).toHaveText("準備完了", { timeout: 120_000 });
  await expect(page.getByRole("slider", { name: /自動トーン補正/ })).toHaveValue("90");

  // A second tab shows a notice and can take over (detailed design 13.4).
  const other = await page.context().newPage();
  await other.goto("/");
  await expect(other.getByText("別のタブで開かれています")).toBeVisible();
  await other.getByRole("button", { name: /このタブで使う/ }).click();
  await expect(other.getByRole("tab", { name: "シングル" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("別のタブで開かれています")).toBeVisible();
  await other.close();
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("準備完了", { timeout: 120_000 });

  // Default: WAV + mastering log in a ZIP (after a restore, so the saved render report is used).
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "WAV＋ログを書き出す" }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
  const zip = unzipSync(readFileSync(await download.path()));
  const wav = Object.keys(zip).find((n) => n.endsWith(".wav"))!;
  expect(zip[wav].length).toBeGreaterThan(1_000_000);
  const text = new TextDecoder().decode(zip["mastering-log.txt"]);
  console.log(text);
  expect(text).toContain(`元のファイル：${song!.split("/").pop()}`);
  expect(text).toContain("7. True Peak リミッター");
  expect(text).toContain(`出力ファイル：${wav}`);
  const json = JSON.parse(new TextDecoder().decode(zip["mastering-log.json"]));
  expect(json.tracks[0].source.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(json.tracks[0].output.truePeakDbtp).toBeLessThanOrEqual(-1 + 0.05);

  // Without the log: a plain WAV as before.
  await page.getByLabel(/処理ログを含める/).uncheck();
  const [plain] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "WAV を書き出す" }).click()]);
  expect(plain.suggestedFilename()).toMatch(/\.wav$/);
  expect(statSync(await plain.path()).size).toBeGreaterThan(1_000_000);

  expect(errors).toEqual([]);
});
