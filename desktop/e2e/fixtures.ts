import { test as base, expect, type Page } from "@playwright/test";

import type { Seed } from "./mock/bantou";
import { MOCK_BUNDLE } from "./paths";
import { defaultSeed } from "./seed";

export const test = base.extend<{ seed: Seed; page: Page }>({
  seed: [defaultSeed, { option: true }],
  page: async ({ page, seed }, use) => {
    await page.addInitScript((s) => {
      (window as unknown as { __BANTOU_E2E_SEED__: Seed }).__BANTOU_E2E_SEED__ = s;
    }, seed);
    await page.addInitScript({ path: MOCK_BUNDLE });
    await use(page);
  },
});

export { expect };

export function sentMessages(page: Page) {
  return page.evaluate(
    () => (window as unknown as { __BANTOU_MOCK__: { sent: { to: string; text: string }[] } }).__BANTOU_MOCK__.sent,
  );
}
