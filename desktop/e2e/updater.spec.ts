import { expect, test } from "./fixtures";
import { defaultSeed } from "./seed";

const calls = (page: import("@playwright/test").Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __BANTOU_MOCK__: { calls: { cmd: string }[] } }).__BANTOU_MOCK__.calls.map(
        (c) => c.cmd,
      ),
  );

test.describe("no update", () => {
  test("idle -> check -> latest -> back to idle; the launch auto check is silent", async ({ page }) => {
    await page.goto("/");
    const control = page.getByTestId("updater-control");
    await expect(control).toHaveText("アップデートを確認");
    await expect.poll(() => calls(page)).toContain("plugin:updater|check");
    await control.click();
    await expect(control).toHaveText("最新");
    await expect(control).toHaveText("アップデートを確認");
  });
});

test.describe("update available", () => {
  test.use({ seed: { ...defaultSeed, update: { version: "9.9.9" } } });

  test("the launch check switches the header button; click downloads and restarts", async ({ page }) => {
    await page.goto("/");
    const control = page.getByTestId("updater-control");
    await expect(control).toHaveText("アップデートして再起動（v9.9.9）");
    expect(await calls(page)).toContain("plugin:updater|check");
    await expect(page.getByText("が利用可能")).toHaveCount(0);

    await control.click();
    await expect.poll(() => calls(page)).toEqual(
      expect.arrayContaining(["plugin:updater|download_and_install", "plugin:process|restart"]),
    );
  });
});

test.describe("no folder selected", () => {
  test.use({ seed: { ...defaultSeed, dir: null, update: { version: "9.9.9" } } });

  test("the update control is in the header without a folder", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "フォルダを開く" })).toBeVisible();
    await expect(page.getByTestId("updater-control")).toHaveText("アップデートして再起動（v9.9.9）");
  });
});
