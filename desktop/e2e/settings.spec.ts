import { expect, test } from "./fixtures";

test("the settings dialog saves the center port and shows it again", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("open-settings").click();
  const dialog = page.getByTestId("settings-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("center-port")).toHaveValue("7910");
  await expect(page.getByTestId("center-state")).toHaveText("stopped");

  await page.getByTestId("center-port").fill("7920");
  await page.getByTestId("settings-save").click();
  await expect(page.getByText("設定を保存した")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("center-port")).toHaveValue("7920");
});
