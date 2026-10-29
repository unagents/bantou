import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

type Mock = {
  center: { enabled: boolean; remote?: { url: string; token?: string } };
  centerReachable: boolean;
  centerSessions: Record<string, unknown>[];
  centerSessionCreateError: string | null;
  centerSessionUrl: string | null;
};

/** Change the mocked backend. `center` is merged into the stored settings, other keys replace. */
const mock = (page: Page, change: Partial<Omit<Mock, "center">> & { center?: Partial<Mock["center"]> }) =>
  page.evaluate(({ center, ...rest }) => {
    const m = (window as unknown as { __BANTOU_MOCK__: Mock }).__BANTOU_MOCK__;
    Object.assign(m, rest);
    if (center) Object.assign(m.center, center);
  }, change);

/** The PM button reads the center settings on load and when the settings dialog closes. */
async function recheck(page: Page) {
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("settings-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toBeHidden();
}

async function openPm(page: Page) {
  await page.goto("/");
  await page.evaluate(() => {
    (window as unknown as { __BANTOU_MOCK__: Mock }).__BANTOU_MOCK__.center.enabled = true;
  });
  await recheck(page);
  await page.getByTestId("open-pm").click();
  await expect(page.getByTestId("pm-dialog")).toBeVisible();
}

test("a PM is created and shown with its sessionUrl, then listed", async ({ page }) => {
  await openPm(page);
  await expect(page.getByTestId("pm-none")).toHaveText("PM なし");
  await page.getByTestId("pm-name").fill("pm-main_1");
  await page.getByTestId("pm-create").click();
  await expect(page.getByTestId("pm-created")).toContainText("pm-main_1 を立てた");
  await expect(page.getByTestId("pm-created-url")).toHaveText("https://claude.ai/code/session_mock");
  const row = page.getByTestId("pm-row");
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("pm-row-name")).toHaveText("pm-main_1");
  await expect(row.getByTestId("pm-row-state")).toHaveText("connected");
  await expect(row.getByTestId("pm-row-url")).toHaveText("https://claude.ai/code/session_mock");
  await expect(page.getByTestId("pm-name")).toHaveValue("");
});

test("a PM whose sessionUrl is not ready yet is shown as starting", async ({ page }) => {
  await openPm(page);
  await mock(page, { centerSessionUrl: null });
  await page.getByTestId("pm-name").fill("pm-slow");
  await page.getByTestId("pm-create").click();
  await expect(page.getByTestId("pm-created-pending")).toContainText("starting");
  await expect(page.getByTestId("pm-row-state")).toHaveText("starting");
  await expect(page.getByTestId("pm-row-url")).toHaveCount(0);
});

test("a failure from the center is shown", async ({ page }) => {
  await openPm(page);
  await mock(page, { centerSessionCreateError: "claude が見つからない" });
  await page.getByTestId("pm-name").fill("pm-x");
  await page.getByTestId("pm-create").click();
  await expect(page.getByTestId("pm-create-error")).toContainText("claude が見つからない");
  await expect(page.getByTestId("pm-created")).toHaveCount(0);
  await expect(page.getByTestId("pm-none")).toBeVisible();
});

test("an existing name cannot be used", async ({ page }) => {
  await openPm(page);
  await page.getByTestId("pm-name").fill("pm-a");
  await page.getByTestId("pm-create").click();
  await expect(page.getByTestId("pm-row")).toHaveCount(1);
  await page.getByTestId("pm-name").fill("pm-a");
  await expect(page.getByTestId("pm-dialog")).toContainText("既に使われている名前");
  await expect(page.getByTestId("pm-create")).toBeDisabled();
  await page.getByTestId("pm-name").fill("workspace");
  await expect(page.getByTestId("pm-dialog")).toContainText("既に使われている名前");
  await expect(page.getByTestId("pm-create")).toBeDisabled();
});

test("an invalid name cannot be used", async ({ page }) => {
  await openPm(page);
  for (const bad of ["pm a", "pm.a", "ピーエム", "a/b"]) {
    await page.getByTestId("pm-name").fill(bad);
    await expect(page.getByTestId("pm-dialog")).toContainText("英数字と _ - のみ");
    await expect(page.getByTestId("pm-create")).toBeDisabled();
  }
  await page.getByTestId("pm-name").fill("");
  await expect(page.getByTestId("pm-create")).toBeDisabled();
});

test("the button is disabled with the reason while the center is off and has no remote", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("open-pm")).toBeDisabled();
  await expect(page.getByTestId("pm-disabled-reason")).toContainText("center が無効で接続先も無い");

  await mock(page, { center: { enabled: false, remote: { url: "http://mac200:7910", token: "tok-remote-0123456789" } } });
  await recheck(page);
  await expect(page.getByTestId("open-pm")).toBeEnabled();
  await expect(page.getByTestId("pm-disabled-reason")).toHaveCount(0);
});

test("the button stays usable and the failure is shown when the center does not answer", async ({ page }) => {
  await page.goto("/");
  await mock(page, { center: { enabled: true }, centerReachable: false, centerSessionCreateError: "http://127.0.0.1:7910/mcp に接続できない" });
  await recheck(page);
  await page.getByTestId("open-pm").click();
  await page.getByTestId("pm-name").fill("pm-y");
  await page.getByTestId("pm-create").click();
  await expect(page.getByTestId("pm-create-error")).toContainText("接続できない");
});

test.describe("no folder selected", () => {
  test.use({ seed: { dir: null, tasks: [], threads: [] } });

  test("the PM button is in the header without a folder", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "フォルダを開く" })).toBeVisible();
    await expect(page.getByTestId("open-pm")).toBeVisible();
  });
});
