import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const E2E_DIR = dirname(fileURLToPath(import.meta.url));
export const PROJECT_DIR = resolve(E2E_DIR, "..");

/**
 * Scratch space for the run. Kept under `node_modules/` so writes do not
 * restart `nuxt dev` mid-test (same reason as careery's e2e/paths.ts).
 */
export const WORK_DIR = resolve(PROJECT_DIR, "node_modules/.cache/bantou-e2e");
/** IIFE bundle of `e2e/mock/install.ts`, built by `e2e/global-setup.ts`. */
export const MOCK_BUNDLE = resolve(WORK_DIR, "mock-tauri.js");
export const OUTPUT_DIR = resolve(WORK_DIR, "test-results");
export const SHOT_DIR = resolve(WORK_DIR, "shots");
