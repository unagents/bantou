import type { Page } from "@playwright/test";

import { expect, pickSession, test } from "./fixtures";
import { boardSeed } from "./seed";

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

test("the center dialog shows the connection, the remote sessions and the server list", async ({ page }) => {
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

  // the remotes (cap / worker detail) are not in the dialog; the server list is one list without cap / worker rows
  await expect(page.getByTestId("center-remote")).toHaveCount(0);
  await expect(page.getByTestId("center-remotes")).toHaveCount(0);
  await expect(page.getByTestId("center-agent")).toHaveCount(0);
  const srv = page.getByTestId("center-server-row");
  await expect(srv).toHaveCount(1);
  await expect(srv).toHaveAttribute("data-host", "mac200");
  await expect(srv.getByTestId("center-server-name")).toHaveText("srv1");
  await expect(srv.getByTestId("center-server-host")).toHaveText("mac200");
  await expect(srv.getByTestId("center-server-version")).toHaveText("2.0.0");
  await expect(srv).not.toContainText("cap-a");
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
  { remote_id: "c-0a1b2c3d4e", owners: [], server: "p-8e2f", serverName: "other-server", state: "stopped", createdAt: "2026-10-28T22:00:00.000Z", result: "PR を確認した。\n指摘は 3 件", result_at: "2026-10-28T23:00:00.000Z", pending: [] },
];

const seedRemotes = (page: Page, list: unknown[]) =>
  page.evaluate((l) => {
    (window as unknown as { __BANTOU_MOCK__: { centerRemotes: unknown[] } }).__BANTOU_MOCK__.centerRemotes = l;
  }, list);

test.describe("remotes of a session (the center dialog no longer lists them)", () => {
  test.use({ seed: boardSeed });

  test("a session's remotes show each cap and worker with state, task and time since the last output", async ({ page }) => {
    await page.goto("/");
    await mock(page, { enabled: true });
    await seedRemotes(page, remotes("running"));
    await pickSession(page, "careery");

    await expect(page.getByTestId("session-remote")).toHaveCount(1);
    const first = page.getByTestId("session-remote").nth(0);
    const agents = first.getByTestId("session-remote-agent");
    await expect(agents).toHaveCount(4);
    await expect(agents.nth(0)).toHaveAttribute("data-kind", "cap");
    await expect(agents.nth(0)).toHaveAttribute("data-state", "idle");
    await expect(agents.nth(0).getByTestId("session-remote-agent-state")).toHaveText("待機");
    await expect(agents.nth(0).getByTestId("session-remote-elapsed")).toContainText("最終出力 1分前");
    await expect(agents.nth(1).getByTestId("session-remote-agent-state")).toHaveText("動作中");
    await expect(agents.nth(1).getByTestId("session-remote-task")).toHaveText("task of w-1f2e3d4c5b");
    await expect(agents.nth(1).getByTestId("session-remote-last")).toHaveText("Bash 実行中 60s");
    await expect(agents.nth(1).getByTestId("session-remote-elapsed")).toContainText(/最終出力 \d+秒前/);
    await expect(agents.nth(2).getByTestId("session-remote-agent-state")).toHaveText("停滞");
    await expect(agents.nth(2).getByTestId("session-remote-elapsed")).toContainText("最終出力 6分前");
    await expect(agents.nth(3).getByTestId("session-remote-agent-state")).toHaveText("消失");
    await expect(agents.nth(3)).toContainText("signal SIGKILL で終了");

    await expect(first.getByTestId("session-remote-model")).toHaveText("opus");
    await expect(agents.nth(0).getByTestId("session-remote-agent-model")).toHaveText("opus");
    await expect(agents.nth(1).getByTestId("session-remote-agent-model")).toHaveText("claude-sonnet-5-5");
    await expect(agents.nth(2).getByTestId("session-remote-agent-model")).toHaveCount(0);
    await expect(first.getByTestId("session-remote-stale")).toHaveCount(0);
    await expect(first.getByTestId("session-remote-waiting")).toHaveCount(0);
  });

  test("one row per server: cap state, head of the latest result and workers. No history, no old-format badge, no list of finished records", async ({ page }) => {
    await page.goto("/");
    await mock(page, { enabled: true });
    await seedRemotes(page, remotes("running"));
    await pickSession(page, "careery");

    // a session lists only its own remote: the other session's and the old shared cap (no session) are not here
    const rows = page.getByTestId("session-remote");
    await expect(rows).toHaveCount(1);
    const first = rows.nth(0);
    await expect(first.getByTestId("session-remote-result")).toHaveText("整理した");
    await expect(first.getByTestId("session-remote-agent").nth(0).getByTestId("session-remote-agent-state")).toHaveText("待機");
    await expect(page.getByText("other-server")).toHaveCount(0);
    await expect(page.getByTestId("session-remote-history")).toHaveCount(0);
    await expect(page.getByTestId("session-remote-history-item")).toHaveCount(0);
    await expect(page.getByTestId("session-remote-legacy")).toHaveCount(0);
    await expect(page.getByText("活動情報なし")).toHaveCount(0);
  });

  test("the remotes section refreshes by itself without pressing update", async ({ page }) => {
    await page.goto("/");
    await mock(page, { enabled: true });
    await seedRemotes(page, remotes("running"));
    await pickSession(page, "careery");
    const worker = page.getByTestId("session-remote").nth(0).getByTestId("session-remote-agent").nth(1);
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
    await pickSession(page, "careery");

    const first = page.getByTestId("session-remote").nth(0);
    await expect(first.getByTestId("session-task-summary")).toHaveText("task メッセージを追加した");
    await expect(first.getByTestId("session-task-error")).toHaveText("tests 一部失敗");
    const workers = first.getByTestId("session-task-worker");
    await expect(workers).toHaveCount(2);
    await expect(workers.nth(0)).toContainText("implement");
    await expect(workers.nth(0).getByTestId("session-task-worker-branch")).toHaveText("feature/x");
    await expect(workers.nth(0).getByTestId("session-task-worker-commit")).toHaveText("abc1234");
    await expect(workers.nth(0).getByTestId("session-task-worker-tests")).toHaveText("npm test: 28 pass");
    await expect(workers.nth(0).getByTestId("session-task-worker-result")).toHaveText("型とガードを追加した");
    await expect(workers.nth(1).getByTestId("session-task-worker-branch")).toHaveCount(0);
    await expect(first.getByTestId("session-task-review")).toHaveAttribute("data-verdict", "issues");
    await expect(first.getByTestId("session-task-review-verdict")).toHaveText("指摘あり");
    const items = first.getByTestId("session-task-review-item");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toHaveAttribute("data-severity", "high");
    await expect(items.nth(0)).toHaveAttribute("data-resolved", "true");
    await expect(items.nth(1)).toHaveAttribute("data-resolved", "false");
    await expect(first.getByTestId("session-task-remaining")).toContainText("命名の整理");
    // a remote without task_result has no block
    await expect(page.getByTestId("session-remote").nth(1).getByTestId("session-task-result")).toHaveCount(0);
  });

  test("an unanswered ask / approve is shown and a reply is sent as worker_reply", async ({ page }) => {
    await page.goto("/");
    await mock(page, { enabled: true });
    await seedRemotes(page, withTask());
    await pickSession(page, "careery");

    // the ask of w-1f.. has a later report (progress), progress / done are not asks: only the approve of w-2a.. remains
    const asks = page.getByTestId("session-remote").nth(0).getByTestId("session-worker-ask");
    await expect(asks).toHaveCount(1);
    await expect(asks.nth(0)).toHaveAttribute("data-kind", "approve");
    await expect(asks.nth(0)).toHaveAttribute("data-worker-id", "w-2a3b4c5d6e");
    await expect(asks.nth(0).getByTestId("session-worker-ask-text")).toHaveText("push してよいか");

    const send = asks.nth(0).getByTestId("session-worker-reply-send");
    await expect(send).toBeDisabled();
    await asks.nth(0).getByTestId("session-worker-reply-input").fill("OK、feature/x に push して");
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
    await pickSession(page, "careery");
    const ask = page.getByTestId("session-remote").nth(0).getByTestId("session-worker-ask");
    await ask.getByTestId("session-worker-reply-input").fill("はい");
    await ask.getByTestId("session-worker-reply-send").click();
    await expect(ask.getByTestId("session-worker-reply-error")).toContainText("unknown worker");
    await expect(ask).toHaveCount(1);
  });

  test("the remotes section says so when there is no remote", async ({ page }) => {
    await page.goto("/");
    await mock(page, { enabled: true });
    await pickSession(page, "careery");
    await expect(page.getByTestId("session-remotes-none")).toHaveText("remote なし");
  });
});

/** Seed server_list (the peers registered with protocol "bantou"). */
const seedServers = (page: Page, v: unknown) =>
  page.evaluate((x) => {
    (window as unknown as { __BANTOU_MOCK__: { centerServers: unknown } }).__BANTOU_MOCK__.centerServers = x;
  }, v);

const server = (over: Record<string, unknown>) => ({ name: "srv1", host: "mac200", protocol: "2.0.0", last_seen: "2026-11-23T00:00:00.000Z", ...over });

test("a server row shows the name, the host and the protocol version, and nothing else", async ({ page }) => {
  await page.goto("/");
  await mock(page, { enabled: true });
  await seedServers(page, [server({ name: "srv-a", host: "host-a" }), server({ name: "srv-b", host: "host-b", protocol: "2.1.0" })]);
  await page.getByTestId("open-center").click();
  const rows = page.getByTestId("center-server-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator("span").first()).toHaveText("srv-a");
  await expect(rows.nth(0).getByTestId("center-server-host")).toHaveText("host-a");
  await expect(rows.nth(0).getByTestId("center-server-version")).toHaveText("2.0.0");
  await expect(rows.nth(1).getByTestId("center-server-version")).toHaveText("2.1.0");
  await expect(page.getByTestId("center-pair")).toHaveCount(0);
  await expect(page.getByTestId("center-server-retire")).toHaveCount(0);
  await expect(page.getByTestId("center-server-link-badge")).toHaveCount(0);
  await expect(page.getByTestId("center-server-version-badge")).toHaveCount(0);
});

test("pressing update re-reads the server list", async ({ page }) => {
  await page.goto("/");
  await mock(page, { enabled: true });
  await page.getByTestId("open-center").click();
  await expect(page.getByTestId("center-server-row")).toHaveCount(1);
  await seedServers(page, [server({ name: "srv-a" }), server({ name: "srv-b" })]);
  await page.getByTestId("center-refresh").click();
  await expect(page.getByTestId("center-server-row")).toHaveCount(2);
});

test("the server list says so when there is no server", async ({ page }) => {
  await page.goto("/");
  await mock(page, { enabled: true });
  await seedServers(page, []);
  await page.getByTestId("open-center").click();
  await expect(page.getByTestId("center-versions-none")).toHaveText("server なし");
  await expect(page.getByTestId("center-server-row")).toHaveCount(0);
});

test("a failed server_list shows the error and the remote session list stays", async ({ page }) => {
  await page.goto("/");
  await mock(page, { enabled: true });
  await page.evaluate(() => {
    (window as unknown as { __BANTOU_MOCK__: { centerServersError: string } }).__BANTOU_MOCK__.centerServersError = "peers unavailable";
  });
  await page.getByTestId("open-center").click();
  await expect(page.getByTestId("center-versions-error")).toContainText("peers unavailable");
  await expect(page.getByTestId("center-rc")).toHaveCount(2);
});

test("the server_list error is cleared when the center goes away", async ({ page }) => {
  await page.goto("/");
  await mock(page, { enabled: true });
  await page.evaluate(() => {
    (window as unknown as { __BANTOU_MOCK__: { centerServersError: string } }).__BANTOU_MOCK__.centerServersError = "peers unavailable";
  });
  await page.getByTestId("open-center").click();
  await expect(page.getByTestId("center-versions-error")).toContainText("peers unavailable");
  await mock(page, { reachable: false });
  await page.getByTestId("center-refresh").click();
  await expect(page.getByTestId("center-conn-state")).toHaveText("disconnected");
  await expect(page.getByTestId("center-versions-error")).toHaveCount(0);
});

test("the remote session list stays and keeps its place above the servers", async ({ page }) => {
  await page.goto("/");
  await mock(page, { enabled: true });
  await page.getByTestId("open-center").click();
  await expect(page.getByTestId("center-rc")).toHaveCount(2);
  const rcBox = await page.getByTestId("center-rc").first().boundingBox();
  const srvBox = await page.getByTestId("center-server-row").first().boundingBox();
  expect(rcBox!.y).toBeLessThan(srvBox!.y);
  await expect(page.getByText("remote session", { exact: true })).toBeVisible();
});
