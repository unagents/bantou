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
  test("the settings dialog has no center-wide instructions field", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("open-settings").click();
    await page.getByTestId("center-enabled").click();
    await expect(page.getByTestId("center-claude-path")).toBeVisible();
    await expect(page.getByTestId("center-session-instructions")).toHaveCount(0);
    await expect(page.getByText("master-cap への追加指示（system prompt に追記）")).toHaveCount(0);
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
    expect(call?.args).toEqual({ name: "pm-ins", settings: { instructions: MULTI } });
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
