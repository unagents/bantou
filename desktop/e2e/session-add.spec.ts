import { resolve } from "node:path";

import type { Page } from "@playwright/test";

import { expect, pickSession, sideRow, test } from "./fixtures";
import { SHOT_DIR } from "./paths";
import { boardSeed } from "./seed";

type Mock = {
  center: { enabled: boolean; remote?: { url: string; token?: string } };
  centerReachable: boolean;
  centerSessions: Record<string, unknown>[];
  centerSessionCreateError: string | null;
  calls: { cmd: string }[];
  centerDrop: (name: string) => void;
  centerRunning: () => void;
  osWake: () => void;
  osNetworkChanged: () => void;
};

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

const session = (page: Page, name: string) => page.locator(`section[aria-label="${name}"]`);
const refreshCount = (page: Page) =>
  withMock(page, (m) => m.calls.filter((c) => c.cmd === "refresh_sessions").length);
/** Any click in the window re-reads the center first. */
const act = (page: Page) => page.locator("header h1").click();

/** Put a session on the center that bantou has not added. */
const centerHas = (page: Page, name: string) =>
  withMock(
    page,
    (m, n) => {
      m.centerSessions.push({
        name: n,
        path: "/x",
        state: "connected",
        pid: 1,
        sessionUrl: `https://claude.ai/code/${n}`,
        startedAt: null,
        source: "session",
      });
    },
    name,
  );

test.describe("center on", () => {
  test.use({ seed: boardSeed });

  test("the side menu is the center's list: a session made elsewhere shows up, one that left disappears", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "careery");
    await expect(sideRow(page, "webtool")).toHaveCount(0);
    // made on the center by someone else (another desktop, MCP)
    await centerHas(page, "webtool");
    await act(page);
    await expect(sideRow(page, "webtool")).toBeVisible();
    await pickSession(page, "webtool");
    await page.screenshot({ path: resolve(SHOT_DIR, "session-added.png"), fullPage: true });
    // gone from the center: gone from the menu (no "lost" row), the others stay
    await withMock(page, (m) => m.centerDrop("careery"));
    await act(page);
    await expect(sideRow(page, "careery")).toHaveCount(0);
    await expect(sideRow(page, "stroke-board")).toBeVisible();
    await expect(page.getByTestId("side-unreachable")).toHaveCount(0);
    // the center takes it back
    await centerHas(page, "careery");
    await act(page);
    await expect(sideRow(page, "careery")).toBeVisible();
  });

  test("a name is created on the center and listed", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("open-add-session").click();
    const dlg = page.getByTestId("add-dialog");
    // create only: the center's list is not offered for picking
    await expect(dlg.getByTestId("add-row")).toHaveCount(0);
    await expect(dlg.getByTestId("add-submit")).toHaveCount(0);
    await dlg.getByTestId("add-name").fill("pm-main_1");
    await dlg.getByTestId("add-create").click();
    await expect(dlg).toBeHidden();
    await pickSession(page, "pm-main_1");
    expect(await withMock(page, (m) => m.centerSessions.some((s) => s.name === "pm-main_1"))).toBe(true);
  });

  test("a name already used or invalid cannot be created", async ({ page }) => {
    await page.goto("/");
    await centerHas(page, "center-only");
    await page.getByTestId("open-add-session").click();
    const dlg = page.getByTestId("add-dialog");
    // listed by the center (made here or elsewhere)
    for (const taken of ["careery", "center-only"]) {
      await dlg.getByTestId("add-name").fill(taken);
      await expect(dlg).toContainText("既に使われている名前");
      await expect(dlg.getByTestId("add-create")).toBeDisabled();
    }
    for (const bad of ["pm a", "pm.a", "ピーエム", "a/b"]) {
      await dlg.getByTestId("add-name").fill(bad);
      await expect(dlg).toContainText("英数字と _ - のみ");
      await expect(dlg.getByTestId("add-create")).toBeDisabled();
    }
    await dlg.getByTestId("add-name").fill("");
    await expect(dlg.getByTestId("add-create")).toBeDisabled();
  });

  test("a failure of the center on create is shown and nothing is listed", async ({ page }) => {
    await page.goto("/");
    await withMock(page, (m) => {
      m.centerSessionCreateError = "claude が見つからない";
    });
    await page.getByTestId("open-add-session").click();
    await page.getByTestId("add-name").fill("pm-x");
    await page.getByTestId("add-create").click();
    await expect(page.getByTestId("add-action-error")).toContainText("claude が見つからない");
    await expect(page.getByTestId("add-dialog")).toBeVisible();
    await expect(sideRow(page, "pm-x")).toHaveCount(0);
  });

  test("when the center cannot be asked, the last list stays with 'つながらない' (no 'ロスト')", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "careery");
    await expect(page.getByTestId("side-unreachable")).toHaveCount(0);
    await withMock(page, (m) => {
      m.centerReachable = false;
    });
    await act(page);
    await expect(page.getByTestId("side-unreachable")).toHaveText("つながらない");
    await expect(page.getByTestId("session-unreachable")).toHaveCount(1);
    await expect(page.getByTestId("side-lost")).toHaveCount(0);
    // the rows (last list) and tasks stay
    for (const n of ["agent-messenger", "careery", "stroke-board"]) await expect(sideRow(page, n)).toBeVisible();
    await expect(session(page, "careery")).toContainText("スキルシート xlsx 取込の列マッピング");
    // answered again: back to normal
    await withMock(page, (m) => {
      m.centerReachable = true;
    });
    await act(page);
    await expect(page.getByTestId("side-unreachable")).toHaveCount(0);
    await expect(page.getByTestId("session-unreachable")).toHaveCount(0);
  });

  test("the center does not answer at start and answers a bit later: the list appears without any action", async ({ page }) => {
    // before the app starts reading (init scripts run after the mock is installed)
    await page.addInitScript(() => {
      const m = (window as unknown as { __BANTOU_MOCK__: Mock & { sessionCache: unknown } }).__BANTOU_MOCK__;
      m.centerReachable = false;
      // the Rust cache is empty at start
      m.sessionCache = { sessions: [], reachable: true, reason: null, rev: 0 };
    });
    await page.goto("/");
    await expect(page.getByTestId("side-unreachable")).toHaveText("つながらない");
    await expect(sideRow(page, "careery")).toHaveCount(0);
    await withMock(page, (m) => {
      m.centerReachable = true;
    });
    // no click, no key: the start-up retry (every 2 s) picks it up
    await expect(sideRow(page, "careery")).toBeVisible({ timeout: 8000 });
    await expect(page.getByTestId("side-unreachable")).toHaveCount(0);
    // answered: the retry stops (no more reads without a trigger)
    const n = await refreshCount(page);
    await page.waitForTimeout(2600);
    expect(await refreshCount(page)).toBe(n);
  });

  test("the sidecar center started: the list is read at once", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "careery");
    const before = await refreshCount(page);
    await withMock(page, (m) => m.centerRunning());
    await expect.poll(() => refreshCount(page)).toBeGreaterThan(before);
  });

  test("unreachable, then answered without a session: it is gone (not 'ロスト')", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "careery");
    await withMock(page, (m) => {
      m.centerReachable = false;
      m.centerDrop("careery");
    });
    await act(page);
    await expect(page.getByTestId("side-unreachable")).toBeVisible();
    await expect(sideRow(page, "careery")).toBeVisible();
    await withMock(page, (m) => {
      m.centerReachable = true;
    });
    await act(page);
    await expect(sideRow(page, "careery")).toHaveCount(0);
    await expect(page.getByTestId("side-unreachable")).toHaveCount(0);
    await expect(sideRow(page, "stroke-board")).toBeVisible();
  });

  test("the list is read again before every action in the window", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "careery");
    const before = await refreshCount(page);
    await act(page);
    await expect.poll(() => refreshCount(page)).toBeGreaterThan(before);
    const mid = await refreshCount(page);
    await page.keyboard.press("Shift");
    await expect.poll(() => refreshCount(page)).toBeGreaterThan(mid);
    // a button press reads it too
    await pickSession(page, "stroke-board");
    const last = await refreshCount(page);
    await page.getByRole("button", { name: "stroke-board にタスク追加を指示" }).click();
    await expect.poll(() => refreshCount(page)).toBeGreaterThan(last);
  });

  test("wake from sleep and a network change read the list again", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "careery");
    await withMock(page, (m) => m.centerDrop("careery"));
    const before = await refreshCount(page);
    await withMock(page, (m) => m.osWake());
    await expect(sideRow(page, "careery")).toHaveCount(0);
    expect(await refreshCount(page)).toBeGreaterThan(before);

    // a burst of network events is read once, after it settles
    await centerHas(page, "careery");
    const mid = await refreshCount(page);
    await withMock(page, (m) => {
      m.osNetworkChanged();
      m.osNetworkChanged();
      m.osNetworkChanged();
    });
    await expect(sideRow(page, "careery")).toBeVisible();
    expect((await refreshCount(page)) - mid).toBe(1);
  });

  test("closing the settings dialog reads the list again (the target may have changed)", async ({ page }) => {
    await page.goto("/");
    await pickSession(page, "careery");
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    // the new target answers without careery
    await withMock(page, (m) => m.centerDrop("careery"));
    const before = await refreshCount(page);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-dialog")).toBeHidden();
    await expect(sideRow(page, "careery")).toHaveCount(0);
    expect(await refreshCount(page)).toBeGreaterThan(before);
  });
});

