import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { boardSeed } from "./seed";

// The extra MCP servers (`mcpServers`) and the external memory (`memory`) are written in the settings of the place that started
// the center (the desktop running it as its sidecar), in the form of Claude Code's mcp.json, values included (Bearer tokens too).
// How the center puts them into a session's --mcp-config is covered by packages/center's tests.

type Mock = {
  center: { enabled: boolean; remote?: { url: string; token?: string } };
  centerLauncher: boolean | null;
  centerCommonSettings: Record<string, unknown>;
  centerSettings: Record<string, Record<string, unknown>>;
  calls: { cmd: string; args?: Record<string, unknown> }[];
};

/** Run `fn(mock)` in the page. `fn` is serialized: it must not capture anything. */
const mock = <T>(page: Page, fn: (m: Mock) => T) =>
  page.evaluate(
    (src) => new Function("m", `return (${src})(m)`)((window as unknown as { __BANTOU_MOCK__: Mock }).__BANTOU_MOCK__),
    fn.toString(),
  ) as Promise<T>;

const STDIO = { command: "npx", args: ["-y", "@example/tools-mcp"], env: { TOOLS_KEY: "stdio-secret-123" } };
const HTTP = { type: "http", url: "https://tools.example/mcp", headers: { Authorization: "Bearer http-secret-456" } };
const COORD = { type: "http", url: "http://127.0.0.1:7911/mcp", headers: { Authorization: "Bearer coord-secret-000" } };
const MEMORY = { type: "http", url: "https://memory.example/mcp", headers: { Authorization: "Bearer mem-secret-789" } };

const asText = (v: unknown) => JSON.stringify(v, null, 2);
const openCommon = async (page: Page) => {
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("center-common-mcp-servers")).toBeVisible();
};
const openSession = async (page: Page, name: string) => {
  await page.locator(`[data-testid=session-settings-open][data-name=${name}]`).click();
  await expect(page.getByTestId("settings-mcp-servers")).toBeVisible();
};
const saveAndClose = async (page: Page) => {
  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("settings-dialog")).toBeHidden();
};
const centerUpdates = (page: Page) =>
  mock(page, (m) =>
    m.calls
      .filter((c) => c.cmd === "session_update_settings" || (c.cmd === "center_call" && (c.args as { name: string }).name === "center_settings_update"))
      .map((c) => c.args),
  );

