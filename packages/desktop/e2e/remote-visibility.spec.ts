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

const setSession = (page: Page, name: string, patch: Record<string, unknown>) =>
  withMock(
    page,
    (m, a) => {
      const s = m.centerSessions.find((x) => x.name === a.name);
      if (s) Object.assign(s, a.patch);
    },
    { name, patch },
  );
/** Any click in the window re-reads the center. */
const act = (page: Page) => page.locator("header h1").click();
const mark = (page: Page, name: string) => sideRow(page, name).getByTestId("session-activity");
const count = (page: Page, key: string) => page.getByTestId(`session-activity-summary-${key}`);

const UNREACHABLE = {
  running: 1,
  waitingReply: 0,
  unreachable: [{ server: "proA1989", remoteId: "c-1-stroke-board", lastOkAt: "2026-11-10T11:57:00.000Z" }],
};
const LOST = {
  running: 0,
  waitingReply: 0,
  lost: [{ server: "proA1989", remoteId: "c-1-stroke-board", at: "2026-11-10T12:26:00.000Z" }],
};

test.describe("remote visibility (unreachable server / lost cap)", () => {
  test.use({ seed: boardSeed });

  test("an unreachable server shows its own icon; the tooltip names the server and the last answer; no label text on screen", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "stroke-board");
    await setSession(page, "stroke-board", { activity: "working", state: "connected", remote: UNREACHABLE });
    await setSession(page, "agent-messenger", { activity: "idle", state: "connected" });
    await act(page);
    const m = mark(page, "stroke-board");
    await expect(m).toHaveAttribute("data-activity", "remote-unreachable");
    await expect(m).toHaveText("");
    await expect(m).toHaveAttribute("title", /^到達不能: .*proA1989（最後の応答 \d\d\/\d\d \d\d:\d\d）/);
    await expect(m).toHaveAttribute("aria-label", /^到達不能: .*proA1989/);
    // distinct from the four existing states
    await expect(mark(page, "agent-messenger")).toHaveAttribute("data-activity", "idle");
    await expect(sideRow(page, "stroke-board")).not.toContainText(/到達不能|lost/);
    // own chip (icon + count only), shown while someone is in that state
    await expect(count(page, "remote-unreachable")).toHaveText("1");
    await expect(count(page, "remote-unreachable")).toHaveAttribute("data-count", "1");
    await expect(count(page, "remote-unreachable")).toHaveAttribute("title", "到達不能");
    await expect(count(page, "remote-unreachable")).toHaveAttribute("aria-label", "到達不能 1");
    await expect(count(page, "remote-lost")).toHaveCount(0);
    await expect(page.getByTestId("session-activity-summary")).not.toContainText(/到達不能|lost|作業中|判断待ち|待機/);
    // "working" is not counted for it (the unreachable beats working)
    await expect(count(page, "working")).toHaveAttribute("data-count", "0");
  });

  test("a lost cap shows the lost icon with the server and the time in the tooltip", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "careery");
    await setSession(page, "stroke-board", { activity: "idle", state: "connected", remote: LOST });
    await act(page);
    const m = mark(page, "stroke-board");
    await expect(m).toHaveAttribute("data-activity", "remote-lost");
    await expect(m).toHaveText("");
    await expect(m).toHaveAttribute("title", /^lost: .*proA1989（\d\d\/\d\d \d\d:\d\d に通知）/);
    await expect(m).toHaveAttribute("aria-label", /^lost: .*proA1989/);
    await expect(count(page, "remote-lost")).toHaveAttribute("data-count", "1");
    await expect(count(page, "remote-unreachable")).toHaveCount(0);
    // the chip filters the rows
    await count(page, "remote-lost").click();
    await expect(sideRow(page, "stroke-board")).toBeVisible();
    await expect(sideRow(page, "agent-messenger")).toHaveCount(0);
  });

  test("an SSE event (reason remote) shows it at once, and it clears when the server answers again", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "careery");
    await setSession(page, "stroke-board", { activity: "idle", state: "connected", remote: { running: 0, waitingReply: 0 } });
    await withMock(page, (m) => m.centerSessionsChanged("remote", "stroke-board"));
    await expect(mark(page, "stroke-board")).toHaveAttribute("data-activity", "idle");
    await setSession(page, "stroke-board", { remote: UNREACHABLE });
    await withMock(page, (m) => m.centerSessionsChanged("remote", "stroke-board"));
    await expect(mark(page, "stroke-board")).toHaveAttribute("data-activity", "remote-unreachable");
    await setSession(page, "stroke-board", { remote: { running: 1, waitingReply: 0 } });
    await withMock(page, (m) => m.centerSessionsChanged("remote", "stroke-board"));
    await expect(mark(page, "stroke-board")).toHaveAttribute("data-activity", "remote-working");
    await expect(count(page, "remote-unreachable")).toHaveCount(0);
  });

  test("priority: a worker ask (needs-input) beats unreachable; unreachable beats lost and working; shown even when the session is stopped", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "careery");
    await setSession(page, "stroke-board", { activity: "working", state: "connected", remote: { ...LOST, ...UNREACHABLE, waitingReply: 1 } });
    await act(page);
    await expect(mark(page, "stroke-board")).toHaveAttribute("data-activity", "needs-input");
    await setSession(page, "stroke-board", { remote: { ...LOST, ...UNREACHABLE } });
    await act(page);
    await expect(mark(page, "stroke-board")).toHaveAttribute("data-activity", "remote-unreachable");
    await setSession(page, "stroke-board", { remote: LOST, activity: "working" });
    await act(page);
    await expect(mark(page, "stroke-board")).toHaveAttribute("data-activity", "remote-lost");
    // not connected: the remote trouble is still shown (the work state of the session itself is not)
    await setSession(page, "stroke-board", { state: "stopped" });
    await act(page);
    await expect(mark(page, "stroke-board")).toHaveAttribute("data-activity", "remote-lost");
    await setSession(page, "stroke-board", { remote: UNREACHABLE });
    await act(page);
    await expect(mark(page, "stroke-board")).toHaveAttribute("data-activity", "remote-unreachable");
    await setSession(page, "stroke-board", { remote: { running: 0, waitingReply: 0 } });
    await act(page);
    await expect(mark(page, "stroke-board")).toHaveCount(0);
  });

  test("the four existing states keep their marks and the summary keeps three chips while nothing is in trouble", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "stroke-board");
    await setSession(page, "stroke-board", { activity: "working", state: "connected", remote: { running: 0, waitingReply: 0 } });
    await act(page);
    await expect(mark(page, "stroke-board")).toHaveAttribute("data-activity", "working");
    await expect(page.getByTestId("session-activity-summary").locator("button")).toHaveCount(3);
  });
});
