import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

type Mock = { center: Record<string, unknown> };

/** Run `fn(mock)` in the page. `fn` is serialized: it must not capture anything. */
const mock = <T>(page: Page, fn: (m: Mock) => T) =>
  page.evaluate(
    (src) =>
      new Function("m", `return (${src})(m)`)((window as unknown as { __BANTOU_MOCK__: Mock }).__BANTOU_MOCK__),
    fn.toString(),
  ) as Promise<T>;

const snippet = (url: string, token: string) =>
  JSON.stringify({ mcpServers: { "bantou-center": { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);

test.describe("settings dialog: overwriting the saved connection target", () => {
  test.beforeEach(async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/");
    await mock(page, (m) => {
      m.center.enabled = false;
      m.center.remote = { url: "http://old-host:7910/mcp", token: "tok-old-remote-0123" };
    });
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("center-remote-paste")).toHaveValue(/old-host/);
  });

  test("pasting a new connection with the caret in the filled field replaces it; one save, and it shows again after reopening", async ({ page }) => {
    await page.evaluate((t) => navigator.clipboard.writeText(t), snippet("http://new-host:7910/mcp", "tok-new-remote-4567"));
    const paste = page.getByTestId("center-remote-paste");
    // no select-all: the caret goes to the end of the saved text and the clipboard is pasted
    await paste.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Control+V");
    await expect(page.getByTestId("center-remote-error")).toHaveCount(0);
    await expect(page.getByTestId("center-remote-parsed-url")).toHaveText("http://new-host:7910/mcp");
    await expect(paste).not.toHaveValue(/old-host/);
    await expect(page.getByTestId("settings-save")).toBeEnabled();
    await page.getByTestId("settings-save").click();
    await expect(page.getByTestId("settings-dialog")).toBeHidden();
    expect(await mock(page, (m) => m.center.remote)).toEqual({ url: "http://new-host:7910/mcp", token: "tok-new-remote-4567" });
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("center-remote-current")).toContainText("http://new-host:7910/mcp");
    await expect(page.getByTestId("center-remote-paste")).toHaveValue(/tok-new-remote-4567/);
    await expect(page.getByTestId("settings-save")).toBeDisabled();
  });

  test("a paste over a selected part, or into a field that is not a complete connection, is inserted as usual", async ({ page }) => {
    const paste = page.getByTestId("center-remote-paste");
    await paste.fill("claude mcp add --transport http bantou-center http://a-host:7910/mcp");
    await expect(page.getByTestId("center-remote-parsed-url")).toHaveText("http://a-host:7910/mcp");
    // select just the host and paste another one: normal insertion (the text is still one connection)
    await page.evaluate(() => {
      const el = document.querySelector<HTMLTextAreaElement>('[data-testid="center-remote-paste"]')!;
      const i = el.value.indexOf("a-host");
      el.focus();
      el.setSelectionRange(i, i + "a-host".length);
    });
    await page.evaluate((t) => navigator.clipboard.writeText(t), "b-host");
    await page.keyboard.press("Control+V");
    await expect(page.getByTestId("center-remote-parsed-url")).toHaveText("http://b-host:7910/mcp");
  });
});
