import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

type Mock = { center: { enabled: boolean; remote?: { url: string; token?: string } }; centerReachable: boolean };

type Change = { enabled?: boolean; remote?: { url: string; token?: string }; reachable?: boolean };

/** Change the mocked backend: center settings and whether the center answers. */
const mock = (page: Page, change: Change) =>
  page.evaluate((c) => {
    const m = (window as unknown as { __BANTOU_MOCK__: Mock }).__BANTOU_MOCK__;
    if (c.enabled !== undefined) m.center.enabled = c.enabled;
    if (c.remote !== undefined) m.center.remote = c.remote;
    if (c.reachable !== undefined) m.centerReachable = c.reachable;
  }, change);

test("the center dialog shows the connection, rc_list and server_status", async ({ page }) => {
  await page.goto("/");
  await mock(page, { enabled: true });
  await page.getByTestId("open-center").click();
  await expect(page.getByTestId("center-dialog")).toBeVisible();
  await expect(page.getByTestId("center-conn-state")).toHaveText("connected");
  await expect(page.getByTestId("center-conn-url")).toContainText("http://127.0.0.1:7910/mcp");
  await expect(page.getByTestId("center-conn-url")).toContainText("sidecar");

  const rc = page.getByTestId("center-rc");
  await expect(rc).toHaveCount(2);
  await expect(rc.nth(0)).toContainText("alpha");
  await expect(rc.nth(0)).toContainText("connected");
  await expect(rc.nth(1)).toContainText("beta");
  await expect(rc.nth(1)).toContainText("stopped");

  const srv = page.getByTestId("center-server-row");
  await expect(srv).toHaveCount(1);
  await expect(srv).toContainText("srv1");
  await expect(srv).toContainText("reachable");
  const agents = page.getByTestId("center-agent");
  await expect(agents).toHaveCount(2);
  await expect(agents.nth(0)).toContainText("cap-a");
  await expect(agents.nth(1)).toContainText("w1");
});

test("a pasted remote connection is used as the connection target and refresh re-reads the state", async ({ page }) => {
  await page.goto("/");
  await mock(page, { remote: { url: "http://mac200:7910", token: "tok-remote-0123456789" } });
  await page.getByTestId("open-center").click();
  await expect(page.getByTestId("center-conn-url")).toContainText("http://mac200:7910/mcp");
  await expect(page.getByTestId("center-conn-url")).toContainText("remote");
  await expect(page.getByTestId("center-rc")).toHaveCount(2);

  await mock(page, { reachable: false });
  await page.getByTestId("center-refresh").click();
  await expect(page.getByTestId("center-conn-state")).toHaveText("disconnected");
  await expect(page.getByTestId("center-conn-error")).toContainText("接続できない");
  await expect(page.getByTestId("center-rc")).toHaveCount(0);
});

test("with the center on the stored remote is ignored and the sidecar is used; off uses the remote again", async ({ page }) => {
  await page.goto("/");
  await mock(page, { enabled: true, remote: { url: "http://mac200:7910", token: "tok-remote-0123456789" } });
  await page.getByTestId("open-center").click();
  await expect(page.getByTestId("center-conn-url")).toContainText("http://127.0.0.1:7910/mcp");
  await expect(page.getByTestId("center-conn-url")).toContainText("sidecar");

  await mock(page, { enabled: false });
  await page.getByTestId("center-refresh").click();
  await expect(page.getByTestId("center-conn-url")).toContainText("http://mac200:7910/mcp");
  await expect(page.getByTestId("center-conn-url")).toContainText("remote");
});

test("without a target the dialog says there is nothing to connect to", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("open-center").click();
  await expect(page.getByTestId("center-conn-state")).toHaveText("disconnected");
  await expect(page.getByTestId("center-conn-error")).toContainText("接続先が無い");
});

const agent = (kind: "cap" | "worker", id: string, state: string, extra: Record<string, unknown> = {}) => ({
  kind,
  id,
  cap_id: "r-0a1b2c3d4e",
  state,
  task: `task of ${id}`,
  last_activity: null,
  last_output_at: null,
  silent_ms: 3200,
  started_at: "2026-10-29T00:58:05.000Z",
  finished_at: null,
  ...extra,
});

