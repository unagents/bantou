import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

type Mock = { center: { enabled: boolean; remoteUrl?: string }; centerReachable: boolean };

type Change = { enabled?: boolean; remoteUrl?: string; reachable?: boolean };

/** Change the mocked backend: center settings and whether the center answers. */
const mock = (page: Page, change: Change) =>
  page.evaluate((c) => {
    const m = (window as unknown as { __BANTOU_MOCK__: Mock }).__BANTOU_MOCK__;
    if (c.enabled !== undefined) m.center.enabled = c.enabled;
    if (c.remoteUrl !== undefined) m.center.remoteUrl = c.remoteUrl;
    if (c.reachable !== undefined) m.centerReachable = c.reachable;
  }, change);

test("the center dialog shows the connection, rc_list and server_status", async ({ page }) => {
  await page.goto("/");
  await mock(page, { enabled: true });
  await page.getByTestId("open-center").click();
  await expect(page.getByTestId("center-dialog")).toBeVisible();
  await expect(page.getByTestId("center-conn-state")).toHaveText("connected");
  await expect(page.getByTestId("center-conn-url")).toContainText("http://127.0.0.1:7910/mcp");
  await expect(page.getByTestId("center-conn-url")).toContainText("sidecar");

  const rc = page.getByTestId("center-rc");
  await expect(rc).toHaveCount(2);
  await expect(rc.nth(0)).toContainText("alpha");
  await expect(rc.nth(0)).toContainText("connected");
  await expect(rc.nth(1)).toContainText("beta");
  await expect(rc.nth(1)).toContainText("stopped");

  const srv = page.getByTestId("center-server-row");
  await expect(srv).toHaveCount(1);
  await expect(srv).toContainText("srv1");
  await expect(srv).toContainText("reachable");
  const agents = page.getByTestId("center-agent");
  await expect(agents).toHaveCount(2);
  await expect(agents.nth(0)).toContainText("cap-a");
  await expect(agents.nth(1)).toContainText("w1");
});

test("remoteUrl is used as the connection target and refresh re-reads the state", async ({ page }) => {
  await page.goto("/");
  await mock(page, { remoteUrl: "http://mac200:7910" });
  await page.getByTestId("open-center").click();
  await expect(page.getByTestId("center-conn-url")).toContainText("http://mac200:7910/mcp");
  await expect(page.getByTestId("center-conn-url")).toContainText("remoteUrl");
  await expect(page.getByTestId("center-rc")).toHaveCount(2);

  await mock(page, { reachable: false });
  await page.getByTestId("center-refresh").click();
  await expect(page.getByTestId("center-conn-state")).toHaveText("disconnected");
  await expect(page.getByTestId("center-conn-error")).toContainText("接続できない");
  await expect(page.getByTestId("center-rc")).toHaveCount(0);
});

test("without a target the dialog says there is nothing to connect to", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("open-center").click();
  await expect(page.getByTestId("center-conn-state")).toHaveText("disconnected");
  await expect(page.getByTestId("center-conn-error")).toContainText("接続先が無い");
});
