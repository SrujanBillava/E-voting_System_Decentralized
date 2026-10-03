import { defineConfig } from "@playwright/test";

// Browser tests run against a REAL local stack: Hardhat node + MongoDB + the V2 backend (see e2e/README.md).
// System Chrome is used so no browser download is needed. Nothing here ships in the production bundle.
const port = Number(process.env.E2E_PORT ?? 5173);
const backend = process.env.E2E_BACKEND_URL ?? "http://localhost:5100";

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: process.env.E2E_OUTPUT_DIR ?? "./e2e/.output",
  use: {
    baseURL: `http://localhost:${port}`,
    channel: "chrome",
    headless: true,
    trace: "off",
    screenshot: "off",
  },
  webServer: {
    command: `npx vite --port ${port} --strictPort`,
    port,
    reuseExistingServer: true,
    env: { VITE_PROXY_TARGET: backend },
  },
});
