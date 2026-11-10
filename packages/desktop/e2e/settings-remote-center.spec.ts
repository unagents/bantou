import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { boardSeed } from "./seed";

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
  "center-common-section-output-style",
  "center-common-section-memory",
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
    // the reference folders are paths for the own sidecar only (see "reference folders: sidecar only")
    await expect(dlg.getByTestId("center-common-section-add-dirs")).toHaveCount(0);
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

  test("the start button turns the center on and keeps the remote; the click can be undone with the switch", async ({ page }) => {
    await expect(page.getByTestId("center-enabled")).toHaveCount(0);
    await expect(page.getByTestId("settings-save")).toBeDisabled();
    await page.getByTestId("center-start-sidecar").click();
    // the sidecar's own settings show; the switch shows too (undo), the remote section gives way
    await expect(page.getByTestId("center-port")).toBeVisible();
    await expect(page.getByTestId("center-enabled")).toBeChecked();
    await expect(page.getByTestId("settings-save")).toBeEnabled();
    await page.getByTestId("center-enabled").click();
    await expect(page.getByTestId("center-start-sidecar")).toBeVisible();
    await expect(page.getByTestId("center-remote-current")).toContainText("http://mac200:7910/mcp");
    await expect(page.getByTestId("settings-save")).toBeDisabled();
    // start and save: enabled is sent and the remote is kept as saved
    await page.getByTestId("center-start-sidecar").click();
    await page.getByTestId("settings-save").click();
    await expect(page.getByTestId("settings-dialog")).toBeHidden();
    const call = await folderMock(page, (m) => m.calls.filter((c) => c.cmd === "center_set_settings").slice(-1)[0]);
    expect(call?.args).toMatchObject({ settings: { enabled: true, remote: { url: "http://mac200:7910/mcp", token: "tok-saved-remote-0123" } } });
    expect(await mock(page, (m) => m.center)).toMatchObject({ enabled: true, remote: { url: "http://mac200:7910/mcp" } });
    // the saved state is now "on": the sidecar parts show as before
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("center-enabled")).toBeChecked();
    await expect(page.getByTestId("center-start-sidecar")).toHaveCount(0);
  });

  test("clearing the remote removes it (the start button stays until saved; then nothing is connected and the switch is back)", async ({ page }) => {
    await page.getByTestId("center-remote-clear").click();
    await expect(page.getByTestId("center-remote-current")).toBeHidden();
    await expect(page.getByTestId("center-enabled")).toHaveCount(0);
    await expect(page.getByTestId("center-start-sidecar")).toBeVisible();
    await expect(page.getByTestId("settings-save")).toBeEnabled();
    await page.getByTestId("settings-save").click();
    await expect(page.getByTestId("settings-dialog")).toBeHidden();
    expect(await mock(page, (m) => m.center)).not.toHaveProperty("remote");
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("center-enabled")).toBeVisible();
    await expect(page.getByTestId("center-state")).toHaveText("stopped");
    await expect(page.getByTestId("center-start-sidecar")).toHaveCount(0);
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
    await expect(dlg.getByTestId("center-common-section-add-dirs")).toBeVisible();
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

// Reference folders (addDirs) are paths on the center's host picked with this PC's folder dialog: sidecar only.
// "OFF" below = sidecar OFF + remote connection; "ON" = the sidecar on (boardSeed: enabled).
type FolderMock = {
  center: Record<string, unknown>;
  centerSettings: Record<string, Record<string, unknown>>;
  centerCommonSettings: Record<string, unknown>;
  calls: { cmd: string; args?: Record<string, unknown> }[];
};
const folderMock = <T>(page: Page, fn: (m: FolderMock) => T) =>
  page.evaluate(
    (src) =>
      new Function("m", `return (${src})(m)`)((window as unknown as { __BANTOU_MOCK__: FolderMock }).__BANTOU_MOCK__),
    fn.toString(),
  ) as Promise<T>;
const goRemote = (page: Page) =>
  folderMock(page, (m) => {
    m.center.enabled = false;
    m.center.remote = { url: "http://mac200:7910/mcp", token: "tok-saved-remote-0123" };
  });
const gear = (page: Page) => page.locator('[data-testid=session-settings-open][data-name="careery"]');

test.describe("reference folders: sidecar only", () => {
  test.use({ seed: boardSeed });

  test("project settings (gear), sidecar ON: the folders show", async ({ page }) => {
    await page.goto("/");
    await folderMock(page, (m) => {
      m.centerSettings.careery = { addDirs: ["/srv/docs"] };
    });
    await gear(page).click();
    const dlg = page.getByTestId("settings-dialog");
    await expect(dlg.getByTestId("settings-section-instructions")).toBeVisible();
    await expect(dlg.getByTestId("settings-section-add-dirs")).toBeVisible();
    await expect(dlg.getByTestId("settings-add-dir").first()).toHaveValue("/srv/docs");
  });

  test("project settings (gear), sidecar OFF + remote: no folders; saving keeps the saved folders", async ({ page }) => {
    await page.goto("/");
    await folderMock(page, (m) => {
      m.centerSettings.careery = { addDirs: ["/srv/docs", "/srv/more"] };
    });
    await goRemote(page);
    await gear(page).click();
    const dlg = page.getByTestId("settings-dialog");
    await expect(dlg.getByTestId("settings-section-instructions")).toBeVisible();
    await expect(dlg.getByTestId("settings-instructions")).toHaveValue("");
    await expect(dlg.getByTestId("settings-section-add-dirs")).toHaveCount(0);
    await expect(dlg.getByTestId("settings-add-dir-add")).toHaveCount(0);
    await dlg.getByTestId("settings-instructions").fill("remote の session の指示");
    await dlg.getByTestId("settings-save").click();
    await expect(dlg).toBeHidden();
    // the folders were not sent (an item left out is unchanged), so they stay
    const call = await folderMock(page, (m) => m.calls.find((c) => c.cmd === "update_session_settings" || c.cmd === "session_update_settings"));
    expect(call?.args).toBeDefined();
    expect(JSON.stringify(call?.args)).not.toContain("addDirs");
    expect(await folderMock(page, (m) => m.centerSettings)).toEqual({
      careery: { addDirs: ["/srv/docs", "/srv/more"], instructions: "remote の session の指示" },
    });
  });

  test("project settings (gear), sidecar OFF + remote: a saved relative folder does not block the save", async ({ page }) => {
    await page.goto("/");
    await folderMock(page, (m) => {
      m.centerSettings.careery = { addDirs: ["rel/path"] };
    });
    await goRemote(page);
    await gear(page).click();
    const dlg = page.getByTestId("settings-dialog");
    await expect(dlg.getByTestId("settings-section-instructions")).toBeVisible();
    await dlg.getByTestId("settings-instructions").fill("x");
    await expect(dlg.getByTestId("settings-problem")).toHaveCount(0);
    await expect(dlg.getByTestId("settings-save")).toBeEnabled();
  });

  test("add dialog: the folders show with the sidecar ON, not with OFF + remote (and none are sent)", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("open-add-session").click();
    await expect(page.getByTestId("add-section-instructions")).toBeVisible();
    await expect(page.getByTestId("add-section-add-dirs")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("add-dialog")).toBeHidden();

    await goRemote(page);
    await page.getByTestId("open-add-session").click();
    await expect(page.getByTestId("add-section-instructions")).toBeVisible();
    await expect(page.getByTestId("add-section-add-dirs")).toHaveCount(0);
    await page.getByTestId("add-name").fill("pm-remote");
    await page.getByTestId("add-instructions").fill("指示だけ");
    await page.getByTestId("add-create").click();
    await expect(page.getByTestId("add-dialog")).toBeHidden();
    const call = await folderMock(page, (m) => m.calls.find((c) => c.cmd === "create_session"));
    expect(call?.args).toEqual({ name: "pm-remote", path: null, settings: { instructions: "指示だけ" } });
  });

  test("center-wide settings: the folders show with the sidecar ON, not with OFF + remote; saving keeps the saved folders", async ({ page }) => {
    await page.goto("/");
    await folderMock(page, (m) => {
      m.centerCommonSettings = { addDirs: ["/common/ref"] };
    });
    // ON
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("center-common-instructions")).toBeEnabled();
    await expect(page.getByTestId("center-common-section-add-dirs")).toBeVisible();
    await expect(page.getByTestId("center-common-add-dir").first()).toHaveValue("/common/ref");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-dialog")).toBeHidden();

    // OFF + remote
    await goRemote(page);
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("center-common-instructions")).toBeEnabled();
    await expect(page.getByTestId("center-common-section-add-dirs")).toHaveCount(0);
    await page.getByTestId("center-common-instructions").fill("remote の共通指示");
    await page.getByTestId("settings-save").click();
    await expect(page.getByTestId("settings-dialog")).toBeHidden();
    const call = await folderMock(page, (m) => m.calls.find((c) => c.cmd === "center_call" && (c.args as { name?: string }).name === "center_settings_update"));
    expect(JSON.stringify(call?.args)).not.toContain("addDirs");
    expect(await folderMock(page, (m) => m.centerCommonSettings)).toEqual({ addDirs: ["/common/ref"], instructions: "remote の共通指示" });

    // the dialog's own edits (start button) do not change what is hidden: the saved state decides
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("center-common-instructions")).toHaveValue("remote の共通指示");
    await page.getByTestId("center-start-sidecar").click();
    await expect(page.getByTestId("center-common-section-add-dirs")).toHaveCount(0);
    // saved as on: reopened, the folders show with their saved value
    await page.getByTestId("settings-save").click();
    await expect(page.getByTestId("settings-dialog")).toBeHidden();
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("center-common-section-add-dirs")).toBeVisible();
    await expect(page.getByTestId("center-common-add-dir").first()).toHaveValue("/common/ref");
  });

  test("center-wide settings, sidecar ON + remote saved: switching off in the dialog keeps the switch and the folders (checked and sent)", async ({ page }) => {
    await page.goto("/");
    await folderMock(page, (m) => {
      m.center.remote = { url: "http://mac200:7910/mcp", token: "tok-saved-remote-0123" };
      m.centerCommonSettings = { addDirs: ["/common/ref"] };
    });
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("center-common-instructions")).toBeEnabled();
    await expect(page.getByTestId("center-common-section-add-dirs")).toBeVisible();
    await page.getByTestId("center-enabled").click();
    // the switch stays (it can be switched on again) and the folders stay in the form
    await expect(page.getByTestId("center-enabled")).toBeVisible();
    await expect(page.getByTestId("center-common-section-add-dirs")).toBeVisible();
    await page.getByTestId("center-common-add-dir").first().fill("rel/path");
    await expect(page.getByTestId("center-common-problem")).toContainText("参照フォルダは絶対パスで指定する");
    await page.getByTestId("center-common-add-dir").first().fill("/common/other");
    await page.getByTestId("center-enabled").click();
    await expect(page.getByTestId("center-enabled")).toBeChecked();
    await page.getByTestId("settings-save").click();
    await expect(page.getByTestId("settings-dialog")).toBeHidden();
    expect(await folderMock(page, (m) => m.centerCommonSettings)).toEqual({ addDirs: ["/common/other"] });
  });
});