/** `remote_list` shaped as docs of stream-liveness design chapter 4. */
const remotes = (workerState: string) => [
  {
    remote_id: "r-0a1b2c3d4e",
    owner: "bantou-pm",
    server: "p-7c1d",
    serverName: "bantou-server",
    state: "done",
    createdAt: "2026-10-29T00:57:00.000Z",
    activity: {
      at: "2026-10-29T01:00:05.000Z",
      received_ms_ago: 1200,
      stale: false,
      agents: [
        agent("cap", "r-0a1b2c3d4e", "idle", { silent_ms: 116200, last_activity: "text: worker を 3 本起動した" }),
        agent("worker", "w-1f2e3d4c5b", workerState, { last_activity: "Bash 実行中 60s" }),
        agent("worker", "w-2a3b4c5d6e", "stalled", { silent_ms: 366200 }),
        agent("worker", "w-3c4d5e6f7a", "lost", { silent_ms: 36200, error: "signal SIGKILL で終了" }),
      ],
    },
  },
  {
    remote_id: "r-9f8e7d6c5b",
    owner: "bantou-pm",
    server: "p-7c1d",
    serverName: "bantou-server",
    state: "running",
    createdAt: "2026-10-29T00:59:50.000Z",
    activity: {
      at: "2026-10-29T00:59:55.000Z",
      received_ms_ago: 45000,
      stale: true,
      agents: [agent("cap", "r-9f8e7d6c5b", "running", { silent_ms: 46000, last_activity: "thinking" })],
    },
  },
  { remote_id: "r-5a5a5a5a5a", owner: "other-pm", server: "p-7c1d", serverName: "bantou-server", state: "failed", createdAt: "2026-10-28T22:00:00.000Z" },
];

const seedRemotes = (page: Page, list: unknown[]) =>
  page.evaluate((l) => {
    (window as unknown as { __BANTOU_MOCK__: { centerRemotes: unknown[] } }).__BANTOU_MOCK__.centerRemotes = l;
  }, list);

test("the remotes section shows each cap and worker with state, task and time since the last output", async ({ page }) => {
  await page.goto("/");
  await mock(page, { enabled: true });
  await seedRemotes(page, remotes("running"));
  await page.getByTestId("open-center").click();

  await expect(page.getByTestId("center-remote")).toHaveCount(3);
  const first = page.getByTestId("center-remote").nth(0);
  const agents = first.getByTestId("center-remote-agent");
  await expect(agents).toHaveCount(4);
  await expect(agents.nth(0)).toHaveAttribute("data-kind", "cap");
  await expect(agents.nth(0)).toHaveAttribute("data-state", "idle");
  await expect(agents.nth(0).getByTestId("center-remote-agent-state")).toHaveText("待機");
  await expect(agents.nth(0).getByTestId("center-remote-elapsed")).toContainText("最終出力 1分前");
  await expect(agents.nth(1).getByTestId("center-remote-agent-state")).toHaveText("動作中");
  await expect(agents.nth(1).getByTestId("center-remote-task")).toHaveText("task of w-1f2e3d4c5b");
  await expect(agents.nth(1).getByTestId("center-remote-last")).toHaveText("Bash 実行中 60s");
  await expect(agents.nth(1).getByTestId("center-remote-elapsed")).toContainText(/最終出力 \d+秒前/);
  await expect(agents.nth(2).getByTestId("center-remote-agent-state")).toHaveText("停滞");
  await expect(agents.nth(2).getByTestId("center-remote-elapsed")).toContainText("最終出力 6分前");
  await expect(agents.nth(3).getByTestId("center-remote-agent-state")).toHaveText("消失");
  await expect(agents.nth(3)).toContainText("signal SIGKILL で終了");

  await expect(first.getByTestId("center-remote-stale")).toHaveCount(0);
  await expect(page.getByTestId("center-remote").nth(1).getByTestId("center-remote-stale")).toHaveText("更新途絶");
  const third = page.getByTestId("center-remote").nth(2);
  await expect(third).toContainText("活動情報なし");
  await expect(third).toContainText("failed");
  await expect(third.getByTestId("center-remote-agent")).toHaveCount(0);
});

test("the remotes section refreshes by itself without pressing update", async ({ page }) => {
  await page.goto("/");
  await mock(page, { enabled: true });
  await seedRemotes(page, remotes("running"));
  await page.getByTestId("open-center").click();
  const worker = page.getByTestId("center-remote").nth(0).getByTestId("center-remote-agent").nth(1);
  await expect(worker).toHaveAttribute("data-state", "running");

  await seedRemotes(page, remotes("lost"));
  await expect(worker).toHaveAttribute("data-state", "lost", { timeout: 5_000 });
});

