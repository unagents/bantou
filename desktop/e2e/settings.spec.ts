import { expect, test } from "./fixtures";

test("the settings dialog saves the center port and shows it again", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("open-settings").click();
  const dialog = page.getByTestId("settings-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("center-port")).toHaveValue("7910");
  await expect(page.getByTestId("center-state")).toHaveText("stopped");

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
