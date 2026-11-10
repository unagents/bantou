import type { Page } from "@playwright/test";

import { expect, pickSession, sideRow, test } from "./fixtures";
import { boardSeed } from "./seed";

type Mock = {
  centerSessions: Record<string, unknown>[];
  centerSettings: Record<string, Record<string, unknown>>;
  calls: { cmd: string; args?: Record<string, unknown> }[];
  loginCalls: { tool: string; name: string; resume?: boolean }[];
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
  test("the settings dialog has the center-wide instructions: read from the center, saved to it with the one save button, shown again", async ({ page }) => {
    await page.goto("/");
    await mock(page, (m) => {
      (m as unknown as { centerCommonSettings: Record<string, unknown> }).centerCommonSettings = { instructions: "共通の最初" };
    });
    await page.getByTestId("open-settings").click();
    const field = page.getByTestId("center-common-instructions");
    await expect(field).toHaveValue("共通の最初");
    await expect(page.getByTestId("center-common-instructions-note")).toHaveText(NOTE);
    // the common part has no save button of its own any more
    await expect(page.getByTestId("center-common-save")).toHaveCount(0);
    const save = page.getByTestId("settings-save");
    await expect(save).toBeDisabled();
    await field.fill(MULTI);
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByText("設定を保存した", { exact: true })).toBeVisible();
    // saving closes the dialog
    await expect(page.getByTestId("settings-dialog")).toBeHidden();
    // it went to the center's tool, not to this PC's settings.json
    const sent = await mock(page, (m) => m.calls.filter((c) => c.cmd === "center_call" && (c.args as { name: string }).name === "center_settings_update").map((c) => c.args));
    expect(sent).toEqual([{ name: "center_settings_update", arguments: { settings: { instructions: MULTI, addDirs: null, outputStyle: null, servers: null, memory: null } } }]);
    expect(await mock(page, (m) => (m as unknown as { centerCommonSettings: Record<string, unknown> }).centerCommonSettings)).toEqual({ instructions: MULTI });
    // only the common part changed: the center config API was not called
    expect(await mock(page, (m) => m.calls.filter((c) => c.cmd === "center_set_settings").length)).toBe(0);
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("center-common-instructions")).toHaveValue(MULTI);
    // blank removes it (null to the center)
    await page.getByTestId("center-common-instructions").fill("");
    await page.getByTestId("settings-save").click();
    await expect(page.getByTestId("settings-dialog")).toBeHidden();
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
    await expect(page.getByTestId("settings-save")).toBeDisabled();
  });

  test("one save writes the common and the center settings (one call each); one changed part calls only its API", async ({ page }) => {
    const count = (cmd: "center_set_settings" | "center_settings_update") =>
      cmd === "center_set_settings"
        ? mock(page, (m) => m.calls.filter((c) => c.cmd === "center_set_settings").length)
        : mock(page, (m) => m.calls.filter((c) => c.cmd === "center_call" && (c.args as { name: string }).name === "center_settings_update").length);
    await page.goto("/");
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("center-common-instructions")).toBeEnabled();
    // both parts changed -> both APIs once
    await page.getByTestId("center-enabled").click();
    await page.getByTestId("center-port").fill("7920");
    await page.getByTestId("center-common-instructions").fill("共通 A");
    await page.getByTestId("settings-save").click();
    await expect(page.getByTestId("settings-dialog")).toBeHidden();
    expect(await count("center_set_settings")).toBe(1);
    expect(await count("center_settings_update")).toBe(1);
    expect(await mock(page, (m) => (m as unknown as { centerCommonSettings: Record<string, unknown> }).centerCommonSettings)).toEqual({ instructions: "共通 A" });
    expect(await mock(page, (m) => (m as unknown as { center: { port: number } }).center.port)).toBe(7920);
    // only the center part changed -> only center_set_settings
    await page.getByTestId("open-settings").click();
    await page.getByTestId("center-port").fill("7930");
    await page.getByTestId("settings-save").click();
    await expect(page.getByTestId("settings-dialog")).toBeHidden();
    expect(await count("center_set_settings")).toBe(2);
    expect(await count("center_settings_update")).toBe(1);
    // only the common part changed -> only center_settings_update
    await page.getByTestId("open-settings").click();
    await page.getByTestId("center-common-instructions").fill("共通 B");
    await page.getByTestId("settings-save").click();
    await expect(page.getByTestId("settings-dialog")).toBeHidden();
    expect(await count("center_set_settings")).toBe(2);
    expect(await count("center_settings_update")).toBe(2);
  });

  test("a failed common save names the common part, saves nothing else and keeps the dialog open", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("center-common-instructions")).toBeEnabled();
    await page.getByTestId("center-enabled").click();
    await page.getByTestId("center-common-instructions").fill("共通 C");
    await mock(page, (m) => {
      (m as unknown as { centerCommonSettingsError: string | null }).centerCommonSettingsError = "共通を保存できない: mock";
    });
    await page.getByTestId("settings-save").click();
    await expect(page.getByTestId("settings-error")).toContainText("共通の設定の保存に失敗した");
    await expect(page.getByTestId("settings-error")).toContainText("共通を保存できない: mock");
    await expect(page.getByTestId("center-common-error")).toContainText("共通を保存できない: mock");
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    // the center config was not touched
    expect(await mock(page, (m) => m.calls.filter((c) => c.cmd === "center_set_settings").length)).toBe(0);
    // retry after the center is back saves both
    await mock(page, (m) => {
      (m as unknown as { centerCommonSettingsError: string | null }).centerCommonSettingsError = null;
    });
    await page.getByTestId("settings-save").click();
    await expect(page.getByTestId("settings-dialog")).toBeHidden();
    expect(await mock(page, (m) => m.calls.filter((c) => c.cmd === "center_set_settings").length)).toBe(1);
  });

  test("a failed center save after the common part was saved names the center part, keeps the common part saved and the dialog open", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("center-common-instructions")).toBeEnabled();
    await page.getByTestId("center-enabled").click();
    await page.getByTestId("center-common-instructions").fill("共通 D");
    await mock(page, (m) => {
      (m as unknown as { centerSetSettingsError: string | null }).centerSetSettingsError = "center を保存できない: mock";
    });
    await page.getByTestId("settings-save").click();
    await expect(page.getByTestId("settings-error")).toContainText("center の設定の保存に失敗した（共通の設定は保存済み）");
    await expect(page.getByTestId("settings-error")).toContainText("center を保存できない: mock");
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    expect(await mock(page, (m) => (m as unknown as { centerCommonSettings: Record<string, unknown> }).centerCommonSettings)).toEqual({ instructions: "共通 D" });
    // retry: the common part is no longer a change, so only the center API is called again
    await mock(page, (m) => {
      (m as unknown as { centerSetSettingsError: string | null }).centerSetSettingsError = null;
    });
    await page.getByTestId("settings-save").click();
    await expect(page.getByTestId("settings-dialog")).toBeHidden();
    const calls = (name: string) => mock(page, (m) => m.calls.filter((c) => c.cmd === "center_call" && (c.args as { name: string }).name === "center_settings_update").length);
    expect(await calls("center_settings_update")).toBe(1);
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

  test("a failing folder dialog turns the add button into typed rows (blank row, typed, saved)", async ({ page }) => {
    await page.goto("/");
    await mock(page, (m) => {
      (m as unknown as { centerCanPick: boolean }).centerCanPick = true;
      (m as unknown as { pickError: string | null }).pickError = "no dialog";
    });
    await page.locator('[data-testid=session-settings-open][data-name="careery"]').click();
    const dlg = page.getByTestId("settings-dialog");
    await expect(dlg.getByTestId("settings-add-dir-add")).toHaveText("フォルダを追加…");
    await dlg.getByTestId("settings-add-dir-add").click();
    await expect(dlg.getByTestId("settings-error")).toContainText("no dialog");
    await expect(dlg.getByTestId("settings-add-dir")).toHaveCount(0);
    await expect(dlg.getByTestId("settings-add-dir-add")).toHaveText("パスを入力して追加");
    await dlg.getByTestId("settings-add-dir-add").click();
    await expect(dlg.getByTestId("settings-add-dir")).toHaveCount(1);
    await expect(dlg.getByTestId("settings-add-dir").first()).not.toHaveAttribute("readonly", "");
    await dlg.getByTestId("settings-add-dir").first().fill("/typed/ref");
    await dlg.getByTestId("settings-save").click();
    await expect(dlg).toBeHidden();
    expect(await mock(page, (m) => m.centerSettings)).toEqual({ careery: { addDirs: ["/typed/ref"] } });
  });

  test("the center-wide folders fall back to typed rows when the folder dialog fails", async ({ page }) => {
    await page.goto("/");
    await mock(page, (m) => {
      (m as unknown as { pickError: string | null }).pickError = "no dialog";
    });
    await page.getByTestId("open-settings").click();
    const sec = page.getByTestId("center-common-section");
    if (!(await page.getByTestId("center-enabled").isChecked())) await page.getByTestId("center-enabled").click();
    const add = sec.getByTestId("center-common-add-dir-add");
    await expect(add).toHaveText("フォルダを追加…");
    await add.click();
    await expect(add).toHaveText("パスを入力して追加");
    await add.click();
    await sec.getByTestId("center-common-add-dir").first().fill("/typed/common");
    await page.getByTestId("settings-save").click();
    await expect(page.getByTestId("settings-dialog")).toBeHidden();
    expect(await mock(page, (m) => (m as unknown as { centerCommonSettings: Record<string, unknown> }).centerCommonSettings)).toEqual({ addDirs: ["/typed/common"] });
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
    await page.getByTestId("settings-save").click();
    await expect(page.getByTestId("settings-dialog")).toBeHidden();
    expect(await mock(page, (m) => (m as unknown as { centerCommonSettings: Record<string, unknown> }).centerCommonSettings)).toEqual({ addDirs: ["/common/ref", "/common/picked"] });
  });
});