test("the remotes section says so when there is no remote", async ({ page }) => {
  await page.goto("/");
  await mock(page, { enabled: true });
  await page.getByTestId("open-center").click();
  await expect(page.getByTestId("center-remotes-none")).toHaveText("remote なし");
});

const seedVersions = (page: Page, v: unknown) =>
  page.evaluate((x) => {
    (window as unknown as { __BANTOU_MOCK__: { centerVersions: unknown } }).__BANTOU_MOCK__.centerVersions = x;
  }, v);

const versionPeer = (over: Record<string, unknown>) => ({
  key: "mac200 /ws",
  id: "p2",
  name: "bantou-server",
  hostname: "mac200",
  server_version: "0.3.0",
  protocol_version: "1.3.0",
  state: "ok",
  detail: "版が一致",
  since: "2026-10-31T00:00:00.000Z",
  ...over,
});

test("the server versions section shows the paired versions and a matching server as 一致", async ({ page }) => {
  await page.goto("/");
  await mock(page, { enabled: true });
  await page.getByTestId("open-center").click();
  await expect(page.getByTestId("center-pair")).toContainText("server 0.3.0");
  await expect(page.getByTestId("center-pair")).toContainText("protocol 1.3.0");
  const row = page.getByTestId("center-version-row");
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("data-state", "ok");
  await expect(row.getByTestId("center-version-badge")).toHaveText("一致");
  await expect(row).toContainText("mac200");
});

test("the server versions section shows 更新中 with the waiting caps and workers, 版違い and 更新失敗 with the reason", async ({ page }) => {
  await page.goto("/");
  await mock(page, { enabled: true });
  await seedVersions(page, {
    pair: { server: "0.3.1", protocol: "1.3.0" },
    peers: [
      versionPeer({ key: "a", id: "a", hostname: "host-a", state: "updating", detail: "更新中（0.3.0→0.3.1）: cap 1 / worker 2 の終了待ち", update: { to: "0.3.1", running: { caps: 1, workers: 2, reports: 0 } } }),
      versionPeer({ key: "b", id: "b", hostname: "host-b", server_version: "0.2.3", protocol_version: "1.2.0", state: "unsupported", detail: "自動更新できない版（protocol 1.2.0）。server を手動で起動し直す" }),
      versionPeer({ key: "c", id: "c", hostname: "host-c", state: "failed", detail: "更新に失敗（→0.3.1）: 版 0.3.1 を取得できない" }),
      versionPeer({ key: "d", id: "d", hostname: "host-d", state: "mismatch", detail: "protocol の版が違う" }),
    ],
  });
  await page.getByTestId("open-center").click();
  const rows = page.getByTestId("center-version-row");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0).getByTestId("center-version-badge")).toHaveText("更新中");
  await expect(rows.nth(0).getByTestId("center-version-running")).toContainText("cap 1 / worker 2");
  await expect(rows.nth(1).getByTestId("center-version-badge")).toHaveText("版違い");
  await expect(rows.nth(1).getByTestId("center-version-detail")).toContainText("手動で起動し直す");
  await expect(rows.nth(2).getByTestId("center-version-badge")).toHaveText("更新失敗");
  await expect(rows.nth(2).getByTestId("center-version-detail")).toContainText("取得できない");
  await expect(rows.nth(3).getByTestId("center-version-badge")).toHaveText("版違い");
  await expect(rows.nth(3)).toHaveAttribute("data-state", "mismatch");
});

test("pressing update re-reads the server versions", async ({ page }) => {
  await page.goto("/");
  await mock(page, { enabled: true });
  await page.getByTestId("open-center").click();
  await expect(page.getByTestId("center-version-row").getByTestId("center-version-badge")).toHaveText("一致");
  await seedVersions(page, { pair: { server: "0.3.0", protocol: "1.3.0" }, peers: [versionPeer({ state: "updating", detail: "更新中", update: { to: "0.3.0", running: { caps: 0, workers: 1, reports: 0 } } })] });
  await page.getByTestId("center-refresh").click();
  await expect(page.getByTestId("center-version-row").getByTestId("center-version-badge")).toHaveText("更新中");
});

test("the server versions section says so when there is no server", async ({ page }) => {
  await page.goto("/");
  await mock(page, { enabled: true });
  await seedVersions(page, { pair: { server: null, protocol: "1.3.0" }, peers: [] });
  await page.getByTestId("open-center").click();
  await expect(page.getByTestId("center-versions-none")).toHaveText("server なし");
  await expect(page.getByTestId("center-pair")).toContainText("server 不明");
});
