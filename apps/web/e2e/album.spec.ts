// Album E2E (detailed design 10, 21.4 E2E-03): add songs → auto balance → listen → export ZIP.
// AKM_E2E_ALBUM="/a.wav|/b.wav|/c.wav" npx playwright test e2e/album.spec.ts
import { chromium, expect, test as base, webkit, type Page } from "@playwright/test";
import { unzipSync } from "fflate";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Playwright's default (ephemeral) WebKit context cannot write OPFS at all, unlike real Safari,
// so the album test runs in a persistent context.
const test = base.extend<{ page: Page }>({
  page: async ({ browserName, baseURL }, use) => {
    const type = browserName === "webkit" ? webkit : chromium;
    const ctx = await type.launchPersistentContext(mkdtempSync(join(tmpdir(), "akm-e2e-")), { baseURL, acceptDownloads: true });
    await use(await ctx.newPage());
    await ctx.close();
  },
});

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

  const t0 = Date.now();
  await page.getByRole("button", { name: /自動バランス/ }).click();
  await expect(page.getByRole("status").filter({ visible: true })).toHaveText("準備完了", { timeout: 600_000 });
  console.log(`[${test.info().project.name}] balanced ${songs.length} songs in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  // After L95 of every track; none louder than the anchor's.
  const after = await rows.locator("td:nth-child(5)").allTextContents();
  const l95 = after.map((s) => Number(s.split("/")[1]));
  const tp = after.map((s) => Number(s.split("/")[2]));
  console.log("after LUFS / L95 / TP:", after.join(" | "));
  const anchorRow = await rows.filter({ hasText: "基準曲" }).locator("td:nth-child(5)").textContent();
  const anchorL95 = Number(anchorRow!.split("/")[1]);
  for (const v of l95) expect(v).toBeLessThanOrEqual(anchorL95 + 0.5);
  for (const v of tp) expect(v).toBeLessThanOrEqual(-1.0);

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

  expect(errors).toEqual([]);
});
