import { resolve } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { boardSeed } from "./seed";
import { SHOT_DIR } from "./paths";

test.use({ seed: boardSeed });

const row = (page: Page, taskId: string) => page.locator(`li[data-task-id="${taskId}"]`);
const icon = (page: Page, taskId: string) => row(page, taskId).getByTestId("task-icon");

/** A ping for `taskId` arrives at bantou. */
const ping = (page: Page, taskId: string, ttlMs?: number) =>
  page.evaluate(
    ({ id, ttl }) =>
      (
        window as unknown as { __BANTOU_MOCK__: { ping: (id: string, ttl?: number) => void } }
      ).__BANTOU_MOCK__.ping(id, ttl),
    { id: taskId, ttl: ttlMs },
  );

test("only a working task with a live ping timer has the spinning icon", async ({ page }) => {
  await page.goto("/");
  await expect(row(page, "t-cr001")).toBeVisible();
  // No ping yet: nothing spins.
  await expect(page.locator(".animate-spin")).toHaveCount(0);
  await ping(page, "t-cr001"); // working (Doing)
  await ping(page, "t-cr002"); // queued (Todo)
  // working + live timer
  await expect(row(page, "t-cr001")).toHaveAttribute("data-running", "true");
  await expect(icon(page, "t-cr001")).toHaveClass(/animate-spin/);
  // working, no timer
  await expect(row(page, "t-sb001")).toHaveAttribute("data-running", "false");
  await expect(icon(page, "t-sb001")).not.toHaveClass(/animate-spin/);
  // queued + live timer
  await expect(row(page, "t-cr002")).toHaveAttribute("data-running", "false");
  await expect(icon(page, "t-cr002")).not.toHaveClass(/animate-spin/);
  await expect(page.locator(".animate-spin")).toHaveCount(1);
  await page.screenshot({ path: resolve(SHOT_DIR, "ping.png"), fullPage: true });
});

test("the icon stops without a reload when the timer runs out", async ({ page }) => {
  await page.goto("/");
  await expect(row(page, "t-am001")).toBeVisible();
  await ping(page, "t-am001", 3000);
  await expect(icon(page, "t-am001")).toHaveClass(/animate-spin/);
  await expect(icon(page, "t-am001")).not.toHaveClass(/animate-spin/);
  await expect(row(page, "t-am001")).toHaveAttribute("data-running", "false");
});
