import { resolve } from "node:path";

import type { Page } from "@playwright/test";

import { expect, pickSession, sideRow, test } from "./fixtures";
import { SHOT_DIR } from "./paths";
import { boardSeed } from "./seed";

test.use({ seed: boardSeed });

type Mock = {
  centerSessions: Record<string, unknown>[];
  centerLoginUrl: string;
  centerLoginCodeResult: { ok: boolean; auth: string; error: string | null };
  loginCalls: { tool: string; name: string; code?: string; resume?: boolean }[];
  centerAuth: (name: string, auth: string, loginError?: string | null) => void;
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

const CODE = "GeMgGyG13uhJ3IOUwmUsu9AnrSijIU8bNKSQrV46RSYdATxU#e62kJfVlI11dSfkwBwbnSOCrymD9OoiBr_FYy2NODus";

const sideAuth = (page: Page, name: string) => sideRow(page, name).getByTestId("side-auth");
const termAuth = (page: Page) => page.getByTestId("terminal-auth");
const dialog = (page: Page) => page.getByTestId("login-dialog");

test("the center reports login_required: key icon in the side menu, a button in the terminal header; nothing when ok", async ({ page }) => {
  await page.goto("/");
  await pickSession(page, "careery");
  await expect(sideAuth(page, "careery")).toHaveCount(0);
  await expect(termAuth(page)).toHaveCount(0);

  // the center's GET /events says "changed": the list is re-read and the badge appears without any click
  await withMock(page, (m) => m.centerAuth("careery", "login_required"));
  await expect(sideAuth(page, "careery")).toHaveAttribute("data-auth", "login_required");
  await expect(termAuth(page)).toHaveAttribute("data-auth", "login_required");
  await expect(termAuth(page)).toHaveText(/要再ログイン/);
  // other sessions are untouched
  await expect(sideAuth(page, "stroke-board")).toHaveCount(0);

  await withMock(page, (m) => m.centerAuth("careery", "keychain_locked", "Couldn't save your login"));
  await expect(termAuth(page)).toHaveAttribute("data-auth", "keychain_locked");
  await expect(termAuth(page)).toHaveText(/keychain ロック中/);

  await withMock(page, (m) => m.centerAuth("careery", "ok"));
  await expect(sideAuth(page, "careery")).toHaveCount(0);
  await expect(termAuth(page)).toHaveCount(0);
});

test("re-login: get the URL (session_login), paste the code (session_login_code), the dialog closes and the badge goes", async ({ page }) => {
  await page.goto("/");
  await pickSession(page, "careery");
  await withMock(page, (m) => m.centerAuth("careery", "login_required"));
  await termAuth(page).click();
  await expect(dialog(page)).toBeVisible();
  // no code field before the URL
  await expect(page.getByTestId("login-code")).toHaveCount(0);

  await page.getByTestId("login-start").click();
  await expect(page.getByTestId("login-url")).toHaveText(/https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true&client_id=mock&state=mock-state/);
  await page.screenshot({ path: resolve(SHOT_DIR, "login.png") });

  await page.getByTestId("login-code").fill("bad code");
  await expect(page.getByTestId("login-send")).toBeDisabled();
  await page.getByTestId("login-code").fill(CODE);
  await page.getByTestId("login-send").click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await withMock(page, (m) => m.loginCalls)).toEqual([
    { tool: "session_login", name: "careery" },
    { tool: "session_login_code", name: "careery", code: CODE },
  ]);
  // the list is re-read after success: the badge is gone
  await expect(termAuth(page)).toHaveCount(0);
  await expect(sideAuth(page, "careery")).toHaveCount(0);
});

test("re-login failures: Invalid code keeps the code step; a locked keychain says so and goes back to the start", async ({ page }) => {
  await page.goto("/");
  await pickSession(page, "careery");
  await withMock(page, (m) => m.centerAuth("careery", "login_required"));
  await termAuth(page).click();
  await page.getByTestId("login-start").click();
  await expect(page.getByTestId("login-code")).toBeVisible();

  await withMock(page, (m) => {
    m.centerLoginCodeResult = { ok: false, auth: "login_required", error: "Invalid code" };
  });
  await page.getByTestId("login-code").fill(CODE);
  await page.getByTestId("login-send").click();
  await expect(page.getByTestId("login-action-error")).toHaveText(/コードが受け付けられなかった/);
  await expect(page.getByTestId("login-code")).toBeVisible();

  await withMock(page, (m) => {
    m.centerLoginCodeResult = { ok: false, auth: "keychain_locked", error: "Couldn't save your login" };
  });
  await page.getByTestId("login-send").click();
  await expect(page.getByTestId("login-action-error")).toHaveText(/keychain を解錠/);
  await expect(page.getByTestId("login-keychain")).toBeVisible();
  await expect(page.getByTestId("login-code")).toHaveCount(0);
  await page.screenshot({ path: resolve(SHOT_DIR, "login-keychain.png") });
  // the badge now says the keychain is locked (the list was re-read after the failure)
  await expect(termAuth(page)).toHaveAttribute("data-auth", "keychain_locked");
});

test("restart from the dialog: rc_stop then rc_start with resume", async ({ page }) => {
  await page.goto("/");
  await pickSession(page, "careery");
  await withMock(page, (m) => m.centerAuth("careery", "login_required"));
  await termAuth(page).click();
  await page.getByTestId("login-restart").click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await withMock(page, (m) => m.loginCalls)).toEqual([
    { tool: "rc_stop", name: "careery" },
    { tool: "rc_start", name: "careery", resume: true },
  ]);
  await expect(termAuth(page)).toHaveCount(0);
});
