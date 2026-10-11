import { defineConfig, devices } from "@playwright/test";

// E2E against the production build served like `npm start` (detailed design 21.4).
export default defineConfig({
  testDir: "e2e",
  timeout: 240_000,
  use: { baseURL: "http://localhost:5173" },
  webServer: { command: "npm run preview", url: "http://localhost:5173", reuseExistingServer: true },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
