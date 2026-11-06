import type { Page } from "@playwright/test";

import { expect, pickSession, sideRow, test } from "./fixtures";
import { boardSeed } from "./seed";

type Mock = {
  centerSessions: Record<string, unknown>[];
  centerSettings: Record<string, Record<string, unknown>>;
  calls: { cmd: string; args?: Record<string, unknown> }[];
};

/** Run `fn(mock)` in the page. `fn` is serialized: it must not capture anything. */
const mock = <T>(page: Page, fn: (m: Mock) => T) =>
  page.evaluate(
    (src) =>
      new Function("m", `return (${src})(m)`)((window as unknown as { __BANTOU_MOCK__: Mock }).__BANTOU_MOCK__),
    fn.toString(),
  ) as Promise<T>;

const MULTI = "常に日本語で答える\n2 行目: \"quote\" $HOME\n\n4 行目";
const NOTE = "保存後に起動する session から効く。動いている session には効かない";

test.describe("session instructions", () => {
  test("the settings dialog has the center-wide instructions: read from the center, saved to it with its own button, shown again", async ({ page }) => {
    await page.goto("/");
    await mock(page, (m) => {
      (m as unknown as { centerCommonSettings: Record<string, unknown> }).centerCommonSettings = { instructions: "共通の最初" };
    });
    await page.getByTestId("open-settings").click();
    const field = page.getByTestId("center-common-instructions");
    await expect(field).toHaveValue("共通の最初");
    await expect(page.getByTestId("center-common-instructions-note")).toHaveText(NOTE);
    const save = page.getByTestId("center-common-save");
    await expect(save).toBeDisabled();
    await field.fill(MULTI);
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByText("共通の設定を保存した", { exact: true })).toBeVisible();
    await expect(save).toBeDisabled();
    // it went to the center's tool, not to this PC's settings.json
    const sent = await mock(page, (m) => m.calls.filter((c) => c.cmd === "center_call" && (c.args as { name: string }).name === "center_settings_update").map((c) => c.args));
    expect(sent).toEqual([{ name: "center_settings_update", arguments: { settings: { instructions: MULTI, addDirs: null } } }]);
    expect(await mock(page, (m) => (m as unknown as { centerCommonSettings: Record<string, unknown> }).centerCommonSettings)).toEqual({ instructions: MULTI });
    // the main save button is untouched by this (the center config did not change)
    await expect(page.getByTestId("settings-save")).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("center-common-instructions")).toHaveValue(MULTI);
    // blank removes it (null to the center)
    await page.getByTestId("center-common-instructions").fill("");
    await page.getByTestId("center-common-save").click();
    await expect(page.getByText("共通の設定を保存した", { exact: true })).toBeVisible();
    expect(await mock(page, (m) => (m as unknown as { centerCommonSettings: Record<string, unknown> }).centerCommonSettings)).toEqual({});
  });

  test("the center-wide instructions field reports when the center cannot be asked, and rejects an over-long text", async ({ page }) => {
    await page.goto("/");
    await mock(page, (m) => {
      (m as unknown as { centerCommonSettingsError: string | null }).centerCommonSettingsError = "center に接続できない: mock";
    });
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("center-common-error")).toContainText("center に接続できない: mock");
    await expect(page.getByTestId("center-common-instructions")).toBeDisabled();
    await page.keyboard.press("Escape");
    await mock(page, (m) => {
      (m as unknown as { centerCommonSettingsError: string | null }).centerCommonSettingsError = null;
    });
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("center-common-instructions")).toBeEnabled();
    await page.getByTestId("center-common-instructions").fill("x".repeat(16_001));
    await expect(page.getByTestId("center-common-problem")).toHaveText("追加指示は 16000 文字以内");
    await expect(page.getByTestId("center-common-save")).toBeDisabled();
  });

  test.describe("sidebar gear", () => {
    test.use({ seed: boardSeed });

    test("the gear on a side row opens the project settings; saving keeps it on the center per session and shows it again", async ({ page }) => {
      await page.goto("/");
      const gear = (name: string) => page.locator(`[data-testid=session-settings-open][data-name="${name}"]`);
      await gear("careery").click();
      const dlg = page.getByTestId("settings-dialog");
      await expect(dlg.getByTestId("settings-section-instructions")).toBeVisible();
      await expect(dlg.getByTestId("settings-instructions")).toHaveValue("");
      await expect(dlg.getByTestId("settings-instructions-note")).toHaveText(NOTE);
      await expect(dlg.getByTestId("settings-save")).toBeDisabled();
      await dlg.getByTestId("settings-instructions").fill(MULTI);
      await dlg.getByTestId("settings-save").click();
      await expect(dlg).toBeHidden();
      expect(await mock(page, (m) => m.centerSettings)).toEqual({ careery: { instructions: MULTI } });

      // reopen: the saved text; another session has none
      await gear("careery").click();
      await expect(page.getByTestId("settings-instructions")).toHaveValue(MULTI);
      await page.keyboard.press("Escape");
      await gear("stroke-board").click();
      await expect(page.getByTestId("settings-instructions")).toHaveValue("");
      await page.keyboard.press("Escape");

      // clearing is a change that removes it
      await gear("careery").click();
      await page.getByTestId("settings-instructions").fill("");
      await page.getByTestId("settings-save").click();
      await expect(page.getByTestId("settings-dialog")).toBeHidden();
      expect(await mock(page, (m) => m.centerSettings)).toEqual({});
    });

    test("the dialog reads the initial value from the center; a failed save shows the error and saves nothing", async ({ page }) => {
      await page.goto("/");
      await page.evaluate(() => {
        const m = (window as unknown as { __BANTOU_MOCK__: Mock & { centerSettingsUpdateError: string | null } }).__BANTOU_MOCK__;
        m.centerSettings.careery = { instructions: "center にある文" };
        m.centerSettingsUpdateError = "center に接続できない: mock";
      });
      await page.locator('[data-testid=session-settings-open][data-name="careery"]').click();
      const dlg = page.getByTestId("settings-dialog");
      await expect(dlg.getByTestId("settings-instructions")).toHaveValue("center にある文");
      await dlg.getByTestId("settings-instructions").fill("変えた文");
      await dlg.getByTestId("settings-save").click();
      await expect(dlg.getByTestId("settings-error")).toContainText("center に接続できない");
      await expect(dlg).toBeVisible();
      expect(await mock(page, (m) => m.centerSettings)).toEqual({ careery: { instructions: "center にある文" } });
      // a retry after the center is back succeeds
      await page.evaluate(() => {
        (window as unknown as { __BANTOU_MOCK__: { centerSettingsUpdateError: string | null } }).__BANTOU_MOCK__.centerSettingsUpdateError = null;
      });
      await dlg.getByTestId("settings-save").click();
      await expect(dlg).toBeHidden();
      expect(await mock(page, (m) => m.centerSettings)).toEqual({ careery: { instructions: "変えた文" } });
    });

    test("the gear is disabled for a project from the center config", async ({ page }) => {
      await page.goto("/");
      await page.evaluate(() => {
        const s = (window as unknown as { __BANTOU_MOCK__: Mock }).__BANTOU_MOCK__.centerSessions.find((x) => x.name === "careery");
        if (s) s.source = "config";
      });
      await page.locator("header h1").click();
      await expect(page.locator('[data-testid=session-settings-open][data-name="careery"]')).toBeDisabled();
      await expect(page.locator('[data-testid=session-settings-open][data-name="stroke-board"]')).toBeEnabled();
    });

    test("the gear does not select the row; an over-long text cannot be saved", async ({ page }) => {
      await page.goto("/");
      await pickSession(page, "careery");
      await page.locator(`[data-testid=session-settings-open][data-name="stroke-board"]`).click();
      await expect(sideRow(page, "careery")).toHaveAttribute("aria-current", "true");
      const dlg = page.getByTestId("settings-dialog");
      await dlg.getByTestId("settings-instructions").fill("あ".repeat(16001));
      await expect(dlg.getByTestId("settings-problem")).toBeVisible();
      await expect(dlg.getByTestId("settings-save")).toBeDisabled();
      await dlg.getByTestId("settings-instructions").fill("あ".repeat(16000));
      await expect(dlg.getByTestId("settings-problem")).toHaveCount(0);
      await expect(dlg.getByTestId("settings-save")).toBeEnabled();
    });
  });

  test.describe("add dialog", () => {
  test.use({ seed: boardSeed });

  test("the add dialog has the field with the note and sends the text to the center when creating", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("open-add-session").click();
    const dlg = page.getByTestId("add-dialog");
    await expect(dlg.getByTestId("add-instructions")).toHaveValue("");
    await expect(dlg.getByTestId("add-instructions-note")).toHaveText(NOTE);
    await dlg.getByTestId("add-name").fill("pm-ins");
    await dlg.getByTestId("add-instructions").fill(MULTI);
    await dlg.getByTestId("add-create").click();
    await expect(dlg).toBeHidden();
    const call = await mock(page, (m) => m.calls.filter((c) => c.cmd === "create_session").at(-1));
    expect(call?.args).toEqual({ name: "pm-ins", path: null, settings: { instructions: MULTI } });
    expect(await mock(page, (m) => m.centerSettings)).toEqual({ "pm-ins": { instructions: MULTI } });
  });

  test("creating without instructions sends none and saves none", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("open-add-session").click();
    await page.getByTestId("add-name").fill("pm-plain");
    await page.getByTestId("add-instructions").fill("  \n ");
    await page.getByTestId("add-create").click();
    await expect(page.getByTestId("add-dialog")).toBeHidden();
    const call = await mock(page, (m) => m.calls.filter((c) => c.cmd === "create_session").at(-1));
    expect(call?.args?.settings?.instructions ?? null).toBeNull();
    expect(await mock(page, (m) => m.centerSettings)).toEqual({});
  });
  });

  test.describe("session mark", () => {
    test.use({ seed: boardSeed });

    test("a small mark shows on the side row and the header only for a session started with instructions", async ({ page }) => {
      await page.goto("/");
      await pickSession(page, "careery");
      const mark = (name: string) => sideRow(page, name).getByTestId("session-instructions-mark");
      await expect(mark("careery")).toHaveCount(0);
      await page.evaluate(() => {
        const s = (window as unknown as { __BANTOU_MOCK__: Mock }).__BANTOU_MOCK__.centerSessions.find((x) => x.name === "careery");
        if (s) s.instructions = true;
      });
      // any click in the window re-reads the center first
      await page.locator("header h1").click();
      await expect(mark("careery")).toHaveCount(1);
      await expect(page.locator('section[aria-label="careery"]').getByTestId("session-instructions-mark")).toHaveCount(1);
      await expect(mark("stroke-board")).toHaveCount(0);
    });
  });
});

