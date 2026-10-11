// Layout adapts to the window width; the album timeline panel can span the whole window.
// AKM_E2E_SONG=<song> AKM_E2E_ALBUM="<a>|<b>" [AKM_E2E_SHOT=<prefix>] npx playwright test e2e/layout.spec.ts
import { expect, test } from "./fixtures";

const song = process.env.AKM_E2E_SONG;
const album = process.env.AKM_E2E_ALBUM?.split("|").filter(Boolean) ?? [];
const WIDTHS = [1024, 1440, 2560];

const noHorizontalScroll = (page: import("@playwright/test").Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test("panels reflow with the window and the timeline can go full width", async ({ page }) => {
  test.skip(!song || album.length < 2, "AKM_E2E_SONG / AKM_E2E_ALBUM are not set");
  const shot = process.env.AKM_E2E_SHOT;
  const name = test.info().project.name;

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator('.app:not(.album) .app-header input[type="file"]').setInputFiles(song!);
  await expect(page.getByRole("status")).toHaveText("準備完了", { timeout: 200_000 });
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(300);
    expect(await noHorizontalScroll(page), `single @${w}`).toBe(true);
    const cols = await page.locator(".panels").evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
    console.log(`[${name}] single @${w}px: ${cols} column(s)`);
    if (shot) await page.screenshot({ path: `${shot}-${name}-single-${w}.png`, fullPage: true });
  }

  await page.getByRole("tab", { name: "アルバム" }).click();
  await page.locator(".album .app-header input[type=file]").setInputFiles(album);
  await expect(page.locator(".tracks tbody tr")).toHaveCount(album.length);
  await expect(page.getByRole("button", { name: /自動バランス/ })).toBeEnabled({ timeout: 120_000 });
  const panel = page.locator("section.panel", { has: page.getByRole("heading", { name: "通して聴く" }) });
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(300);
    expect(await noHorizontalScroll(page), `album @${w}`).toBe(true);
    if (shot) await page.screenshot({ path: `${shot}-${name}-album-${w}.png`, fullPage: true });

    await panel.getByRole("button", { name: /全幅表示/ }).click();
    await page.waitForTimeout(300);
    const box = (await panel.boundingBox())!;
    const vw = await page.evaluate(() => document.documentElement.clientWidth);
    console.log(`[${name}] album @${w}px: full-width timeline panel ${Math.round(box.x)}..${Math.round(box.x + box.width)} of ${vw}`);
    expect(box.x).toBeLessThan(30);
    expect(box.x + box.width).toBeGreaterThan(vw - 30);
    expect(await noHorizontalScroll(page), `album full-width @${w}`).toBe(true);
    if (shot && w === 2560) await panel.screenshot({ path: `${shot}-${name}-timeline-full-${w}.png` });
    await panel.getByRole("button", { name: /通常の幅/ }).click();
  }
});
