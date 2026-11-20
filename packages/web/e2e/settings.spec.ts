import { test as base, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { test } from "./fixtures";
import { startStack, type Stack } from "./stack";

const CENTER_TOKEN = "e2e-center-token-0123456789";
const CALLS_NOT_FOR_THE_WEB = ["center_status", "center_local_ips", "center_ip_status", "center_connect_snippets", "center_parse_connect", "center_regenerate_token", "center_set_settings"];

interface Seen {
  rpc: { cmd: string; status: number }[];
  bodies: string[];
}

// Every answer the browser gets, and every /api/rpc call with its status.
function watch(page: Page): Seen {
  const seen: Seen = { rpc: [], bodies: [] };
  page.on("response", async (r) => {
    const m = new URL(r.url()).pathname.match(/^\/api\/rpc\/(.+)$/);
    if (m) seen.rpc.push({ cmd: decodeURIComponent(m[1]!), status: r.status() });
    try {
      seen.bodies.push(await r.text());
    } catch {
      // a stream or a redirect has no body to read
    }
  });
  return seen;
}

async function openSettings(page: Page) {
  await page.goto("/");
  await page.getByTestId("web-settings-open").click();
  await expect(page.getByTestId("web-center-section")).toBeVisible();
}

test.describe("settings (web mode, design decision 14: view only)", () => {
  test("shows the target center; the token is only 'set' (screen, DOM, every answer, js)", async ({ page, stack }) => {
    stack.setSessions(["alpha"]);
    const seen = watch(page);
    await openSettings(page);
    await expect(page.getByTestId("web-center-url")).toHaveValue(stack.center.url);
    await expect(page.getByTestId("web-center-token")).toHaveValue("設定済み");
    await expect(page.getByTestId("web-center-state")).toHaveText("接続中");
    const dom = await page.content();
    const shown = await page.locator("body").innerText();
    const inputs = await page.locator("input, textarea").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).join("\n"));
    for (const [what, text] of [["DOM", dom], ["text", shown], ["input values", inputs]] as const) {
      expect(text, `token in ${what}`).not.toContain(CENTER_TOKEN);
    }
    expect(seen.bodies.length).toBeGreaterThan(3);
    for (const b of seen.bodies) expect(b).not.toContain(CENTER_TOKEN);
    expect(stack.logs()).not.toContain(CENTER_TOKEN);
    // the web backend's own js (the built client) does not carry it either
    const html = await (await fetch(stack.base + "/", { headers: stack.headers })).text();
    for (const src of html.match(/\/_nuxt\/[^"'\s]+\.js/g) ?? []) {
      expect(await (await fetch(stack.base + src, { headers: stack.headers })).text()).not.toContain(CENTER_TOKEN);
    }
  });

  test("no start switch, port, IP, snippet, status or workspace; the screen calls only what the web allows", async ({ page, stack }) => {
    const seen = watch(page);
    await openSettings(page);
    await expect(page.getByTestId("web-center-state")).toBeVisible();
    for (const id of ["center-enabled", "center-port", "center-bind", "center-ip-banner", "center-start-sidecar", "center-token", "center-snippet", "center-status-section", "center-workspace", "center-remote-paste", "settings-save", "center-common-section"]) {
      await expect(page.getByTestId(id), id).toHaveCount(0);
    }
    const called = seen.rpc.map((c) => c.cmd);
    expect(called).toContain("center_get_settings");
    expect(called).toContain("center_connection");
    for (const c of CALLS_NOT_FOR_THE_WEB) expect(called, c).not.toContain(c);
    // nothing the web's allow list refuses (404) was asked
    expect(seen.rpc.filter((c) => c.status === 404)).toEqual([]);
    expect(seen.rpc.filter((c) => c.status >= 400)).toEqual([]);
  });

  test("by default (view only) the inputs are disabled and nothing says 'fixed by env'", async ({ page }) => {
    await openSettings(page);
    await expect(page.getByTestId("web-center-url")).toBeDisabled();
    await expect(page.getByTestId("web-center-token")).toBeDisabled();
    await expect(page.getByTestId("web-center-url-env")).toHaveCount(0);
    await expect(page.getByTestId("web-center-token-env")).toHaveCount(0);
    await expect(page.getByTestId("web-center-note")).toBeVisible();
  });

  test("the dialog opens and closes from either tab, and the 5b server tab asks nothing the web refuses", async ({ page }) => {
    const seen = watch(page);
    await page.goto("/");
    for (const tab of ["tab-session", "tab-server", "tab-session"]) {
      await page.getByTestId(tab).click();
      await page.getByTestId("web-settings-open").click();
      await expect(page.getByTestId("web-center-section")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("web-center-section")).toHaveCount(0);
      await expect(page.getByTestId(tab)).toHaveAttribute("aria-selected", "true");
    }
    expect(seen.rpc.filter((c) => c.status === 404)).toEqual([]);
  });

  test("a failed settings read shows the error and still calls no sidecar command (no 404)", async ({ page }) => {
    const seen = watch(page);
    await page.route("**/api/rpc/center_get_settings", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "settings read failed" }) }));
    await page.goto("/");
    await page.getByTestId("web-settings-open").click();
    await expect(page.getByRole("dialog")).toContainText("settings read failed");
    await expect(page.getByTestId("web-center-section")).toHaveCount(0);
    // let anything the dialog would still fire after the failure arrive
    await page.waitForTimeout(1500);
    const called = seen.rpc.map((c) => c.cmd);
    for (const c of ["center_status", "center_local_ips", "center_ip_status", ...CALLS_NOT_FOR_THE_WEB]) expect(called, c).not.toContain(c);
    expect(seen.rpc.filter((c) => c.status === 404)).toEqual([]);
  });

  test("a center that does not answer shows 'つながらない'", async ({ page, stack }) => {
    const was = stack.center.requiredToken;
    stack.center.requiredToken = "another-token-0123456789"; // the stored token is now wrong: 401
    try {
      await openSettings(page);
      await expect(page.getByTestId("web-center-state")).toHaveText("つながらない");
      expect(await page.locator("body").innerText()).not.toContain(CENTER_TOKEN);
    } finally {
      stack.center.requiredToken = was;
    }
  });
});

// A second backend whose env fixes the destination (CENTER_URL / CENTER_TOKEN).
base.describe("settings with CENTER_URL / CENTER_TOKEN set", () => {
  let pinned: Stack;
  base.beforeAll(async () => {
    pinned = await startStack((center) => ({ CENTER_URL: center.url, CENTER_TOKEN: CENTER_TOKEN }));
  });
  base.afterAll(async () => pinned.close());

  base("both items say 'env で固定' and the inputs stay disabled; the token is not shown", async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: pinned.base, extraHTTPHeaders: pinned.headers });
    const page = await ctx.newPage();
    const seen = watch(page);
    await openSettings(page);
    await expect(page.getByTestId("web-center-url-env")).toHaveText("env で固定");
    await expect(page.getByTestId("web-center-token-env")).toHaveText("env で固定");
    await expect(page.getByTestId("web-center-url")).toBeDisabled();
    await expect(page.getByTestId("web-center-token")).toBeDisabled();
    await expect(page.getByTestId("web-center-token")).toHaveValue("設定済み");
    await expect(page.getByTestId("web-center-state")).toHaveText("接続中");
    expect(await page.content()).not.toContain(CENTER_TOKEN);
    for (const b of seen.bodies) expect(b).not.toContain(CENTER_TOKEN);
    expect(pinned.logs()).not.toContain(CENTER_TOKEN);
    await ctx.close();
  });
});
