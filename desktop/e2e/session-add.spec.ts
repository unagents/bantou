import { resolve } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { SHOT_DIR } from "./paths";
import { boardSeed } from "./seed";

type Mock = {
  center: { enabled: boolean; remote?: { url: string; token?: string } };
  centerReachable: boolean;
  centerSessions: Record<string, unknown>[];
  centerSessionCreateError: string | null;
  calls: { cmd: string }[];
  centerDrop: (name: string) => void;
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

  test("pick a session from the center's list and add it", async ({ page }) => {
    await page.goto("/");
    await expect(session(page, "careery")).toBeVisible();
    await centerHas(page, "webtool");
    await page.getByTestId("open-add-session").click();
    const dlg = page.getByTestId("add-dialog");
    await expect(dlg.locator("[data-testid=add-row][data-name=webtool]")).toBeVisible();
    // the ones already added are not listed
    await expect(dlg.locator("[data-testid=add-row][data-name=careery]")).toHaveCount(0);
    await expect(dlg.getByTestId("add-submit")).toBeDisabled();
    await dlg.locator("[data-testid=add-row][data-name=webtool]").click();
    await dlg.getByTestId("add-submit").click();
    await expect(dlg).toBeHidden();
    await expect(session(page, "webtool")).toBeVisible();
    await expect(session(page, "webtool").getByTestId("session-lost")).toHaveCount(0);
    await page.screenshot({ path: resolve(SHOT_DIR, "session-added.png"), fullPage: true });
  });

  test("a name that is not on the center's list is created and added", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("open-add-session").click();
    await page.getByTestId("add-name").fill("pm-main_1");
    await page.getByTestId("add-create").click();
    await expect(page.getByTestId("add-dialog")).toBeHidden();
    await expect(session(page, "pm-main_1")).toBeVisible();
    expect(await withMock(page, (m) => m.centerSessions.some((s) => s.name === "pm-main_1"))).toBe(true);
  });

  test("a name already used or invalid cannot be created", async ({ page }) => {
    await page.goto("/");
    await centerHas(page, "center-only");
    await page.getByTestId("open-add-session").click();
    const dlg = page.getByTestId("add-dialog");
    // added already / only on the center
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

  test("a failure of the center on create is shown and nothing is added", async ({ page }) => {
    await page.goto("/");
    await withMock(page, (m) => {
      m.centerSessionCreateError = "claude が見つからない";
    });
    await page.getByTestId("open-add-session").click();
    await page.getByTestId("add-name").fill("pm-x");
    await page.getByTestId("add-create").click();
    await expect(page.getByTestId("add-action-error")).toContainText("claude が見つからない");
    await expect(page.getByTestId("add-dialog")).toBeVisible();
    await expect(session(page, "pm-x")).toHaveCount(0);
  });

  test("a session that left the center's list is shown as lost, the others stay", async ({ page }) => {
    await page.goto("/");
    await expect(session(page, "careery")).toBeVisible();
    await expect(page.getByTestId("session-lost")).toHaveCount(0);
    await withMock(page, (m) => m.centerDrop("careery"));
    await act(page);
    await expect(session(page, "careery").getByTestId("session-lost")).toHaveText("ロスト");
    await expect(session(page, "careery").getByTestId("session-unreachable")).toHaveCount(0);
    await expect(session(page, "stroke-board").getByTestId("session-lost")).toHaveCount(0);
    // its tasks are still there
    await expect(session(page, "careery")).toContainText("スキルシート xlsx 取込の列マッピング");
    // the center takes it back
    await centerHas(page, "careery");
    await act(page);
    await expect(session(page, "careery").getByTestId("session-lost")).toHaveCount(0);
  });

  test("when the center cannot be asked, rows say 'つながらない' and not 'ロスト'", async ({ page }) => {
    await page.goto("/");
    await expect(session(page, "careery")).toBeVisible();
    await withMock(page, (m) => {
      m.centerReachable = false;
    });
    await act(page);
    await expect(page.getByTestId("session-unreachable")).toHaveCount(3);
    await expect(page.getByTestId("session-unreachable").first()).toHaveText("つながらない");
    await expect(page.getByTestId("session-lost")).toHaveCount(0);
    // rows and tasks stay
    await expect(session(page, "careery")).toContainText("スキルシート xlsx 取込の列マッピング");
    // answered again: back to listed
    await withMock(page, (m) => {
      m.centerReachable = true;
    });
    await act(page);
    await expect(page.getByTestId("session-unreachable")).toHaveCount(0);
    await expect(page.getByTestId("session-lost")).toHaveCount(0);
  });

  test("unreachable, then answered without the session: lost", async ({ page }) => {
    await page.goto("/");
    await expect(session(page, "careery")).toBeVisible();
    await withMock(page, (m) => {
      m.centerReachable = false;
      m.centerDrop("careery");
    });
    await act(page);
    await expect(session(page, "careery").getByTestId("session-unreachable")).toBeVisible();
    await withMock(page, (m) => {
      m.centerReachable = true;
    });
    await act(page);
    await expect(session(page, "careery").getByTestId("session-lost")).toBeVisible();
    await expect(session(page, "stroke-board").getByTestId("session-lost")).toHaveCount(0);
  });

  test("the list is read again before every action in the window", async ({ page }) => {
    await page.goto("/");
    await expect(session(page, "careery")).toBeVisible();
    const before = await refreshCount(page);
    await act(page);
    await expect.poll(() => refreshCount(page)).toBeGreaterThan(before);
    const mid = await refreshCount(page);
    await page.keyboard.press("Shift");
    await expect.poll(() => refreshCount(page)).toBeGreaterThan(mid);
    // a button press reads it too
    const last = await refreshCount(page);
    await page.getByRole("button", { name: "stroke-board にタスク追加を指示" }).click();
    await expect.poll(() => refreshCount(page)).toBeGreaterThan(last);
  });

  test("wake from sleep and a network change read the list again", async ({ page }) => {
    await page.goto("/");
    await expect(session(page, "careery")).toBeVisible();
    await withMock(page, (m) => m.centerDrop("careery"));
    const before = await refreshCount(page);
    await withMock(page, (m) => m.osWake());
    await expect(session(page, "careery").getByTestId("session-lost")).toBeVisible();
    expect(await refreshCount(page)).toBeGreaterThan(before);

    // a burst of network events is read once, after it settles
    await centerHas(page, "careery");
    const mid = await refreshCount(page);
    await withMock(page, (m) => {
      m.osNetworkChanged();
      m.osNetworkChanged();
      m.osNetworkChanged();
    });
    await expect(session(page, "careery").getByTestId("session-lost")).toHaveCount(0);
    expect((await refreshCount(page)) - mid).toBe(1);
  });

  test("closing the settings dialog reads the list again (the target may have changed)", async ({ page }) => {
    await page.goto("/");
    await expect(session(page, "careery")).toBeVisible();
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    // the new target answers without careery
    await withMock(page, (m) => m.centerDrop("careery"));
    const before = await refreshCount(page);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-dialog")).toBeHidden();
    await expect(session(page, "careery").getByTestId("session-lost")).toBeVisible();
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
    await expect(page.getByTestId("add-list-error")).toContainText("接続できない");
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