test.describe("settings: extra MCP servers and external memory (the desktop that started the center)", () => {
  test.use({ seed: boardSeed });

  test("center-wide: a stdio and a Bearer http server are saved with one save and are there after reopening, values as written", async ({ page }) => {
    await page.goto("/");
    await openCommon(page);
    await page.getByTestId("center-common-mcp-servers").fill(asText({ mcpServers: { tools: STDIO, web: HTTP } }));
    await saveAndClose(page);
    expect(await mock(page, (m) => m.centerCommonSettings.mcpServers)).toEqual({ tools: STDIO, web: HTTP });
    await openCommon(page);
    const shown = await page.getByTestId("center-common-mcp-servers").inputValue();
    expect(JSON.parse(shown)).toEqual({ mcpServers: { tools: STDIO, web: HTTP } });
    expect(shown).toContain("Bearer http-secret-456");
    await expect(page.getByTestId("settings-save")).toBeDisabled();
  });

  test("per session: stdio, Bearer http and the coordinator MCP server entry (type http, url, headers) are saved and are there after reopening", async ({ page }) => {
    await page.goto("/");
    await openSession(page, "careery");
    await page.getByTestId("settings-mcp-servers").fill(asText({ mcpServers: { tools: STDIO, web: HTTP, "bantou-coordinator": COORD } }));
    await saveAndClose(page);
    expect(await mock(page, (m) => m.centerSettings.careery?.mcpServers)).toEqual({ tools: STDIO, web: HTTP, "bantou-coordinator": COORD });
    await openSession(page, "careery");
    expect(JSON.parse(await page.getByTestId("settings-mcp-servers").inputValue())).toEqual({ mcpServers: { tools: STDIO, web: HTTP, "bantou-coordinator": COORD } });
  });

  test("external memory with a Bearer header: center-wide and per session, saved and shown again; its own field, not in the server list", async ({ page }) => {
    await page.goto("/");
    await openCommon(page);
    await page.getByTestId("center-common-memory").fill(asText(MEMORY));
    await saveAndClose(page);
    expect(await mock(page, (m) => m.centerCommonSettings.memory)).toEqual(MEMORY);
    expect(await mock(page, (m) => m.centerCommonSettings.mcpServers)).toBeUndefined();
    await openCommon(page);
    expect(JSON.parse(await page.getByTestId("center-common-memory").inputValue())).toEqual(MEMORY);
    await expect(page.getByTestId("center-common-mcp-servers")).toHaveValue("");
    await page.keyboard.press("Escape");

    const own = { ...MEMORY, headers: { Authorization: "Bearer own-secret", "X-Agent-Id": "pm_careery" } };
    await openSession(page, "careery");
    // pasted as an mcp.json snippet with one server: taken as that server
    await page.getByTestId("settings-memory").fill(asText({ mcpServers: { memory: own } }));
    await saveAndClose(page);
    expect(await mock(page, (m) => m.centerSettings.careery?.memory)).toEqual(own);
    await openSession(page, "careery");
    expect(JSON.parse(await page.getByTestId("settings-memory").inputValue())).toEqual(own);
  });

  test("editing the saved JSON (a value and a new server) is saved with a single click; untouched items are not sent", async ({ page }) => {
    await page.goto("/");
    await mock(page, (m) => {
      m.centerCommonSettings = { instructions: "共通", mcpServers: { web: { type: "http", url: "https://tools.example/mcp", headers: { Authorization: "Bearer old-token" } } } };
      m.centerSettings.careery = { mcpServers: { web: null }, memory: { type: "http", url: "https://memory.example/mcp" } };
    });
    await openCommon(page);
    const box = page.getByTestId("center-common-mcp-servers");
    const edited = (await box.inputValue()).replace("old-token", "new-token");
    await box.fill(edited.replace('"mcpServers": {', `"mcpServers": {\n    "tools": ${JSON.stringify(STDIO)},`));
    await saveAndClose(page);
    expect(await mock(page, (m) => m.centerCommonSettings)).toEqual({
      instructions: "共通",
      mcpServers: { tools: STDIO, web: { type: "http", url: "https://tools.example/mcp", headers: { Authorization: "Bearer new-token" } } },
    });
    const common = (await centerUpdates(page)).map((a) => (a as { arguments: { settings: Record<string, unknown> } }).arguments.settings);
    expect(common).toHaveLength(1);
    expect(common[0]).not.toHaveProperty("memory");

    await openSession(page, "careery");
    // the session's null (drops the center-wide server here) is shown and kept
    expect(JSON.parse(await page.getByTestId("settings-mcp-servers").inputValue())).toEqual({ mcpServers: { web: null } });
    const mem = page.getByTestId("settings-memory");
    await mem.fill((await mem.inputValue()).replace('"url": "https://memory.example/mcp"', '"url": "https://memory.example/mcp",\n  "headers": { "Authorization": "Bearer added" }'));
    await saveAndClose(page);
    expect(await mock(page, (m) => m.centerSettings.careery)).toEqual({
      mcpServers: { web: null },
      memory: { type: "http", url: "https://memory.example/mcp", headers: { Authorization: "Bearer added" } },
    });
    const sess = (await centerUpdates(page)).filter((a) => (a as { name?: string }).name === "careery");
    expect(sess).toHaveLength(1);
    expect((sess[0] as { settings: Record<string, unknown> }).settings).not.toHaveProperty("mcpServers");
  });

  test("the old memory setting ({ url, token, agentId }) shows as an MCP server entry with its Bearer header, and stays when saving", async ({ page }) => {
    await page.goto("/");
    await mock(page, (m) => {
      m.centerCommonSettings = { memory: { url: "http://mem.local:3000/mcp", token: "OLD-TOKEN", agentId: "pm_1" } };
    });
    await openCommon(page);
    const migrated = { type: "http", url: "http://mem.local:3000/mcp", headers: { Authorization: "Bearer OLD-TOKEN", "X-Agent-Id": "pm_1" } };
    expect(JSON.parse(await page.getByTestId("center-common-memory").inputValue())).toEqual(migrated);
    await page.getByTestId("center-common-instructions").fill("共通");
    await saveAndClose(page);
    expect(await mock(page, (m) => m.centerCommonSettings)).toEqual({ memory: migrated, instructions: "共通" });
  });

  test("broken JSON is shown as a problem and blocks the save; nothing is sent", async ({ page }) => {
    await page.goto("/");
    await openCommon(page);
    await page.getByTestId("center-common-mcp-servers").fill('{ "mcpServers": { "x": ');
    await expect(page.getByTestId("center-common-problem")).toContainText("JSON");
    await expect(page.getByTestId("settings-save")).toBeDisabled();
    await page.getByTestId("center-common-mcp-servers").fill("");
    await page.getByTestId("center-common-memory").fill('"just a string"');
    await expect(page.getByTestId("center-common-problem")).toContainText("外部記憶");
    expect(await centerUpdates(page)).toEqual([]);
  });
});

test.describe("settings: a desktop connected to another host's center", () => {
  test("has no MCP server / memory fields (center-wide and per session) and sends neither", async ({ page }) => {
    await page.goto("/");
    await mock(page, (m) => {
      m.center.enabled = false;
      m.center.remote = { url: "http://other-host:7910/mcp", token: "tok-other-0123456" };
      m.centerCommonSettings = { mcpServers: { web: { type: "http", url: "https://x/mcp", headers: { Authorization: "Bearer HIDDEN-1" } } } };
    });
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("center-common-instructions")).toBeVisible();
    for (const id of ["center-common-mcp-servers", "center-common-memory"]) await expect(page.getByTestId(id)).toHaveCount(0);
    expect(await page.getByTestId("settings-dialog").innerHTML()).not.toContain("HIDDEN-1");
    await page.getByTestId("center-common-instructions").fill("共通");
    await page.getByTestId("settings-save").click();
    await expect(page.getByTestId("settings-dialog")).toBeHidden();
    expect(await mock(page, (m) => m.centerCommonSettings)).toEqual({ mcpServers: { web: { type: "http", url: "https://x/mcp", headers: { Authorization: "Bearer HIDDEN-1" } } }, instructions: "共通" });
  });
});
