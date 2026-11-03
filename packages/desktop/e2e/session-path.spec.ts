import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { boardSeed } from "./seed";

type Mock = {
  centerWorkspace: string | null;
  centerCanPick: boolean;
  pickedDirectory: string | null;
  centerSessions: Record<string, unknown>[];
  calls: { cmd: string; args?: Record<string, unknown> }[];
};

/** Run `fn(mock, arg)` in the page. `fn` is serialized: it must not capture anything. */
const mock = <T, A = undefined>(page: Page, fn: (m: Mock, a: A) => T, arg?: A) =>
  page.evaluate(
    ([src, a]) =>
      new Function("m", "a", `return (${src})(m, a)`)((window as unknown as { __BANTOU_MOCK__: Mock }).__BANTOU_MOCK__, a),
    [fn.toString(), arg] as [string, A | undefined],
  ) as Promise<T>;

const createCalls = (page: Page) =>
  mock(page, (m) => m.calls.filter((c) => c.cmd === "create_session").map((c) => c.args ?? {}));

test.describe("session folder (path)", () => {
  test.use({ seed: boardSeed });

  test("the folder field is empty and shows the center's default, following the name", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("open-add-session").click();
    const dlg = page.getByTestId("add-dialog");
    const folder = dlg.getByTestId("add-folder");
    await expect(folder).toHaveValue("");
    await expect(folder).toHaveAttribute("placeholder", "/mock/ws/<名前>");
    await dlg.getByTestId("add-name").fill("pm-x");
    await expect(folder).toHaveAttribute("placeholder", "/mock/ws/pm-x");
    // a center that has no workspace (or an older one): a generic hint instead
    await mock(page, (m) => {
      m.centerWorkspace = null;
    });
    await page.keyboard.press("Escape");
    await page.getByTestId("open-add-session").click();
    await expect(page.getByTestId("add-folder")).toHaveAttribute("placeholder", /空ならセンターが決める/);
  });

  test("empty folder: session_create gets no path; a typed folder is passed as typed (trimmed)", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("open-add-session").click();
    let dlg = page.getByTestId("add-dialog");
    await dlg.getByTestId("add-name").fill("no-path");
    await dlg.getByTestId("add-create").click();
    await expect(dlg).toBeHidden();
    await page.getByTestId("open-add-session").click();
    dlg = page.getByTestId("add-dialog");
    await dlg.getByTestId("add-name").fill("with-path");
    await dlg.getByTestId("add-folder").fill("  /data/proj/with-path ");
    await dlg.getByTestId("add-create").click();
    await expect(dlg).toBeHidden();
    const calls = await createCalls(page);
    expect(calls.map((c) => [c.name, c.path])).toEqual([
      ["no-path", null],
      ["with-path", "/data/proj/with-path"],
    ]);
    expect(await mock(page, (m) => m.centerSessions.find((s) => s.name === "with-path")?.path)).toBe("/data/proj/with-path");
  });

  test("the center's errors (relative path, path in use) are shown and the dialog stays", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("open-add-session").click();
    const dlg = page.getByTestId("add-dialog");
    await dlg.getByTestId("add-name").fill("rel");
    await dlg.getByTestId("add-folder").fill("relative/dir");
    await dlg.getByTestId("add-create").click();
    await expect(dlg.getByTestId("add-action-error")).toContainText("path は絶対パスで指定する");
    await expect(dlg).toBeVisible();
    // the path of an existing session
    const used = await mock(page, (m) => String(m.centerSessions[0].path));
    await dlg.getByTestId("add-folder").fill(used);
    await dlg.getByTestId("add-create").click();
    await expect(dlg.getByTestId("add-action-error")).toContainText(`path が既に使われている: ${used}`);
    await expect(dlg).toBeVisible();
  });

  test("own center on macOS / Windows: a folder dialog fills the field; cancel keeps it", async ({ page }) => {
    await page.goto("/");
    await mock(page, (m) => {
      m.centerCanPick = true;
      m.pickedDirectory = "/Users/me/work/pm";
    });
    await page.getByTestId("open-add-session").click();
    const dlg = page.getByTestId("add-dialog");
    await dlg.getByTestId("add-folder-pick").click();
    await expect(dlg.getByTestId("add-folder")).toHaveValue("/Users/me/work/pm");
    await mock(page, (m) => {
      m.pickedDirectory = null;
    });
    await dlg.getByTestId("add-folder-pick").click();
    await expect(dlg.getByTestId("add-folder")).toHaveValue("/Users/me/work/pm");
  });

  test("another host's center (or no dialog on this OS): no folder dialog button, typing only, and it says the path is on the center", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("open-add-session").click();
    const dlg = page.getByTestId("add-dialog");
    await expect(dlg.getByTestId("add-folder")).toBeVisible();
    await expect(dlg.getByTestId("add-folder-pick")).toHaveCount(0);
    await expect(dlg).toContainText("center のホスト上の絶対パス（この PC のパスではない）");
  });

  test("the gear dialog shows the session's folder read-only, with the note that it is fixed at creation", async ({ page }) => {
    await page.goto("/");
    await page.locator("[data-testid=session-settings-open][data-name=careery]").click();
    const dlg = page.getByTestId("settings-dialog");
    const expected = await mock(page, (m) => String(m.centerSessions.find((s) => s.name === "careery")?.path));
    await expect(dlg.getByTestId("settings-path")).toHaveValue(expected);
    await expect(dlg.getByTestId("settings-path")).toHaveAttribute("readonly", "");
    await expect(dlg).toContainText("作成時に決まる");
    // read-only: the dialog is not dirty
    await expect(dlg.getByTestId("settings-save")).toBeDisabled();
  });
});
