import { defaultSeed } from "./seed";
import { expect, test } from "./fixtures";

test.describe("no folder selected", () => {
  test.use({ seed: { ...defaultSeed, dir: null } });

  test("the header stays with settings and center, and only the folder items are hidden", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "フォルダを開く" })).toBeVisible();
    await expect(page.getByTestId("open-settings")).toBeVisible();
    await expect(page.getByTestId("open-center")).toBeVisible();
    await expect(page.getByRole("button", { name: "セッション追加" })).toHaveCount(0);
    await expect(page.getByText("返答待ち")).toHaveCount(0);
    await expect(page.getByText("messenger", { exact: true })).toHaveCount(0);
  });

  test("the gear opens the settings dialog", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
  });

  test("the center status can be opened", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("open-center").click();
    await expect(page.getByTestId("center-dialog")).toBeVisible();
    await expect(page.getByTestId("center-conn-state")).toHaveText("disconnected");
  });
});