test.describe("output style", () => {
  test.use({ seed: boardSeed });
  const STYLE = "---\nname: Concise Plus\n---\nLead with the result.\n- no filler";

  test("the center-wide output style: read from the center, saved with the one save button, blank removes it", async ({ page }) => {
    await page.goto("/");
    await mock(page, (m) => {
      (m as unknown as { centerCommonSettings: Record<string, unknown> }).centerCommonSettings = { outputStyle: "共通の style" };
    });
    await page.getByTestId("open-settings").click();
    const field = page.getByTestId("center-common-output-style");
    await expect(field).toHaveValue("共通の style");
    await expect(page.getByTestId("center-common-output-style-note")).toHaveText(NOTE);
    await expect(page.getByTestId("settings-save")).toBeDisabled();
    await field.fill(STYLE);
    await page.getByTestId("settings-save").click();
    await expect(page.getByTestId("settings-dialog")).toBeHidden();
    expect(await mock(page, (m) => (m as unknown as { centerCommonSettings: Record<string, unknown> }).centerCommonSettings)).toEqual({ outputStyle: STYLE });
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("center-common-output-style")).toHaveValue(STYLE);
    await page.getByTestId("center-common-output-style").fill("");
    await page.getByTestId("settings-save").click();
    await expect(page.getByTestId("settings-dialog")).toBeHidden();
    expect(await mock(page, (m) => (m as unknown as { centerCommonSettings: Record<string, unknown> }).centerCommonSettings)).toEqual({});
  });

  test("a session's output style is kept per session on the center; an over-long text is rejected", async ({ page }) => {
    await page.goto("/");
    const gear = (name: string) => page.locator(`[data-testid=session-settings-open][data-name="${name}"]`);
    await gear("careery").click();
    const dlg = page.getByTestId("settings-dialog");
    await expect(dlg.getByTestId("settings-section-output-style")).toBeVisible();
    await expect(dlg.getByTestId("settings-output-style")).toHaveValue("");
    await dlg.getByTestId("settings-output-style").fill("x".repeat(32_001));
    await expect(dlg.getByTestId("settings-save")).toBeDisabled();
    await expect(dlg.getByText("出力スタイルは 32000 文字以内")).toBeVisible();
    await dlg.getByTestId("settings-output-style").fill(STYLE);
    await dlg.getByTestId("settings-save").click();
    await expect(dlg).toBeHidden();
    expect(await mock(page, (m) => m.centerSettings)).toEqual({ careery: { outputStyle: STYLE } });
    await gear("stroke-board").click();
    await expect(page.getByTestId("settings-output-style")).toHaveValue("");
    await page.keyboard.press("Escape");
    await gear("careery").click();
    await expect(page.getByTestId("settings-output-style")).toHaveValue(STYLE);
  });

  test("the add dialog sends the output style with session_create", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("open-add-session").click();
    await page.getByTestId("add-name").fill("pm-style");
    await page.getByTestId("add-output-style").fill(STYLE);
    await page.getByTestId("add-create").click();
    await expect(page.getByTestId("add-dialog")).toBeHidden();
    const call = await mock(page, (m) => m.calls.find((c) => c.cmd === "create_session"));
    expect(call?.args).toEqual({ name: "pm-style", path: null, settings: { outputStyle: STYLE } });
  });
});

