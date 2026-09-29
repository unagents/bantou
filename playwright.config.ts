import { defineConfig, devices } from "@playwright/test";

import type { Seed } from "./e2e/mock/bantou";
import { OUTPUT_DIR } from "./e2e/paths";
import { defaultSeed } from "./e2e/seed";

/**
 * E2E against the Nuxt dev server with the Tauri IPC mocked in the browser
 * (careery pattern). No Rust build, no broker, no claude process.
 */
export default defineConfig<{ seed: Seed }>({
  testDir: "./e2e",
  outputDir: OUTPUT_DIR,
  globalSetup: "./e2e/global-setup.ts",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  // System Chrome over ssh (no GUI session) occasionally dies at context
  // creation on mac200; a retry gets a fresh browser.
  retries: 2,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${process.env.E2E_PORT ?? 1420}`,
    trace: "retain-on-failure",
    seed: defaultSeed,
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    {
      name: "chrome",
      use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    command: "bun run dev",
    url: `http://localhost:${process.env.E2E_PORT ?? 1420}`,
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
