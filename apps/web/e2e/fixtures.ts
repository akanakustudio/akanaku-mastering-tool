import { chromium, test as base, webkit, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Playwright's default (ephemeral) WebKit context cannot write OPFS at all, unlike real Safari,
// so tests run in a persistent context (which also lets them reload and check restoring).
export const test = base.extend<{ page: Page }>({
  page: async ({ browserName, baseURL }, use) => {
    const type = browserName === "webkit" ? webkit : chromium;
    const ctx = await type.launchPersistentContext(mkdtempSync(join(tmpdir(), "akm-e2e-")), { baseURL, acceptDownloads: true });
    await use(await ctx.newPage());
    await ctx.close();
  },
});
export { expect } from "@playwright/test";
