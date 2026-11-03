import type { Page } from "@playwright/test";

import { expect, pickSession, sideRow, test } from "./fixtures";
import { boardSeed } from "./seed";

type Mock = {
  centerSessions: Record<string, unknown>[];
  sessionDefs: Record<string, { instructions?: string }>;
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

  test.describe("heading edit", () => {
    test.use({ seed: boardSeed });

    test("the heading opens a multi-line editor with the note; saving keeps it per session and shows it again", async ({ page }) => {
      await page.goto("/");
      await pickSession(page, "careery");
      const section = page.locator('section[aria-label="careery"]');
      await section.getByTestId("session-instructions-open").click();
      const dlg = page.getByTestId("instructions-dialog");
      await expect(dlg.getByTestId("instructions-text")).toHaveValue("");
      await expect(dlg.getByTestId("instructions-note")).toHaveText(NOTE);
      await expect(dlg.getByTestId("instructions-save")).toBeDisabled();
      await dlg.getByTestId("instructions-text").fill(MULTI);
      await dlg.getByTestId("instructions-save").click();
      await expect(dlg).toBeHidden();
      expect(await mock(page, (m) => m.sessionDefs)).toEqual({ careery: { instructions: MULTI } });

      // reopen: the saved text; another session has none
      await section.getByTestId("session-instructions-open").click();
      await expect(page.getByTestId("instructions-text")).toHaveValue(MULTI);
      await page.keyboard.press("Escape");
      await pickSession(page, "stroke-board");
      await page.locator('section[aria-label="stroke-board"]').getByTestId("session-instructions-open").click();
      await expect(page.getByTestId("instructions-text")).toHaveValue("");
      await page.keyboard.press("Escape");

      // clearing is a change that removes it
      await pickSession(page, "careery");
      await section.getByTestId("session-instructions-open").click();
      await page.getByTestId("instructions-text").fill("");
      await page.getByTestId("instructions-save").click();
      await expect(page.getByTestId("instructions-dialog")).toBeHidden();
      expect(await mock(page, (m) => m.sessionDefs)).toEqual({});
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
    expect(call?.args).toEqual({ name: "pm-ins", instructions: MULTI });
    expect(await mock(page, (m) => m.sessionDefs)).toEqual({ "pm-ins": { instructions: MULTI } });
  });

  test("creating without instructions sends none and saves none", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("open-add-session").click();
    await page.getByTestId("add-name").fill("pm-plain");
    await page.getByTestId("add-instructions").fill("  \n ");
    await page.getByTestId("add-create").click();
    await expect(page.getByTestId("add-dialog")).toBeHidden();
    const call = await mock(page, (m) => m.calls.filter((c) => c.cmd === "create_session").at(-1));
    expect(call?.args?.instructions ?? null).toBeNull();
    expect(await mock(page, (m) => m.sessionDefs)).toEqual({});
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
