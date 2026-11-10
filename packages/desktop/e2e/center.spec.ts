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
  cap_id: "c-0a1b2c3d4e-careery",
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
    remote_id: "c-0a1b2c3d4e-careery",
    session: "careery",
    owners: ["careery"],
    server: "p-7c1d",
    serverName: "bantou-server",
    state: "running",
    model: "opus",
    createdAt: "2026-10-29T00:57:00.000Z",
    result: "整理した",
    result_at: "2026-10-29T00:58:00.000Z",
    pending: [{ at: "2026-10-29T00:59:00.000Z", owner: "careery", prompt: "次は PR を見て" }],
    activity: {
      at: "2026-10-29T01:00:05.000Z",
      received_ms_ago: 1200,
      stale: false,
      agents: [
        agent("cap", "c-0a1b2c3d4e-careery", "idle", { silent_ms: 116200, last_activity: "text: worker を 3 本起動した", model: "opus" }),
        agent("worker", "w-1f2e3d4c5b", workerState, { last_activity: "Bash 実行中 60s", model: "claude-sonnet-5-5" }),
        agent("worker", "w-2a3b4c5d6e", "stalled", { silent_ms: 366200 }),
        agent("worker", "w-3c4d5e6f7a", "lost", { silent_ms: 36200, error: "signal SIGKILL で終了" }),
      ],
    },
  },
  {
    remote_id: "c-0a1b2c3d4e-bantou-pm",
    session: "bantou-pm",
    owners: ["bantou-pm"],
    server: "p-7c1d",
    serverName: "bantou-server",
    state: "running",
    createdAt: "2026-10-29T00:59:50.000Z",
    activity: {
      at: "2026-10-29T00:59:55.000Z",
      received_ms_ago: 45000,
      stale: true,
      agents: [agent("cap", "c-0a1b2c3d4e-bantou-pm", "running", { silent_ms: 46000, last_activity: "thinking" })],
    },
  },
  // an idle cap with no worker and no pending instruction (one row, no record of finished work)
  // the old shared cap kept from before (no session)
  { remote_id: "c-0a1b2c3d4e", owners: [], server: "p-8e2f", serverName: "other-server", state: "done", createdAt: "2026-10-28T22:00:00.000Z", result: "PR を確認した。\n指摘は 3 件", result_at: "2026-10-28T23:00:00.000Z", pending: [] },
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

  await expect(first.getByTestId("center-remote-model")).toHaveText("opus");
  await expect(agents.nth(0).getByTestId("center-remote-agent-model")).toHaveText("opus");
  await expect(agents.nth(1).getByTestId("center-remote-agent-model")).toHaveText("claude-sonnet-5-5");
  await expect(agents.nth(2).getByTestId("center-remote-agent-model")).toHaveCount(0);
  await expect(first.getByTestId("center-remote-stale")).toHaveCount(0);
  await expect(page.getByTestId("center-remote").nth(1).getByTestId("center-remote-stale")).toHaveText("更新途絶");
  const third = page.getByTestId("center-remote").nth(2);
  await expect(third.getByTestId("center-remote-waiting")).toHaveText("待機中");
  await expect(third.getByTestId("center-remote-agent")).toHaveCount(0);
  await expect(first.getByTestId("center-remote-waiting")).toHaveCount(0);
});

