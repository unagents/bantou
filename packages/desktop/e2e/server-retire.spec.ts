import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

type Mock = {
  center: { enabled: boolean };
  centerVersions: unknown;
  centerRetireCalls: unknown[];
  centerRetireError: string | null;
  centerRetireResult: Record<string, unknown>;
};

/** Run `fn(mock)` in the page. `fn` is serialized: it must not capture anything. */
const mock = <T>(page: Page, fn: (m: Mock) => T) =>
  page.evaluate(
    (src) =>
      new Function("m", `return (${src})(m)`)((window as unknown as { __BANTOU_MOCK__: Mock }).__BANTOU_MOCK__),
    fn.toString(),
  ) as Promise<T>;

const peer = (over: Record<string, unknown>) => ({
  key: "k",
  id: "p",
  name: "bantou-server",
  server_version: "0.1.42",
  protocol_version: "1.8.0",
  state: "ok",
  detail: "版が一致",
  since: "2026-11-10T00:00:00.000Z",
  ...over,
});

const LENOVO_A = peer({ key: "a", id: "p-la", host: "lenovo", server_id: "srv-lenovo-a", user: "bantou-a", workspace: "/srv/a" });
const LENOVO_B = peer({ key: "b", id: "p-lb", host: "lenovo", server_id: "srv-lenovo-b", user: "bantou-b", workspace: "/srv/b" });
const OLD = peer({ key: "o", id: "p-old", host: "oldbox", server_id: "srv-old", protocol_version: "1.7.0", state: "mismatch", detail: "protocol の版が違う" });
const NO_ID = peer({ key: "n", id: "p-noid", host: "noid-box" });

async function open(page: Page, peers: unknown[]) {
  await page.goto("/");
  await mock(page, (m) => {
    m.center.enabled = true;
  });
  await page.evaluate((p) => {
    const m = (window as unknown as { __BANTOU_MOCK__: { centerVersions: unknown; centerServers: unknown[] } }).__BANTOU_MOCK__;
    m.centerVersions = { pair: { server: "0.1.42", protocol: "1.8.0" }, peers: p };
    m.centerServers = []; // no configured link: the rows come from server_peers only
  }, peers);
  await page.getByTestId("open-center").click();
  await expect(page.getByTestId("center-server-row")).toHaveCount(peers.length);
}

const rowOf = (page: Page, serverId: string) => page.locator(`[data-testid=center-server-row][data-server-id="${serverId}"]`);

test("retire: the button opens a confirm dialog that names the server (host, server_id, user / workspace); cancel is the default and sends nothing", async ({ page }) => {
  await open(page, [LENOVO_A, LENOVO_B]);
  await rowOf(page, "srv-lenovo-b").getByTestId("center-server-retire").click();
  const dlg = page.getByTestId("retire-dialog");
  await expect(dlg).toBeVisible();
  await expect(dlg.getByTestId("retire-host")).toHaveText("lenovo");
  await expect(dlg.getByTestId("retire-server-id")).toHaveText("srv-lenovo-b");
  await expect(dlg.getByTestId("retire-who")).toHaveText("bantou-b /srv/b");
  await expect(dlg.getByTestId("retire-warning")).toContainText("取り消せない");
  // the safe button has the focus: Enter / Space cancels instead of retiring
  await expect(dlg.getByTestId("retire-cancel")).toBeFocused();
  await dlg.getByTestId("retire-cancel").click();
  await expect(dlg).toBeHidden();
  expect(await mock(page, (m) => m.centerRetireCalls)).toEqual([]);
  await expect(page.getByTestId("center-server-row")).toHaveCount(2);
});

