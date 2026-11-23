import { devices } from "@playwright/test";
import { expect, test } from "./fixtures";

const TOKEN = "e2e-center-token-0123456789";
const screen = (page: import("@playwright/test").Page) => page.locator('[data-testid="terminal"] .xterm-rows');

test.describe("terminal page (phone, level 2)", () => {
  test("a row leads to the session's page, and its output shows", async ({ page, stack }) => {
    stack.setSessions(["alpha"]);
    // everything the browser receives: the center's token must not be in any of it
    const seen: string[] = [];
    page.on("response", async (r) => {
      if (r.url().startsWith(stack.base)) seen.push(await r.text().catch(() => ""));
    });
    page.on("console", (m) => seen.push(m.text()));
    await page.goto("/");
    await page.getByTestId("side-link").first().click();
    await expect(page).toHaveURL(/\/s\/alpha$/);
    await expect.poll(() => stack.outputStreams("alpha")).toBeGreaterThan(0);
    stack.pushOutput("alpha", "hello-from-5b\r\n");
    await expect(screen(page)).toContainText("hello-from-5b");
    // the page told the pty its size (the desktop's behaviour, TerminalView unchanged)
    await expect.poll(() => stack.resizes.filter((r) => r.session === "alpha").length).toBeGreaterThan(0);
    expect(await page.content()).not.toContain(TOKEN);
    expect(seen.join("\n")).not.toContain(TOKEN);
  });

  test("keystrokes reach the center's input route", async ({ page, stack }) => {
    stack.setSessions(["alpha"]);
    await page.goto("/s/alpha");
    await expect.poll(() => stack.outputStreams("alpha")).toBeGreaterThan(0);
    await page.getByTestId("terminal").click();
    await page.keyboard.type("echo-5b");
    await expect.poll(() => stack.inputs.filter((i) => i.session === "alpha").map((i) => i.data).join("")).toContain("echo-5b");
  });

  test("two browsers on the same session both get its output", async ({ page, stack, browser }) => {
    stack.setSessions(["alpha"]);
    const ctx = await browser.newContext({ ...devices["Pixel 7"], extraHTTPHeaders: stack.headers, baseURL: stack.base });
    const other = await ctx.newPage();
    await page.goto("/s/alpha");
    await other.goto("/s/alpha");
    await expect.poll(() => stack.outputStreams("alpha")).toBeGreaterThanOrEqual(2);
    stack.pushOutput("alpha", "shared-line-1\r\n");
    await expect(screen(page)).toContainText("shared-line-1");
    await expect(screen(other)).toContainText("shared-line-1");
    stack.pushOutput("alpha", "shared-line-2\r\n");
    await expect(screen(page)).toContainText("shared-line-2");
    await expect(screen(other)).toContainText("shared-line-2");
    await ctx.close();
  });

  test("output pushed while the stream was down is replayed after the page reopens it", async ({ page, stack }) => {
    stack.setSessions(["alpha"]);
    stack.pushOutput("alpha", "before-open\r\n"); // sent before any browser asked
    await page.goto("/s/alpha");
    await expect(screen(page)).toContainText("before-open");
  });
});

test.describe("server / cap tab", () => {
  test("the cap card shows the center's remote_list", async ({ page, stack }) => {
    stack.setSessions(["alpha"]);
    stack.center.tools.set("remote_list", [
      { remote_id: "r-5b-cap", owners: [], server: "srv-1", server_label: "host-a.example.test", session: "alpha", state: "stopped", createdAt: "2026-11-20T00:00:00Z", model: "m-5b" },
    ]);
    await page.goto("/");
    await page.getByTestId("tab-server").click();
    const card = page.getByTestId("cap-card");
    await expect(card.getByTestId("center-remote")).toHaveCount(1);
    await expect(card.getByTestId("center-remote")).toContainText("r-5b-cap");
    await expect(card.getByTestId("center-remote")).toContainText("host-a.example.test");
    await expect(page.getByTestId("center-remote-session")).toHaveText("alpha");
    expect(await page.content()).not.toContain(TOKEN);
  });

  test("an empty remote_list says so, and the server card opens the shared dialog with the server list", async ({ page, stack }) => {
    stack.center.tools.set("remote_list", []);
    stack.center.tools.set("rc_list", []);
    stack.center.tools.set("server_list", [{ name: "srv-1", host: "host-a.example.test", protocol: "2.0.0", last_seen: "2026-11-23T00:00:00Z" }]);
    await page.goto("/");
    await page.getByTestId("tab-server").click();
    await expect(page.getByTestId("center-remotes-none")).toBeVisible();
    await page.getByTestId("server-open").click();
    await expect(page.getByTestId("center-server-row")).toHaveCount(1);
    await expect(page.getByTestId("center-server-host")).toHaveText("host-a.example.test");
    await expect(page.getByTestId("center-server-name")).toHaveText("srv-1");
    await expect(page.getByTestId("center-server-version")).toHaveText("2.0.0");
  });
});