test.describe("no center of our own", () => {
  test("the button is disabled with the reason while the center is off and has no remote", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("open-add-session")).toBeDisabled();
    await expect(page.getByTestId("add-disabled-reason")).toContainText("center が無効で接続先も無い");
    await withMock(page, (m) => {
      m.center.enabled = false;
      m.center.remote = { url: "http://mac200:7910", token: "tok-remote-0123456789" };
    });
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-dialog")).toBeHidden();
    await expect(page.getByTestId("open-add-session")).toBeEnabled();
    await expect(page.getByTestId("add-disabled-reason")).toHaveCount(0);
  });

  test("the dialog shows the failure when the center does not answer", async ({ page }) => {
    await page.goto("/");
    await withMock(page, (m) => {
      m.center.enabled = true;
      m.centerReachable = false;
    });
    await page.getByTestId("open-settings").click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("open-add-session")).toBeEnabled();
    await page.getByTestId("open-add-session").click();
    await expect(page.getByTestId("side-unreachable")).toBeVisible();
    await page.getByTestId("add-name").fill("pm-y");
    await page.getByTestId("add-create").click();
    await expect(page.getByTestId("add-action-error")).toContainText("接続できない");
  });
});

test.describe("no folder selected", () => {
  test.use({ seed: { dir: null, tasks: [], threads: [] } });

  test("the add button is in the header without a folder", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "フォルダを開く" })).toBeVisible();
    await expect(page.getByTestId("open-add-session")).toBeVisible();
  });
});