test.describe("reference folders (--add-dir)", () => {
  test.use({ seed: boardSeed });

  test("the gear dialog lists the session's folders; rows are typed or picked, removed, and saved to the center without blanks or duplicates", async ({ page }) => {
    await page.goto("/");
    await mock(page, (m) => {
      m.centerSettings.careery = { addDirs: ["/srv/docs"] };
      (m as unknown as { centerCanPick: boolean; pickedDirectory: string | null }).centerCanPick = true;
      (m as unknown as { pickedDirectory: string | null }).pickedDirectory = "/Users/me/shared";
    });
    await page.locator('[data-testid=session-settings-open][data-name="careery"]').click();
    const dlg = page.getByTestId("settings-dialog");
    await expect(dlg.getByTestId("settings-section-add-dirs")).toBeVisible();
    await expect(dlg.getByTestId("settings-add-dir")).toHaveCount(1);
    await expect(dlg.getByTestId("settings-add-dir").first()).toHaveValue("/srv/docs");
    await expect(dlg.getByTestId("settings-add-dirs-note")).toHaveText(NOTE);
    await expect(dlg.getByTestId("settings-save")).toBeDisabled();
    // picked on this PC (own sidecar): "追加" opens the dialog and adds the chosen folder as one row; rows are read-only
    await expect(dlg.getByTestId("settings-add-dir").first()).toHaveAttribute("readonly", "");
    await dlg.getByTestId("settings-add-dir-add").click();
    await expect(dlg.getByTestId("settings-add-dir")).toHaveCount(2);
    await expect(dlg.getByTestId("settings-add-dir").nth(1)).toHaveValue("/Users/me/shared");
    // a cancelled dialog adds no (blank) row
    await mock(page, (m) => {
      (m as unknown as { pickedDirectory: string | null }).pickedDirectory = null;
    });
    await dlg.getByTestId("settings-add-dir-add").click();
    await expect(dlg.getByTestId("settings-add-dir")).toHaveCount(2);
    // a row is changed through the dialog (click on the field or its button); a cancel keeps the value
    await dlg.getByTestId("settings-add-dir").first().click();
    await expect(dlg.getByTestId("settings-add-dir").first()).toHaveValue("/srv/docs");
    await mock(page, (m) => {
      (m as unknown as { pickedDirectory: string | null }).pickedDirectory = "/Users/me/other";
    });
    await dlg.getByTestId("settings-add-dir").first().click();
    await expect(dlg.getByTestId("settings-add-dir").first()).toHaveValue("/Users/me/other");
    await mock(page, (m) => {
      (m as unknown as { pickedDirectory: string | null }).pickedDirectory = "/srv/docs";
    });
    await dlg.getByTestId("settings-add-dir-row-pick").first().click();
    await expect(dlg.getByTestId("settings-add-dir").first()).toHaveValue("/srv/docs");
    await dlg.getByTestId("settings-save").click();
    await expect(dlg).toBeHidden();
    expect(await mock(page, (m) => m.centerSettings)).toEqual({ careery: { addDirs: ["/srv/docs", "/Users/me/shared"] } });
    // removing every row sends null (the center drops the item)
    await page.locator('[data-testid=session-settings-open][data-name="careery"]').click();
    await expect(dlg.getByTestId("settings-add-dir")).toHaveCount(2);
    await dlg.getByTestId("settings-add-dir-remove").first().click();
    await dlg.getByTestId("settings-add-dir-remove").first().click();
    await expect(dlg.getByTestId("settings-add-dir")).toHaveCount(0);
    await dlg.getByTestId("settings-save").click();
    await expect(dlg).toBeHidden();
    expect(await mock(page, (m) => m.centerSettings)).toEqual({});
  });

  test("without this PC's folder dialog (remote center) only typed rows are offered (blank row, editable text)", async ({ page }) => {
    await page.goto("/");
    await page.locator('[data-testid=session-settings-open][data-name="careery"]').click();
    const dlg = page.getByTestId("settings-dialog");
    await expect(dlg.getByTestId("settings-add-dir-add")).toBeVisible();
    await expect(dlg.getByTestId("settings-add-dir-row-pick")).toHaveCount(0);
    await dlg.getByTestId("settings-add-dir-add").click();
    await dlg.getByTestId("settings-add-dir-add").click();
    await expect(dlg.getByTestId("settings-add-dir")).toHaveCount(2);
    await expect(dlg.getByTestId("settings-add-dir").first()).not.toHaveAttribute("readonly", "");
    // a blank row and a duplicate are dropped on save, a relative path blocks the save
    await dlg.getByTestId("settings-add-dir").nth(0).fill("rel/path");
    await expect(dlg.getByTestId("settings-problem")).toHaveText("参照フォルダは絶対パスで指定する: rel/path");
    await expect(dlg.getByTestId("settings-save")).toBeDisabled();
    await dlg.getByTestId("settings-add-dir").nth(0).fill("/srv/docs");
    await dlg.getByTestId("settings-add-dir").nth(1).fill("/srv/docs");
    await dlg.getByTestId("settings-add-dir-add").click();
    await expect(dlg.getByTestId("settings-problem")).toHaveCount(0);
    await dlg.getByTestId("settings-save").click();
    await expect(dlg).toBeHidden();
    expect(await mock(page, (m) => m.centerSettings)).toEqual({ careery: { addDirs: ["/srv/docs"] } });
  });

  test("the add dialog sends the folders with session_create (only when some are set)", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("open-add-session").click();
    await page.getByTestId("add-name").fill("pm-dirs");
    await page.getByTestId("add-add-dir-add").click();
    await page.getByTestId("add-add-dir").first().fill("/data/one");
    await page.getByTestId("add-create").click();
    await expect(page.getByTestId("add-dialog")).toBeHidden();
    const call = await mock(page, (m) => m.calls.find((c) => c.cmd === "create_session"));
    expect(call?.args).toEqual({ name: "pm-dirs", path: null, settings: { addDirs: ["/data/one"] } });
    expect(await mock(page, (m) => m.centerSettings)).toEqual({ "pm-dirs": { addDirs: ["/data/one"] } });
  });

  test("the center-wide settings carry folders too; the folder dialog follows the own center switch", async ({ page }) => {
    await page.goto("/");
    await mock(page, (m) => {
      (m as unknown as { centerCommonSettings: Record<string, unknown> }).centerCommonSettings = { addDirs: ["/common/ref"] };
      (m as unknown as { pickedDirectory: string | null }).pickedDirectory = "/common/picked";
    });
    await page.getByTestId("open-settings").click();
    const sec = page.getByTestId("center-common-section");
    await expect(sec.getByTestId("center-common-add-dir")).toHaveCount(1);
    await expect(sec.getByTestId("center-common-add-dir").first()).toHaveValue("/common/ref");
    // the folder dialog is for the own center (this PC's folders): it follows the "center を起動する" switch
    // (dialog mode: read-only rows and an "add" that opens the dialog; otherwise typed rows)
    const enabled = await page.getByTestId("center-enabled").isChecked();
    const addBtn = sec.getByTestId("center-common-add-dir-add");
    await expect(addBtn).toHaveText(enabled ? "フォルダを追加…" : "パスを入力して追加");
    await page.getByTestId("center-enabled").click();
    await expect(addBtn).toHaveText(enabled ? "パスを入力して追加" : "フォルダを追加…");
    if (enabled) await page.getByTestId("center-enabled").click();
    await expect(sec.getByTestId("center-common-add-dir").first()).toHaveAttribute("readonly", "");
    await addBtn.click();
    await expect(sec.getByTestId("center-common-add-dir")).toHaveCount(2);
    await sec.getByTestId("center-common-save").click();
    await expect(page.getByText("共通の設定を保存した", { exact: true })).toBeVisible();
    expect(await mock(page, (m) => (m as unknown as { centerCommonSettings: Record<string, unknown> }).centerCommonSettings)).toEqual({ addDirs: ["/common/ref", "/common/picked"] });
  });
});
