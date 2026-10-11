import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { devSecurityHeaders, securityHeaders } from "./security-headers";

// The URL is fixed to http://localhost:5173: OPFS / IndexedDB data is per origin,
// so a different host or port would show an empty app (detailed design 16.0, 20.2).
export default defineConfig({
  plugins: [react()],
  server: { host: "localhost", port: 5173, strictPort: true, headers: devSecurityHeaders },
  preview: { host: "localhost", port: 5173, strictPort: true, headers: securityHeaders },
  worker: { format: "es" },
  build: { target: "es2022" },
  // Unit tests only; e2e/ is run by Playwright.
  test: { include: ["tests/**/*.test.ts"] },
});
