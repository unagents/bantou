import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

type Mock = { center: Record<string, unknown> };

/** Run `fn(mock)` in the page. `fn` is serialized: it must not capture anything. */
const mock = <T>(page: Page, fn: (m: Mock) => T) =>
  page.evaluate(
    (src) =>
      new Function("m", `return (${src})(m)`)((window as unknown as { __BANTOU_MOCK__: Mock }).__BANTOU_MOCK__),
    fn.toString(),
  ) as Promise<T>;

/** Parts of the settings dialog that belong to this PC's own (sidecar) center. */
const SIDECAR_ONLY = [
  "center-enabled",
  "center-own-section",
  "center-port",
  "center-bind",
  "center-token",
  "center-token-regenerate",
  "center-snippet",
  "center-claude-path",
  "center-workspace",
  "center-status-section",
  "center-state",
  "center-logs",
  "center-restart-count",
  "center-ip-banner",
];

/** Parts that edit the connected center (own or remote alike). */
const CONNECTED_CENTER = [
  "center-common-section",
  "center-common-section-instructions",
  "center-common-section-add-dirs",
  "center-common-section-output-style",
  "center-common-section-servers",
];

test.describe("settings dialog: sidecar OFF + remote connection", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await mock(page, (m) => {
      m.center.enabled = false;
      m.center.remote = { url: "http://mac200:7910/mcp", token: "tok-saved-remote-0123" };
    });
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
  });

  test("the sidecar-only parts are not shown; the connected center's settings and the connection are", async ({ page }) => {
    const dlg = page.getByTestId("settings-dialog");
    await expect(page.getByTestId("center-common-instructions")).toBeEnabled();
    for (const id of SIDECAR_ONLY) await expect(dlg.getByTestId(id)).toHaveCount(0);
    for (const id of CONNECTED_CENTER) await expect(dlg.getByTestId(id)).toBeVisible();
    // the connection (URL, token) and the way back to the sidecar stay
    await expect(dlg.getByTestId("center-remote-section")).toBeVisible();
    await expect(dlg.getByTestId("center-remote-current")).toContainText("http://mac200:7910/mcp");
    await expect(dlg.getByTestId("center-remote-only-hint")).toBeVisible();
    await expect(dlg.getByTestId("settings-save")).toBeDisabled();
  });

  test("the common settings are edited and saved to the connected center as before", async ({ page }) => {
    await expect(page.getByTestId("center-common-instructions")).toBeEnabled();
    await page.getByTestId("center-common-instructions").fill("remote 側の共通指示");
    await page.getByTestId("settings-save").click();
    await expect(page.getByTestId("settings-dialog")).toBeHidden();
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("center-common-instructions")).toHaveValue("remote 側の共通指示");
  });

  test("clearing the remote brings the on/off switch back (the way to start the sidecar)", async ({ page }) => {
    await expect(page.getByTestId("center-enabled")).toHaveCount(0);
    await page.getByTestId("center-remote-clear").click();
    await expect(page.getByTestId("center-enabled")).toBeVisible();
    await expect(page.getByTestId("center-status-section")).toBeVisible();
    await expect(page.getByTestId("center-state")).toHaveText("stopped");
    await expect(page.getByTestId("center-remote-only-hint")).toHaveCount(0);
    await page.getByTestId("center-enabled").click();
    await expect(page.getByTestId("center-port")).toBeVisible();
  });

  test("the center dialog shows the connection as remote and the server list of the connected center", async ({ page }) => {
    await page.keyboard.press("Escape");
    await page.getByTestId("open-center").click();
    await expect(page.getByTestId("center-conn-url")).toContainText("http://mac200:7910/mcp");
    await expect(page.getByTestId("center-conn-url")).toContainText("remote");
    await expect(page.getByTestId("center-servers")).toBeVisible();
    await expect(page.getByTestId("center-server-row").first()).toBeVisible();
  });
});

test.describe("settings dialog: sidecar ON", () => {
  test("the sidecar parts show as before, together with the connected center's settings", async ({ page }) => {
    await page.goto("/");
    await mock(page, (m) => {
      m.center.enabled = true;
      m.center.remote = { url: "http://mac200:7910/mcp", token: "tok-saved-remote-0123" };
    });
    await page.getByTestId("open-settings").click();
    const dlg = page.getByTestId("settings-dialog");
    await expect(page.getByTestId("center-common-instructions")).toBeEnabled();
    for (const id of ["center-enabled", "center-own-section", "center-port", "center-bind", "center-token", "center-snippet", "center-claude-path", "center-workspace", "center-status-section", "center-state"]) {
      await expect(dlg.getByTestId(id).first()).toBeVisible();
    }
    for (const id of CONNECTED_CENTER) await expect(dlg.getByTestId(id)).toBeVisible();
    // a saved remote is not used while the sidecar is on, and not shown
    await expect(dlg.getByTestId("center-remote-section")).toHaveCount(0);
    await expect(dlg.getByTestId("center-remote-only-hint")).toHaveCount(0);
  });

  test("off with no remote (nothing connected yet) keeps the switch and the state", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("center-enabled")).toBeVisible();
    await expect(page.getByTestId("center-state")).toHaveText("stopped");
    await expect(page.getByTestId("center-remote-paste")).toBeVisible();
    await expect(page.getByTestId("center-remote-only-hint")).toHaveCount(0);
  });
});