test("one row per server: cap state, head of the latest result and workers. No history, no old-format badge, no list of finished records", async ({ page }) => {
  await page.goto("/");
  await mock(page, { enabled: true });
  await seedRemotes(page, remotes("running"));
  await page.getByTestId("open-center").click();

  const rows = page.getByTestId("center-remote");
  await expect(rows).toHaveCount(3);
  const first = rows.nth(0);
  // the center dialog lists every session's cap with its session name; the old shared cap has no session
  await expect(first.getByTestId("center-remote-session")).toHaveText("careery");
  await expect(rows.nth(1).getByTestId("center-remote-session")).toHaveText("bantou-pm");
  await expect(rows.nth(2).getByTestId("center-remote-session")).toHaveText("共有（旧）");
  await expect(first.getByTestId("center-remote-result")).toHaveText("整理した");
  await expect(first.getByTestId("center-remote-agent").nth(0).getByTestId("center-remote-agent-state")).toHaveText("待機");
  const idle = rows.nth(2);
  await expect(idle).toContainText("other-server");
  await expect(idle.getByTestId("center-remote-result")).toHaveText("PR を確認した。 指摘は 3 件");
  await expect(page.getByTestId("center-remote-history")).toHaveCount(0);
  await expect(page.getByTestId("center-remote-history-item")).toHaveCount(0);
  await expect(page.getByTestId("center-remote-legacy")).toHaveCount(0);
  await expect(page.getByText("活動情報なし")).toHaveCount(0);
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

const withTask = () => {
  const [first, ...rest] = remotes("running");
  return [
    {
      ...first,
      task_result: {
        cap_id: "c-0a1b2c3d4e-careery",
        task_id: "t-1",
        state: "done",
        summary: "task メッセージを追加した",
        workers: [
          { worker_id: "w-1f2e3d4c5b", role: "implement", state: "done", branch: "feature/x", commit: "abc1234", tests: "npm test: 28 pass", result: "型とガードを追加した" },
          { worker_id: "w-2a3b4c5d6e", role: "review", state: "done", result: "指摘 2 件" },
        ],
        review: {
          verdict: "issues",
          items: [
            { severity: "high", text: "検証が無い", resolved: true },
            { severity: "low", text: "命名", resolved: false },
          ],
          rounds: 2,
        },
        remaining: ["命名の整理"],
        error: "tests 一部失敗",
      },
      worker_reports: [
        { cap_id: "c-0a1b2c3d4e-careery", task_id: "t-1", worker_id: "w-1f2e3d4c5b", kind: "ask", text: "古い質問", at: "2026-10-29T01:00:00.000Z" },
        { cap_id: "c-0a1b2c3d4e-careery", task_id: "t-1", worker_id: "w-1f2e3d4c5b", kind: "progress", text: "続行した", at: "2026-10-29T01:00:30.000Z" },
        { cap_id: "c-0a1b2c3d4e-careery", task_id: "t-1", worker_id: "w-2a3b4c5d6e", kind: "approve", text: "push してよいか", at: "2026-10-29T01:01:00.000Z" },
        { cap_id: "c-0a1b2c3d4e-careery", task_id: "t-1", worker_id: "w-3c4d5e6f7a", kind: "done", text: "完了", at: "2026-10-29T01:02:00.000Z" },
      ],
    },
    ...rest,
  ];
};

test("a cap shows the task_result: workers, review verdict and items, remaining and error", async ({ page }) => {
  await page.goto("/");
  await mock(page, { enabled: true });
  await seedRemotes(page, withTask());
  await page.getByTestId("open-center").click();

  const first = page.getByTestId("center-remote").nth(0);
  await expect(first.getByTestId("center-task-summary")).toHaveText("task メッセージを追加した");
  await expect(first.getByTestId("center-task-error")).toHaveText("tests 一部失敗");
  const workers = first.getByTestId("center-task-worker");
  await expect(workers).toHaveCount(2);
  await expect(workers.nth(0)).toContainText("implement");
  await expect(workers.nth(0).getByTestId("center-task-worker-branch")).toHaveText("feature/x");
  await expect(workers.nth(0).getByTestId("center-task-worker-commit")).toHaveText("abc1234");
  await expect(workers.nth(0).getByTestId("center-task-worker-tests")).toHaveText("npm test: 28 pass");
  await expect(workers.nth(0).getByTestId("center-task-worker-result")).toHaveText("型とガードを追加した");
  await expect(workers.nth(1).getByTestId("center-task-worker-branch")).toHaveCount(0);
  await expect(first.getByTestId("center-task-review")).toHaveAttribute("data-verdict", "issues");
  await expect(first.getByTestId("center-task-review-verdict")).toHaveText("指摘あり");
  const items = first.getByTestId("center-task-review-item");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toHaveAttribute("data-severity", "high");
  await expect(items.nth(0)).toHaveAttribute("data-resolved", "true");
  await expect(items.nth(1)).toHaveAttribute("data-resolved", "false");
  await expect(first.getByTestId("center-task-remaining")).toContainText("命名の整理");
  // a remote without task_result has no block
  await expect(page.getByTestId("center-remote").nth(1).getByTestId("center-task-result")).toHaveCount(0);
});

test("an unanswered ask / approve is shown and a reply is sent as worker_reply", async ({ page }) => {
  await page.goto("/");
  await mock(page, { enabled: true });
  await seedRemotes(page, withTask());
  await page.getByTestId("open-center").click();

  // the ask of w-1f.. has a later report (progress), progress / done are not asks: only the approve of w-2a.. remains
  const asks = page.getByTestId("center-remote").nth(0).getByTestId("center-worker-ask");
  await expect(asks).toHaveCount(1);
  await expect(asks.nth(0)).toHaveAttribute("data-kind", "approve");
  await expect(asks.nth(0)).toHaveAttribute("data-worker-id", "w-2a3b4c5d6e");
  await expect(asks.nth(0).getByTestId("center-worker-ask-text")).toHaveText("push してよいか");

  const send = asks.nth(0).getByTestId("center-worker-reply-send");
  await expect(send).toBeDisabled();
  await asks.nth(0).getByTestId("center-worker-reply-input").fill("OK、feature/x に push して");
  await send.click();
  await expect(asks).toHaveCount(0);
  const sent = await page.evaluate(() => (window as unknown as { __BANTOU_MOCK__: { centerWorkerReplies: unknown[] } }).__BANTOU_MOCK__.centerWorkerReplies);
  expect(sent).toEqual([{ remote_id: "c-0a1b2c3d4e-careery", server: "p-7c1d", worker_id: "w-2a3b4c5d6e", text: "OK、feature/x に push して" }]);
});

test("a failed worker_reply keeps the ask and shows the error", async ({ page }) => {
  await page.goto("/");
  await mock(page, { enabled: true });
  await seedRemotes(page, withTask());
  await page.evaluate(() => {
    (window as unknown as { __BANTOU_MOCK__: { centerWorkerReplyError: string } }).__BANTOU_MOCK__.centerWorkerReplyError = "unknown worker";
  });
  await page.getByTestId("open-center").click();
  const ask = page.getByTestId("center-remote").nth(0).getByTestId("center-worker-ask");
  await ask.getByTestId("center-worker-reply-input").fill("はい");
  await ask.getByTestId("center-worker-reply-send").click();
  await expect(ask.getByTestId("center-worker-reply-error")).toContainText("unknown worker");
  await expect(ask).toHaveCount(1);
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

test("the server versions section shows the host name first with the server_id, and user / workspace only when servers share a host name", async ({ page }) => {
  await page.goto("/");
  await mock(page, { enabled: true });
  await seedVersions(page, {
    pair: { server: "0.3.0", protocol: "1.3.0" },
    peers: [
      versionPeer({ key: "a", id: "mx1ekubv", host: "lenovo", hostname: "lenovo", server_id: "srv-1111111111", user: "alice", workspace: "/home/alice/ws" }),
      versionPeer({ key: "b", id: "83caasod", host: "lenovo", hostname: "lenovo", server_id: "srv-2222222222", user: "bob", workspace: "/home/bob/ws" }),
      versionPeer({ key: "c", id: "zz", host: "mac200", hostname: "mac200", server_id: "srv-3333333333", user: "carol", workspace: "/m" }),
    ],
  });
  await page.getByTestId("open-center").click();
  const rows = page.getByTestId("center-version-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("lenovo");
  await expect(rows.nth(0).getByTestId("center-version-server-id")).toHaveText("srv-1111111111");
  await expect(rows.nth(0).getByTestId("center-version-who")).toHaveText("alice /home/alice/ws");
  await expect(rows.nth(1).getByTestId("center-version-who")).toHaveText("bob /home/bob/ws");
  await expect(rows.nth(2).getByTestId("center-version-server-id")).toHaveText("srv-3333333333");
  await expect(rows.nth(2).getByTestId("center-version-who")).toHaveCount(0);
});
