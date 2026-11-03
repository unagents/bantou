import type { Page } from "@playwright/test";

import { expect, pickSession, sideRow, test } from "./fixtures";
import { boardSeed } from "./seed";

type Mock = { center: Record<string, unknown>; centerSessions: Record<string, unknown>[] };

const mockCenter = (page: Page) =>
  page.evaluate(() => (window as unknown as { __BANTOU_MOCK__: Mock }).__BANTOU_MOCK__.center);

const MULTI = "常に日本語で答える\n2 行目: \"quote\" $HOME\n\n4 行目";

test.describe("session instructions", () => {
  test("the settings dialog shows the field (empty by default) with the note, saves multi-line text and shows it again", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("open-settings").click();
    await page.getByTestId("center-enabled").click();
    const field = page.getByTestId("center-session-instructions");
    await expect(page.getByText("master-cap への追加指示（system prompt に追記）")).toBeVisible();
    await expect(field).toHaveValue("");
    await expect(page.getByTestId("center-session-instructions-note")).toContainText("動いている session には効かない");
    await expect(page.getByTestId("center-session-instructions-note")).toContainText("自動では再起動しない");

    const save = page.getByTestId("settings-save");
    await field.fill(MULTI);
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByText("設定を保存した", { exact: true })).toBeVisible();
    expect((await mockCenter(page)).sessionInstructions).toBe(MULTI);

    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("center-session-instructions")).toHaveValue(MULTI);
    // nothing changed since the load: nothing to save
    await expect(page.getByTestId("settings-save")).toBeDisabled();
  });

  test("a saved text fills the field when the dialog opens; clearing it is a change that saves as empty", async ({ page }) => {
    await page.goto("/");
    await page.evaluate((t) => {
      const m = (window as unknown as { __BANTOU_MOCK__: Mock }).__BANTOU_MOCK__;
      m.center.enabled = true;
      m.center.sessionInstructions = t;
    }, MULTI);
    await page.getByTestId("open-settings").click();
    const field = page.getByTestId("center-session-instructions");
    await expect(field).toHaveValue(MULTI);
    await expect(page.getByTestId("settings-save")).toBeDisabled();
    await field.fill("");
    await expect(page.getByTestId("settings-save")).toBeEnabled();
    await page.getByTestId("settings-save").click();
    await expect(page.getByText("設定を保存した", { exact: true })).toBeVisible();
    expect((await mockCenter(page)).sessionInstructions).toBe("");
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