test("retire: confirming retires exactly that server by server_id (the other server on the same host stays), then shows the host steps, service and the stopped counts", async ({ page }) => {
  await open(page, [LENOVO_A, LENOVO_B]);
  await rowOf(page, "srv-lenovo-b").getByTestId("center-server-retire").click();
  await page.getByTestId("retire-confirm").click();
  const dlg = page.getByTestId("retire-dialog");
  await expect(dlg.getByTestId("retire-state")).toContainText("退役を受け付けた");
  await expect(dlg.getByTestId("retire-stopped")).toContainText("止めた cap 2 / worker 3");
  await expect(dlg.getByTestId("retire-service")).toContainText("systemd bantou-server.service");
  await expect(dlg.getByTestId("retire-host-steps")).toContainText("systemctl disable --now bantou-server.service");
  await expect(dlg.getByTestId("retire-host-steps")).toContainText("userdel bantou-srv");
  await expect(dlg.getByTestId("retire-host-steps")).toContainText("rm -rf /home/bantou-srv/ws");
  await expect(dlg.getByTestId("retire-records")).toContainText("2 件");
  // by server_id, never by the shared host name
  expect(await mock(page, (m) => m.centerRetireCalls)).toEqual([{ server: "srv-lenovo-b" }]);
  await dlg.getByTestId("retire-close").click();
  // the retired server leaves the list; the other one is still there
  await expect(page.getByTestId("center-server-row")).toHaveCount(1);
  await expect(rowOf(page, "srv-lenovo-a")).toHaveCount(1);
  await expect(rowOf(page, "srv-lenovo-b")).toHaveCount(0);
});

test("retire: a server older than protocol 1.8.0, or one without server_id, has the button disabled with the reason as its tooltip", async ({ page }) => {
  await open(page, [OLD, NO_ID, LENOVO_A]);
  const old = rowOf(page, "srv-old").getByTestId("center-server-retire");
  await expect(old).toBeDisabled();
  await expect(old).toHaveAttribute("title", /退役に未対応（protocol 1\.7\.0.*host で手動で止める/);
  const noId = rowOf(page, "p-noid").getByTestId("center-server-retire");
  await expect(noId).toBeDisabled();
  await expect(noId).toHaveAttribute("title", /server_id が分からない/);
  const ok = rowOf(page, "srv-lenovo-a").getByTestId("center-server-retire");
  await expect(ok).toBeEnabled();
  await expect(ok).toHaveAttribute("title", /退役させる/);
  expect(await mock(page, (m) => m.centerRetireCalls)).toEqual([]);
});

test("retire: a failed retire (no reply, refused) shows the center's reason, keeps the dialog open and does not drop the server from the list", async ({ page }) => {
  await open(page, [LENOVO_A]);
  await mock(page, (m) => {
    m.centerRetireError = "退役の返信（retire_result）を受け取れなかった: タイムアウト (60000ms)。退役したとは限らない";
  });
  await rowOf(page, "srv-lenovo-a").getByTestId("center-server-retire").click();
  await page.getByTestId("retire-confirm").click();
  await expect(page.getByTestId("retire-error")).toContainText("退役したとは限らない");
  await expect(page.getByTestId("retire-state")).toHaveCount(0);
  await expect(page.getByTestId("retire-confirm")).toBeEnabled();
  await page.getByTestId("retire-cancel").click();
  await expect(page.getByTestId("center-server-row")).toHaveCount(1);
});

test("retire: an already-retiring server is said so, without host steps (they were shown by the first retire)", async ({ page }) => {
  await open(page, [LENOVO_A]);
  await mock(page, (m) => {
    m.centerRetireResult = { ok: true, state: "already_retiring", records_removed: 0, sessions: [], message: "既に退役中" };
  });
  await rowOf(page, "srv-lenovo-a").getByTestId("center-server-retire").click();
  await page.getByTestId("retire-confirm").click();
  await expect(page.getByTestId("retire-state")).toContainText("既に退役中");
  await expect(page.getByTestId("retire-host-steps")).toHaveCount(0);
  await expect(page.getByTestId("retire-no-steps")).toBeVisible();
});
