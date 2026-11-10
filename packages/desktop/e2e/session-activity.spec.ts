import type { Page } from "@playwright/test";

import { expect, pickSession, sideRow, test } from "./fixtures";
import { boardSeed } from "./seed";

type Mock = { centerSessions: Record<string, unknown>[]; centerSessionsChanged: (reason: string, name: string) => void };

/** Run `fn(mock, arg)` in the page. `fn` is serialized: it must not capture anything. */
const withMock = <T, A = undefined>(page: Page, fn: (m: Mock, a: A) => T, arg?: A) =>
  page.evaluate(
    ([src, a]) =>
      new Function("m", "a", `return (${src})(m, a)`)(
        (window as unknown as { __BANTOU_MOCK__: Mock }).__BANTOU_MOCK__,
        a,
      ),
    [fn.toString(), arg] as [string, A | undefined],
  ) as Promise<T>;

const setActivity = (page: Page, name: string, activity: string | null, state = "connected") =>
  withMock(
    page,
    (m, a) => {
      const s = m.centerSessions.find((x) => x.name === a.name);
      if (s) {
        s.activity = a.activity;
        s.activityAt = a.activity ? "2026-11-09T10:00:00.000Z" : null;
        s.state = a.state;
      }
    },
    { name, activity, state },
  );
/** Any click in the window re-reads the center first. */
const act = (page: Page) => page.locator("header h1").click();
const mark = (page: Page, name: string) => sideRow(page, name).getByTestId("session-activity");
const count = (page: Page, key: string) => page.getByTestId(`session-activity-summary-${key}`);

test.describe("session activity", () => {
  // The seed has one waiting thread, on a task of "careery".
  test.use({ seed: boardSeed });

  test("three states are marked on the rows and counted in the summary; unknown shows nothing", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "stroke-board");
    await setActivity(page, "stroke-board", "working");
    await setActivity(page, "agent-messenger", "idle");
    await setActivity(page, "careery", "unknown");
    await act(page);
    await expect(mark(page, "stroke-board")).toHaveAttribute("data-activity", "working");
    await expect(mark(page, "stroke-board")).toHaveText("作業中");
    await expect(mark(page, "agent-messenger")).toHaveAttribute("data-activity", "idle");
    await expect(mark(page, "agent-messenger")).toHaveText("待機");
    // careery: center says unknown, but its task has a waiting thread → needs-input
    await expect(mark(page, "careery")).toHaveAttribute("data-activity", "needs-input");
    await expect(mark(page, "careery")).toHaveText("判断待ち");
    await expect(page.getByTestId("session-activity-summary")).toBeVisible();
    await expect(count(page, "working")).toHaveText("作業中 1");
    await expect(count(page, "needs-input")).toHaveText("判断待ち 1");
    await expect(count(page, "idle")).toHaveText("待機 1");
    // header counts threads, not sessions
    await expect(page.locator("header")).toContainText("返答待ち 1");
  });

  test("the center's needs-input shows without a thread; unknown / stopped show no mark", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "careery");
    await setActivity(page, "stroke-board", "needs-input");
    await setActivity(page, "agent-messenger", "working", "stopped");
    await act(page);
    await expect(mark(page, "stroke-board")).toHaveAttribute("data-activity", "needs-input");
    await expect(mark(page, "agent-messenger")).toHaveCount(0);
    await expect(count(page, "needs-input")).toHaveAttribute("data-count", "2");
    await expect(count(page, "working")).toHaveAttribute("data-count", "0");
    await setActivity(page, "stroke-board", "unknown");
    await act(page);
    await expect(mark(page, "stroke-board")).toHaveCount(0);
  });

  test("an activity SSE event re-reads the list", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "stroke-board");
    await setActivity(page, "stroke-board", "working");
    await withMock(page, (m) => m.centerSessionsChanged("activity", "stroke-board"));
    await expect(mark(page, "stroke-board")).toHaveAttribute("data-activity", "working");
  });

  test("clicking a count narrows the rows to that state, again releases it", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "stroke-board");
    await setActivity(page, "stroke-board", "working");
    await setActivity(page, "agent-messenger", "idle");
    await act(page);
    await expect(sideRow(page, "careery")).toBeVisible();
    await count(page, "idle").click();
    await expect(sideRow(page, "agent-messenger")).toBeVisible();
    await expect(sideRow(page, "stroke-board")).toHaveCount(0);
    await expect(sideRow(page, "careery")).toHaveCount(0);
    await count(page, "idle").click();
    await expect(sideRow(page, "stroke-board")).toBeVisible();
    await expect(sideRow(page, "careery")).toBeVisible();
    // the filter releases itself when its state disappears
    await count(page, "working").click();
    await expect(sideRow(page, "careery")).toHaveCount(0);
    await setActivity(page, "stroke-board", "idle");
    await act(page);
    await expect(sideRow(page, "careery")).toBeVisible();
  });

  test("screenshot", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "stroke-board");
    await setActivity(page, "stroke-board", "working");
    await setActivity(page, "agent-messenger", "idle");
    await act(page);
    await expect(mark(page, "careery")).toBeVisible();
    await page.locator("nav[aria-label=セッション一覧]").screenshot({ path: process.env.SHOT ?? "/tmp/activity-side.png" });
  });
});
