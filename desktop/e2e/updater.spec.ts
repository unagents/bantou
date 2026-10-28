import { expect, test } from "./fixtures";
import { defaultSeed } from "./seed";

const calls = (page: import("@playwright/test").Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __BANTOU_MOCK__: { calls: { cmd: string }[] } }).__BANTOU_MOCK__.calls.map(
        (c) => c.cmd,
      ),
  );

test.describe("update available", () => {
  test.use({ seed: { ...defaultSeed, update: { version: "9.9.9" } } });

  test("a toast is shown on launch and install triggers download + relaunch", async ({ page }) => {
    await page.goto("/");
    const title = page.getByText("bantou 9.9.9 が利用可能", { exact: true });
    await expect(title).toBeVisible();
    expect(await calls(page)).toContain("plugin:updater|check");

    await page.getByRole("button", { name: "再起動して更新" }).click();
    await expect.poll(() => calls(page)).toEqual(
      expect.arrayContaining(["plugin:updater|download_and_install", "plugin:process|restart"]),
    );
  });
});

test.describe("no update", () => {
  test("no toast on launch (auto check is silent)", async ({ page }) => {
    await page.goto("/");
    await expect.poll(() => calls(page)).toContain("plugin:updater|check");
    await expect(page.getByText("が利用可能")).toHaveCount(0);
  });
});
