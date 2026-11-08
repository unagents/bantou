import type { Page } from "@playwright/test";

import { expect, pickSession, test } from "./fixtures";
import { boardSeed } from "./seed";

type Mock = {
  centerCanPick: boolean;
  centerSessions: Record<string, unknown>[];
  centerSettings: Record<string, Record<string, unknown>>;
  centerSessionUpdateError: string | null;
  centerSessionUpdateDelayMs: number;
  calls: { cmd: string; args?: Record<string, unknown> }[];
};

/** Run `fn(mock, arg)` in the page. `fn` is serialized: it must not capture anything. */
const mock = <T, A = undefined>(page: Page, fn: (m: Mock, a: A) => T, arg?: A) =>
  page.evaluate(
    ([src, a]) =>
      new Function("m", "a", `return (${src})(m, a)`)((window as unknown as { __BANTOU_MOCK__: Mock }).__BANTOU_MOCK__, a),
    [fn.toString(), arg] as [string, A | undefined],
  ) as Promise<T>;

const updateCalls = (page: Page) =>
  mock(page, (m) => m.calls.filter((c) => c.cmd === "session_update").map((c) => c.args ?? {}));

const openGear = (page: Page, name: string) => page.locator(`[data-testid=session-settings-open][data-name=${name}]`).click();

