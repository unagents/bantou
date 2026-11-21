import type { Page } from "@playwright/test";

import { expect, pickSession, sideRow, test } from "./fixtures";
import { boardSeed } from "./seed";

type Mock = { centerSessions: Record<string, unknown>[]; calls: { cmd: string; args?: Record<string, unknown> }[] };

/** Run `fn(mock, arg)` in the page. `fn` is serialized: it must not capture anything. */
const withMock = <T, A = undefined>(page: Page, fn: (m: Mock, a: A) => T, arg?: A) =>
  page.evaluate(
    ([src, a]) =>
      new Function("m", "a", `return (${src})(m, a)`)((window as unknown as { __BANTOU_MOCK__: Mock }).__BANTOU_MOCK__, a),
    [fn.toString(), arg] as [string, A | undefined],
  ) as Promise<T>;

const calls = (page: Page, cmd: string) => withMock(page, (m, c) => m.calls.filter((x) => x.cmd === c).map((x) => x.args ?? {}), cmd);
const sleepButton = (page: Page, name: string) => page.locator(`[data-testid=session-sleep][data-name=${name}]`);
/** Any click in the window re-reads the center first. */
const act = (page: Page) => page.locator("header h1").click();

test.describe("session sleep", () => {
  test.use({ seed: boardSeed });

  test("the sleep button sends session_sleep and the row shows スリープ; the button is disabled while asleep", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "stroke-board");
    await expect(sideRow(page, "agent-messenger").getByTestId("side-sleeping")).toHaveCount(0);
    await sleepButton(page, "agent-messenger").click();
    await expect(sideRow(page, "agent-messenger").getByTestId("side-sleeping")).toHaveText("スリープ");
    expect(await calls(page, "session_sleep")).toEqual([{ name: "agent-messenger" }]);
    expect(await withMock(page, (m) => m.centerSessions.find((s) => s.name === "agent-messenger")?.state)).toBe("stopped");
    await expect(sleepButton(page, "agent-messenger")).toBeDisabled();
    // the other rows are untouched
    await expect(sideRow(page, "stroke-board").getByTestId("side-sleeping")).toHaveCount(0);
  });

  test("opening a sleeping session wakes it (session_wake); a session that is awake is not woken", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "stroke-board");
    await withMock(page, (m) => {
      const s = m.centerSessions.find((x) => x.name === "agent-messenger");
      if (s) Object.assign(s, { sleeping: true, state: "stopped" });
    });
    await act(page);
    await expect(sideRow(page, "agent-messenger").getByTestId("side-sleeping")).toBeVisible();
    expect(await calls(page, "session_wake")).toEqual([]);
    await pickSession(page, "agent-messenger");
    await expect(sideRow(page, "agent-messenger").getByTestId("side-sleeping")).toHaveCount(0);
    expect(await calls(page, "session_wake")).toEqual([{ name: "agent-messenger" }]);
    // opening an awake session does not call session_wake again
    await pickSession(page, "stroke-board");
    await pickSession(page, "agent-messenger");
    expect(await calls(page, "session_wake")).toEqual([{ name: "agent-messenger" }]);
  });

  test("putting the open session to sleep does not wake it again", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "stroke-board");
    await sleepButton(page, "stroke-board").click();
    await expect(sideRow(page, "stroke-board").getByTestId("side-sleeping")).toBeVisible();
    await act(page);
    await expect(sideRow(page, "stroke-board").getByTestId("side-sleeping")).toBeVisible();
    expect(await calls(page, "session_wake")).toEqual([]);
    // clicking the row again opens it: it wakes
    await sideRow(page, "stroke-board").click();
    await expect(sideRow(page, "stroke-board").getByTestId("side-sleeping")).toHaveCount(0);
    expect(await calls(page, "session_wake")).toEqual([{ name: "stroke-board" }]);
  });
  test("a project from the center config has no sleep button (it cannot be put to sleep); the others do", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => {
      const s = (window as unknown as { __BANTOU_MOCK__: Mock }).__BANTOU_MOCK__.centerSessions.find((x) => x.name === "careery");
      if (s) s.source = "config";
    });
    await act(page);
    await expect(sideRow(page, "careery")).toBeVisible();
    await expect(sleepButton(page, "careery")).toHaveCount(0);
    await expect(sleepButton(page, "stroke-board")).toBeEnabled();
  });
});
