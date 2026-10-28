import { expect, test } from "./fixtures";

test("the settings dialog saves the center port and shows it again", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("open-settings").click();
  const dialog = page.getByTestId("settings-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("center-state")).toHaveText("stopped");
  // the port belongs to the center section, which shows only while the center is on
  await page.getByTestId("center-enabled").click();
  await expect(page.getByTestId("center-port")).toHaveValue("7910");

  await page.getByTestId("center-port").fill("7920");
  await page.getByTestId("settings-save").click();
  await expect(page.getByText("設定を保存した")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("center-port")).toHaveValue("7920");
});

test("regenerating the token changes the token field and the connection snippets", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("open-settings").click();
  // the token section shows only while the center is enabled
  await expect(page.getByTestId("center-mcp-section")).toBeHidden();
  await page.getByTestId("center-enabled").click();
  const token = page.getByTestId("center-token");
  const snippet = page.getByTestId("center-snippet");
  await expect(token).toHaveValue("mock-token-000000000000000000000001");
  await expect(snippet).toContainText("http://127.0.0.1:7910/mcp");
  await expect(snippet).toContainText("Bearer mock-token-000000000000000000000001");

  await page.getByTestId("center-token-regenerate").click();
  await expect(token).toHaveValue("mock-token-00000000000000000000000000000002");
  await expect(snippet).toContainText("Bearer mock-token-00000000000000000000000000000002");
  await expect(snippet).not.toContainText("000000000000000000000001");

  // the second tab is the claude mcp add command, with the same new token
  await page.getByRole("tab", { name: "claude mcp add" }).click();
  await expect(snippet).toContainText("claude mcp add --transport http bantou-center http://127.0.0.1:7910/mcp");
  await expect(snippet).toContainText("Authorization: Bearer mock-token-00000000000000000000000000000002");

  // the snippet follows the port draft too
  await page.getByTestId("center-port").fill("7920");
  await expect(snippet).toContainText("http://127.0.0.1:7920/mcp");
});

test("pasting a connection snippet shows the parsed URL and token, or a readable error", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("open-settings").click();
  const paste = page.getByTestId("center-remote-paste");

  await paste.fill(
    JSON.stringify({
      mcpServers: { "bantou-center": { type: "http", url: "http://mac200:7910/mcp", headers: { Authorization: "Bearer tok-from-json-0123" } } },
    }),
  );
  await expect(page.getByTestId("center-remote-parsed-url")).toHaveText("http://mac200:7910/mcp");
  await expect(page.getByTestId("center-remote-parsed-token")).toContainText("あり");

  await paste.fill("claude mcp add --transport http bantou-center http://mac204:7910/mcp \\\n  --header 'Authorization: Bearer tok-from-cmd-0123'");
  await expect(page.getByTestId("center-remote-parsed-url")).toHaveText("http://mac204:7910/mcp");
  await expect(page.getByTestId("center-remote-parsed-token")).toContainText("あり");

  await paste.fill("claude mcp add --transport http bantou-center http://mac204:7910");
  await expect(page.getByTestId("center-remote-parsed-url")).toHaveText("http://mac204:7910/mcp");
  await expect(page.getByTestId("center-remote-parsed-token")).toContainText("なし");

  await paste.fill("hello");
  await expect(page.getByTestId("center-remote-error")).toContainText("貼る");
  await expect(page.getByTestId("center-remote-parsed")).toBeHidden();

  // a parsed snippet is saved as the connection target; clearing removes it
  await paste.fill('{"url":"http://mac200:7910/mcp","headers":{"Authorization":"Bearer tok-from-json-0123"}}');
  await expect(page.getByTestId("center-remote-current")).toContainText("http://mac200:7910/mcp");
  await page.getByTestId("settings-save").click();
  await expect(page.getByText("設定を保存した")).toBeVisible();
  await page.getByTestId("center-remote-clear").click();
  await expect(page.getByTestId("center-remote-current")).toBeHidden();
});