test.describe("session rename / move", () => {
  test.use({ seed: boardSeed });

  test("rename: session_update gets newName only, the list and the selection follow", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "careery");
    await openGear(page, "careery");
    const dlg = page.getByTestId("settings-dialog");
    await expect(dlg.getByTestId("settings-name")).toHaveValue("careery");
    await expect(dlg.getByTestId("settings-path-move")).toHaveCount(0);
    await dlg.getByTestId("settings-name").fill(" career-2 ");
    await dlg.getByTestId("settings-save").click();
    await expect(dlg).toBeHidden();
    expect(await updateCalls(page)).toEqual([{ name: "careery", newName: "career-2", path: null, moveDir: null }]);
    expect(await mock(page, (m) => m.centerSessions.map((s) => s.name))).toContain("career-2");
    await expect(page.locator("[data-testid=session-settings-open][data-name=career-2]")).toBeVisible();
    await expect(page.locator("[data-testid=session-settings-open][data-name=careery]")).toHaveCount(0);
    await expect(page.locator("[aria-current=true]")).toContainText("career-2");
  });

  test("a slow rename: the new name does not turn into 'already used' while it runs, and a repeated save sends session_update once", async ({ page }) => {
    await page.goto("/");
    await mock(page, (m) => {
      m.centerSessionUpdateDelayMs = 1500;
    });
    await openGear(page, "careery");
    const dlg = page.getByTestId("settings-dialog");
    await dlg.getByTestId("settings-name").fill("career-slow");
    // two saves before any list update arrives (double click)
    await dlg.getByTestId("settings-save").evaluate((el) => {
      for (let i = 0; i < 2; i++) (el as HTMLButtonElement).click();
    });
    // the center already lists the new name (event), the answer comes later
    await expect(page.locator("[data-testid=session-settings-open][data-name=career-slow]")).toBeVisible();
    await expect(dlg).not.toContainText("既に使われている名前");
    await dlg.getByTestId("settings-save").click({ force: true });
    await expect(dlg).toBeHidden();
    expect((await updateCalls(page)).length).toBe(1);
    await expect(page.getByTestId("settings-error")).toHaveCount(0);
  });

  test("rename keeps the project settings (center key follows) and sends session_update_settings first when both changed", async ({ page }) => {
    await page.goto("/");
    await openGear(page, "careery");
    const dlg = page.getByTestId("settings-dialog");
    await dlg.getByTestId("settings-instructions").fill("新しい指示");
    await dlg.getByTestId("settings-name").fill("career-3");
    await dlg.getByTestId("settings-save").click();
    await expect(dlg).toBeHidden();
    const order = await mock(page, (m) =>
      m.calls.filter((c) => c.cmd === "session_update_settings" || c.cmd === "session_update").map((c) => [c.cmd, c.args?.name]),
    );
    expect(order).toEqual([
      ["session_update_settings", "careery"],
      ["session_update", "careery"],
    ]);
    expect(await mock(page, (m) => m.centerSettings["career-3"]?.instructions)).toBe("新しい指示");
    expect(await mock(page, (m) => "careery" in m.centerSettings)).toBe(false);
  });

  test("folder change: move ON (default) and OFF are passed; the checkbox shows only while the path differs", async ({ page }) => {
    await page.goto("/");
    await openGear(page, "careery");
    const dlg = page.getByTestId("settings-dialog");
    const original = await dlg.getByTestId("settings-path").inputValue();
    await expect(dlg.getByTestId("settings-path-move")).toHaveCount(0);
    await dlg.getByTestId("settings-path").fill("/data/new/careery");
    await expect(dlg.getByTestId("settings-path-move")).toBeVisible();
    await expect(dlg.getByTestId("settings-path-move")).toBeChecked();
    await dlg.getByTestId("settings-path").fill(original);
    await expect(dlg.getByTestId("settings-path-move")).toHaveCount(0);
    await expect(dlg.getByTestId("settings-save")).toBeDisabled();
    await dlg.getByTestId("settings-path").fill("/data/new/careery");
    await dlg.getByTestId("settings-save").click();
    await expect(dlg).toBeHidden();

    await openGear(page, "careery");
    await dlg.getByTestId("settings-path").fill("/data/other/careery");
    await dlg.getByTestId("settings-path-move").uncheck();
    await dlg.getByTestId("settings-save").click();
    await expect(dlg).toBeHidden();
    expect(await updateCalls(page)).toEqual([
      { name: "careery", newName: null, path: "/data/new/careery", moveDir: true },
      { name: "careery", newName: null, path: "/data/other/careery", moveDir: false },
    ]);
    expect(await mock(page, (m) => m.centerSessions.find((s) => s.name === "careery")?.path)).toBe("/data/other/careery");
  });

  test("renaming a session that is not selected leaves the selection alone", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "stroke-board");
    await openGear(page, "careery");
    const dlg = page.getByTestId("settings-dialog");
    await dlg.getByTestId("settings-name").fill("career-6");
    await dlg.getByTestId("settings-save").click();
    await expect(dlg).toBeHidden();
    await expect(page.locator("[data-testid=session-settings-open][data-name=career-6]")).toBeVisible();
    await expect(page.locator("[aria-current=true]")).toContainText("stroke-board");
  });

  test("changing only the folder keeps the selection (selected or not) and refreshes the list", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "careery");
    await openGear(page, "stroke-board");
    const dlg = page.getByTestId("settings-dialog");
    await dlg.getByTestId("settings-path").fill("/data/p/stroke-board");
    await dlg.getByTestId("settings-save").click();
    await expect(dlg).toBeHidden();
    await expect(page.locator("[aria-current=true]")).toContainText("careery");
    await openGear(page, "careery");
    await dlg.getByTestId("settings-path").fill("/data/p/careery");
    await dlg.getByTestId("settings-save").click();
    await expect(dlg).toBeHidden();
    await expect(page.locator("[aria-current=true]")).toContainText("careery");
    await openGear(page, "careery");
    await expect(dlg.getByTestId("settings-path")).toHaveValue("/data/p/careery");
  });

  test("the --continue note under the folder shows only while the folder is changed", async ({ page }) => {
    await page.goto("/");
    await openGear(page, "careery");
    const dlg = page.getByTestId("settings-dialog");
    const original = await dlg.getByTestId("settings-path").inputValue();
    await expect(dlg.getByTestId("settings-path-note")).toHaveCount(0);
    await dlg.getByTestId("settings-name").fill("career-5");
    await expect(dlg.getByTestId("settings-path-note")).toHaveCount(0);
    await dlg.getByTestId("settings-path").fill("/data/new/careery");
    await expect(dlg).toContainText("保存すると session をすぐ再起動する");
    await expect(dlg).toContainText("以前の会話は引き継がれず新しい会話で始まる");
    await expect(dlg.getByTestId("settings-path-note")).toContainText("名前だけの変更なら会話は続く");
    await expect(dlg).toContainText("移動してもしなくても、以前の会話は引き継がれず新しい会話で始まる");
    await dlg.getByTestId("settings-path").fill(original);
    await expect(dlg.getByTestId("settings-path-note")).toHaveCount(0);
  });

  test("the folder dialog button shows only for the own center on macOS / Windows", async ({ page }) => {
    await page.goto("/");
    await openGear(page, "careery");
    await expect(page.getByTestId("settings-path-pick")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await mock(page, (m) => {
      m.centerCanPick = true;
    });
    await openGear(page, "careery");
    await expect(page.getByTestId("settings-path-pick")).toBeVisible();
  });

  test("a name used by another session is refused in the dialog (no call), and so is an invalid one", async ({ page }) => {
    await page.goto("/");
    await openGear(page, "careery");
    const dlg = page.getByTestId("settings-dialog");
    await dlg.getByTestId("settings-name").fill("stroke-board");
    await expect(dlg).toContainText("既に使われている名前");
    await expect(dlg.getByTestId("settings-save")).toBeDisabled();
    await dlg.getByTestId("settings-name").fill("a b");
    await expect(dlg).toContainText("英数字と _ - のみ");
    await expect(dlg.getByTestId("settings-save")).toBeDisabled();
    expect(await updateCalls(page)).toEqual([]);
  });

  test("the center's error is shown and the dialog stays", async ({ page }) => {
    await page.goto("/");
    await mock(page, (m) => {
      m.centerSessionUpdateError = "フォルダを移動できない: mock";
    });
    await openGear(page, "careery");
    const dlg = page.getByTestId("settings-dialog");
    await dlg.getByTestId("settings-name").fill("career-4");
    await dlg.getByTestId("settings-save").click();
    await expect(dlg.getByTestId("settings-error")).toContainText("フォルダを移動できない: mock");
    await expect(dlg).toBeVisible();
    await expect(page.locator("[data-testid=session-settings-open][data-name=careery]")).toBeVisible();
  });
});