test.describe("restart from the gear", () => {
  test.use({ seed: boardSeed });
  const gear = (page: Page, name: string) => page.locator(`[data-testid=session-settings-open][data-name="${name}"]`);

  test("「再起動」: nothing to save, rc_stop then rc_start with resume; the dialog closes", async ({ page }) => {
    await page.goto("/");
    await gear(page, "careery").click();
    const dlg = page.getByTestId("settings-dialog");
    await expect(dlg.getByTestId("settings-restart")).toHaveText(/^再起動$/);
    await expect(dlg.getByTestId("settings-save")).toBeDisabled();
    await dlg.getByTestId("settings-restart").click();
    await expect(dlg).toBeHidden();
    expect(await mock(page, (m) => m.loginCalls)).toEqual([
      { tool: "rc_stop", name: "careery" },
      { tool: "rc_start", name: "careery", resume: true },
    ]);
    expect(await mock(page, (m) => m.calls.filter((c) => c.cmd === "center_call" && (c.args as { name: string }).name === "session_settings_update").length)).toBe(0);
  });

  test("「保存して再起動」: saves the settings to the center first, then restarts; an invalid form disables it", async ({ page }) => {
    await page.goto("/");
    await gear(page, "careery").click();
    const dlg = page.getByTestId("settings-dialog");
    await dlg.getByTestId("settings-instructions").fill("x".repeat(16_001));
    await expect(dlg.getByTestId("settings-restart")).toBeDisabled();
    await dlg.getByTestId("settings-instructions").fill(MULTI);
    await expect(dlg.getByTestId("settings-restart")).toHaveText("保存して再起動");
    await dlg.getByTestId("settings-restart").click();
    await expect(dlg).toBeHidden();
    expect(await mock(page, (m) => m.centerSettings)).toEqual({ careery: { instructions: MULTI } });
    expect(await mock(page, (m) => m.loginCalls)).toEqual([
      { tool: "rc_stop", name: "careery" },
      { tool: "rc_start", name: "careery", resume: true },
    ]);
  });

  test("a rename restarts on the center already: 「保存して再起動」 does not stop / start it again", async ({ page }) => {
    await page.goto("/");
    await gear(page, "careery").click();
    const dlg = page.getByTestId("settings-dialog");
    await dlg.getByTestId("settings-name").fill("career-2");
    await dlg.getByTestId("settings-restart").click();
    await expect(dlg).toBeHidden();
    await expect(page.locator("[data-testid=session-settings-open][data-name=career-2]")).toBeVisible();
    expect(await mock(page, (m) => m.loginCalls)).toEqual([]);
  });
});

