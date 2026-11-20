import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

// The web app's e2e: the built backend behind the guard, a fake center, a phone-sized chromium. `bun run e2e` builds first.
// CHROMIUM_PATH: a chromium (headless shell) executable to use instead of the one Playwright would look for.
const executablePath = process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH) ? process.env.CHROMIUM_PATH : undefined;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 1,
  reporter: [["list"]],
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "phone", use: { ...devices["Pixel 7"], launchOptions: { executablePath } } },
  ],
});