test("one IP choice is both the center's bind and the host of the connection snippets", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("open-settings").click();
  await page.getByTestId("center-enabled").click();
  const bind = page.getByTestId("center-bind");
  const snippet = page.getByTestId("center-snippet");

  // the old free-text bind and the separate connection-IP field are gone
  await expect(page.getByTestId("center-connect-host")).toHaveCount(0);
  await expect(bind).toHaveJSProperty("tagName", "BUTTON");

  // the default bind (127.0.0.1) is one of this machine's IPs and names itself in the snippet
  await expect(bind).toContainText("127.0.0.1");
  await expect(snippet).toContainText("http://127.0.0.1:7910/mcp");

  // this machine's IPs are the choices: IPv4 first, then IPv6
  await bind.click();
  await expect(page.getByRole("option")).toHaveText(["192.168.1.204", "100.64.0.9", "127.0.0.1", "fd7a::5"]);
  await page.getByRole("option", { name: "100.64.0.9" }).click();
  await expect(bind).toContainText("100.64.0.9");
  await expect(snippet).toContainText("http://100.64.0.9:7910/mcp");
  await expect(snippet).not.toContainText("127.0.0.1");
  await expect(page.getByTestId("center-bind-warning")).toBeVisible();

  // the second tab follows the same IP
  await page.getByRole("tab", { name: "claude mcp add" }).click();
  await expect(snippet).toContainText("claude mcp add --transport http bantou-center http://100.64.0.9:7910/mcp");

  // IPv6 goes into the URL in brackets
  await bind.click();
  await page.getByRole("option", { name: "fd7a::5" }).click();
  await expect(snippet).toContainText("http://[fd7a::5]:7910/mcp");

  // the choice is saved as the bind and comes back
  await bind.click();
  await page.getByRole("option", { name: "100.64.0.9" }).click();
  await page.getByTestId("settings-save").click();
  await expect(page.getByText("設定を保存した")).toBeVisible();
  const saved = await page.evaluate(() => (window as unknown as { __BANTOU_MOCK__: { center: { bind: string } } }).__BANTOU_MOCK__.center.bind);
  expect(saved).toBe("100.64.0.9");
  await page.keyboard.press("Escape");
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("center-bind")).toContainText("100.64.0.9");
  await expect(snippet).toContainText("http://100.64.0.9:7910/mcp");
});

test("center on shows this PC's token and snippets instead of paste-to-connect, off the reverse", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("open-settings").click();
  const own = ["center-own-section", "center-token", "center-snippet", "center-bind"];
  const remote = ["center-remote-section", "center-remote-paste"];

  // OFF: only paste-to-connect
  for (const id of remote) await expect(page.getByTestId(id)).toBeVisible();
  for (const id of own) await expect(page.getByTestId(id)).toHaveCount(0);

  // ON: this PC's token and snippets, no paste field
  await page.getByTestId("center-enabled").click();
  for (const id of own) await expect(page.getByTestId(id).first()).toBeVisible();
  for (const id of remote) await expect(page.getByTestId(id)).toHaveCount(0);

  // OFF again: back to paste-to-connect
  await page.getByTestId("center-enabled").click();
  for (const id of remote) await expect(page.getByTestId(id)).toBeVisible();
  for (const id of own) await expect(page.getByTestId(id)).toHaveCount(0);
});

test("center off hides this host's center settings, keeps paste-to-connect, and keeps saved values", async ({ page }) => {
  await page.goto("/");
  // saved values in the backend while the center is off
  await page.evaluate(() => {
    const m = (window as unknown as { __BANTOU_MOCK__: { center: Record<string, unknown> } }).__BANTOU_MOCK__;
    Object.assign(m.center, {
      port: 7955,
      bind: "100.64.0.9",
      claudePath: "/opt/claude",
      workspace: "/work/saved",
    });
  });
  await page.getByTestId("open-settings").click();
  const own = [
    "center-own-section",
    "center-port",
    "center-bind",
    "center-claude-path",
    "center-workspace",
    "center-token",
    "center-snippet",
  ];

  // OFF: only the toggle for this host's center, plus paste-to-connect
  await expect(page.getByTestId("center-enabled")).toBeVisible();
  for (const id of own) await expect(page.getByTestId(id)).toHaveCount(0);
  await expect(page.getByTestId("center-remote-section")).toBeVisible();
  await expect(page.getByTestId("center-remote-paste")).toBeVisible();

  // ON: everything shows, with the saved values (paste-to-connect gives way)
  await page.getByTestId("center-enabled").click();
  for (const id of own) await expect(page.getByTestId(id).first()).toBeVisible();
  await expect(page.getByTestId("center-remote-section")).toHaveCount(0);
  await expect(page.getByTestId("center-port")).toHaveValue("7955");
  await expect(page.getByTestId("center-bind")).toContainText("100.64.0.9");
  await expect(page.getByTestId("center-claude-path")).toHaveValue("/opt/claude");
  await expect(page.getByTestId("center-workspace")).toHaveValue("/work/saved");

  // OFF again and ON again: nothing was reset
  await page.getByTestId("center-enabled").click();
  for (const id of own) await expect(page.getByTestId(id)).toHaveCount(0);
  await expect(page.getByTestId("center-remote-section")).toBeVisible();
  await page.getByTestId("center-enabled").click();
  await expect(page.getByTestId("center-port")).toHaveValue("7955");
  await expect(page.getByTestId("center-workspace")).toHaveValue("/work/saved");
});