test.describe("external memory", () => {
  test.use({ seed: boardSeed });
  const URL_ = "http://mem.local:3000/mcp";
  const common = (page: Page) => mock(page, (m) => (m as unknown as { centerCommonSettings: Record<string, unknown> }).centerCommonSettings);

  test("the center-wide memory: saved with the one save button; the token is a password field, sent once, never shown again", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("center-common-section-memory")).toBeVisible();
    await expect(page.getByTestId("center-common-memory-token")).toHaveAttribute("type", "password");
    await expect(page.getByTestId("center-common-memory-note")).toHaveText(NOTE);
    await expect(page.getByTestId("center-common-memory-token-set")).toHaveCount(0);
    await page.getByTestId("center-common-memory-url").fill(URL_);
    await page.getByTestId("center-common-memory-token").fill("SECRET-TOKEN-1");
    await page.getByTestId("center-common-memory-agent-id").fill("pm_1");
    await page.getByTestId("settings-save").click();
    await expect(page.getByTestId("settings-dialog")).toBeHidden();
    const sent = await mock(page, (m) => m.calls.filter((c) => c.cmd === "center_call" && (c.args as { name: string }).name === "center_settings_update").map((c) => c.args));
    expect(sent).toEqual([{ name: "center_settings_update", arguments: { settings: { instructions: null, addDirs: null, outputStyle: null, servers: null, memory: { url: URL_, token: "SECRET-TOKEN-1", agentId: "pm_1" } } } }]);
    expect(await common(page)).toEqual({ memory: { url: URL_, token: "SECRET-TOKEN-1", agentId: "pm_1" } });
    // reopened: url / agent ID shown, the token is not (only "set")
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("center-common-memory-url")).toHaveValue(URL_);
    await expect(page.getByTestId("center-common-memory-agent-id")).toHaveValue("pm_1");
    await expect(page.getByTestId("center-common-memory-token")).toHaveValue("");
    await expect(page.getByTestId("center-common-memory-token-set")).toBeVisible();
    expect(await page.locator("body").innerText()).not.toContain("SECRET-TOKEN-1");
    expect(await page.getByTestId("settings-dialog").innerHTML()).not.toContain("SECRET-TOKEN-1");
    await expect(page.getByTestId("settings-save")).toBeDisabled();
    // change only the url: the token is not sent (the center keeps it)
    await page.getByTestId("center-common-memory-url").fill("https://mem2.example/mcp");
    await page.getByTestId("settings-save").click();
    await expect(page.getByTestId("settings-dialog")).toBeHidden();
    expect(await common(page)).toEqual({ memory: { url: "https://mem2.example/mcp", token: "SECRET-TOKEN-1", agentId: "pm_1" } });
    // the token can be removed on its own
    await page.getByTestId("open-settings").click();
    await page.getByTestId("center-common-memory-token-clear").click();
    await page.getByTestId("settings-save").click();
    await expect(page.getByTestId("settings-dialog")).toBeHidden();
    expect(await common(page)).toEqual({ memory: { url: "https://mem2.example/mcp", agentId: "pm_1" } });
    // a blank url removes the item (null)
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("center-common-memory-token-set")).toHaveCount(0);
    await page.getByTestId("center-common-memory-url").fill("");
    await page.getByTestId("center-common-memory-agent-id").fill("");
    await page.getByTestId("settings-save").click();
    await expect(page.getByTestId("settings-dialog")).toBeHidden();
    expect(await common(page)).toEqual({});
  });

  test("a bad url / token / agent ID is refused before saving (http(s) absolute url, no user:pass@, no spaces in the token, agent ID [A-Za-z0-9_-])", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("open-settings").click();
    const save = page.getByTestId("settings-save");
    const url = page.getByTestId("center-common-memory-url");
    await url.fill("mem.local/mcp");
    await expect(save).toBeDisabled();
    await expect(page.getByText("外部記憶の URL は http / https の絶対 URL")).toBeVisible();
    await url.fill("ftp://mem.local/mcp");
    await expect(save).toBeDisabled();
    await url.fill("http://user:pw@mem.local/mcp");
    await expect(save).toBeDisabled();
    await expect(page.getByText("user:pass@ は書けない")).toBeVisible();
    await url.fill(URL_);
    await expect(save).toBeEnabled();
    await page.getByTestId("center-common-memory-token").fill("a b");
    await expect(save).toBeDisabled();
    await expect(page.getByText("外部記憶の token に空白・制御文字・日本語は使えない")).toBeVisible();
    await page.getByTestId("center-common-memory-token").fill("");
    await page.getByTestId("center-common-memory-agent-id").fill("a b");
    await expect(save).toBeDisabled();
    await expect(page.getByText("外部記憶の agent ID は英数字と _ - のみ")).toBeVisible();
    await page.getByTestId("center-common-memory-agent-id").fill("a".repeat(65));
    await expect(save).toBeDisabled();
    await page.getByTestId("center-common-memory-agent-id").fill("ok-1");
    await expect(save).toBeEnabled();
    // a token / agent ID without a url cannot be saved
    await url.fill("");
    await expect(save).toBeDisabled();
    await expect(page.getByText("外部記憶の URL を入れる")).toBeVisible();
  });

  test("a session's memory is kept per session on the center and replaces the common one; the token is not returned", async ({ page }) => {
    await page.goto("/");
    const gear = (name: string) => page.locator(`[data-testid=session-settings-open][data-name="${name}"]`);
    await gear("careery").click();
    const dlg = page.getByTestId("settings-dialog");
    await expect(dlg.getByTestId("settings-section-memory")).toBeVisible();
    await expect(dlg.getByTestId("settings-memory-url")).toHaveValue("");
    await expect(dlg.getByTestId("settings-memory-token")).toHaveAttribute("type", "password");
    await dlg.getByTestId("settings-memory-url").fill(URL_);
    await dlg.getByTestId("settings-memory-token").fill("SESSION-SECRET");
    await dlg.getByTestId("settings-save").click();
    await expect(dlg).toBeHidden();
    expect(await mock(page, (m) => m.centerSettings)).toEqual({ careery: { memory: { url: URL_, token: "SESSION-SECRET" } } });
    await gear("stroke-board").click();
    await expect(page.getByTestId("settings-memory-url")).toHaveValue("");
    await page.keyboard.press("Escape");
    await gear("careery").click();
    await expect(page.getByTestId("settings-memory-url")).toHaveValue(URL_);
    await expect(page.getByTestId("settings-memory-token")).toHaveValue("");
    await expect(page.getByTestId("settings-memory-token-set")).toBeVisible();
    expect(await page.getByTestId("settings-dialog").innerHTML()).not.toContain("SESSION-SECRET");
  });

  test("the add dialog sends the memory with session_create (and nothing when it is blank)", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("open-add-session").click();
    await page.getByTestId("add-name").fill("pm-mem");
    await page.getByTestId("add-memory-url").fill(URL_);
    await page.getByTestId("add-memory-token").fill("ADD-SECRET");
    await page.getByTestId("add-create").click();
    await expect(page.getByTestId("add-dialog")).toBeHidden();
    const call = await mock(page, (m) => m.calls.find((c) => c.cmd === "create_session"));
    expect(call?.args).toEqual({ name: "pm-mem", path: null, settings: { memory: { url: URL_, token: "ADD-SECRET" } } });
    await page.getByTestId("open-add-session").click();
    await page.getByTestId("add-name").fill("pm-plain");
    await page.getByTestId("add-create").click();
    await expect(page.getByTestId("add-dialog")).toBeHidden();
    const calls = await mock(page, (m) => m.calls.filter((c) => c.cmd === "create_session").map((c) => c.args));
    expect(calls[1]).toEqual({ name: "pm-plain", path: null, settings: {} });
  });
});
