import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { boardSeed } from "./seed";

type Mock = {
  center: { enabled: boolean };
  centerVersions: unknown;
  centerSettings: Record<string, Record<string, unknown>>;
  centerCommonSettings: Record<string, unknown>;
  centerVersionsError: string | null;
  calls: { cmd: string; args?: Record<string, unknown> }[];
};

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

const PEERS = [
  peer({ key: "a", id: "p-la", host: "lenovo", server_id: "srv-lenovo-a", user: "bantou-a", workspace: "/srv/a" }),
  peer({ key: "b", id: "p-lb", host: "lenovo", server_id: "srv-lenovo-b", user: "bantou-b", workspace: "/srv/b" }),
  peer({ key: "m", id: "p-mac", host: "mac200", server_id: "srv-mac" }),
];

test.use({ seed: boardSeed });

async function seedPeers(page: Page) {
  await page.evaluate((p) => {
    (window as unknown as { __BANTOU_MOCK__: { centerVersions: unknown } }).__BANTOU_MOCK__.centerVersions = { pair: { server: "0.1.42", protocol: "1.8.0" }, peers: p };
  }, PEERS);
}

const openGear = (page: Page) => page.locator('[data-testid=session-settings-open][data-name="careery"]').click();

test("project settings: 使う server is off (all servers) by default; turning it on lists the discovered servers, picks are saved as server_ids to the center", async ({ page }) => {
  await page.goto("/");
  await seedPeers(page);
  await openGear(page);
  const dlg = page.getByTestId("settings-dialog");
  await expect(dlg.getByTestId("settings-section-servers")).toBeVisible();
  await expect(dlg.getByTestId("settings-servers-limit")).not.toBeChecked();
  await expect(dlg.getByTestId("settings-server-option")).toHaveCount(0);
  await expect(dlg.getByTestId("settings-save")).toBeDisabled();
  await dlg.getByTestId("settings-servers-limit").click();
  const opts = dlg.getByTestId("settings-server-option");
  await expect(opts).toHaveCount(3);
  // two servers on one host are told apart by server_id, user and workspace
  await expect(opts.nth(0)).toContainText("lenovo");
  await expect(opts.nth(0)).toContainText("srv-lenovo-a");
  await expect(opts.nth(0)).toContainText("bantou-a /srv/a");
  await expect(opts.nth(1)).toContainText("bantou-b /srv/b");
  // nothing picked while limited = no server at all; said so
  await expect(dlg.getByTestId("settings-servers-none")).toBeVisible();
  await opts.nth(1).getByRole("checkbox").click();
  await opts.nth(2).getByRole("checkbox").click();
  await expect(dlg.getByTestId("settings-servers-none")).toHaveCount(0);
  await dlg.getByTestId("settings-save").click();
  await expect(dlg).toBeHidden();
  expect(await mock(page, (m) => m.centerSettings)).toEqual({ careery: { servers: ["srv-lenovo-b", "srv-mac"] } });
  // shown again as it was saved
  await openGear(page);
  await expect(dlg.getByTestId("settings-servers-limit")).toBeChecked();
  await expect(opts.nth(0).getByRole("checkbox")).not.toBeChecked();
  await expect(opts.nth(1).getByRole("checkbox")).toBeChecked();
  await expect(opts.nth(2).getByRole("checkbox")).toBeChecked();
  // turning it off removes the item (null to the center): back to all servers
  await dlg.getByTestId("settings-servers-limit").click();
  await dlg.getByTestId("settings-save").click();
  await expect(dlg).toBeHidden();
  expect(await mock(page, (m) => m.centerSettings)).toEqual({});
});

test("project settings: on with nothing picked is saved as an empty list (= no server), which is not the same as off", async ({ page }) => {
  await page.goto("/");
  await seedPeers(page);
  await openGear(page);
  const dlg = page.getByTestId("settings-dialog");
  await dlg.getByTestId("settings-servers-limit").click();
  await dlg.getByTestId("settings-save").click();
  await expect(dlg).toBeHidden();
  expect(await mock(page, (m) => m.centerSettings)).toEqual({ careery: { servers: [] } });
  await openGear(page);
  await expect(dlg.getByTestId("settings-servers-limit")).toBeChecked();
  await expect(dlg.getByTestId("settings-servers-none")).toBeVisible();
});

test("project settings: a host name or server_id can be typed; entries that match no discovered server are listed and removable; a bad entry blocks the save", async ({ page }) => {
  await page.goto("/");
  await seedPeers(page);
  await mock(page, (m) => {
    m.centerSettings.careery = { servers: ["gone-host", "mac200"] };
  });
  await openGear(page);
  const dlg = page.getByTestId("settings-dialog");
  // the typed host "mac200" shows as the discovered server's checked box; "gone-host" is an extra row
  await expect(dlg.getByTestId("settings-server-option").nth(2).getByRole("checkbox")).toBeChecked();
  await expect(dlg.getByTestId("settings-server-other")).toHaveCount(1);
  await expect(dlg.getByTestId("settings-server-other")).toHaveAttribute("data-server", "gone-host");
  await dlg.getByTestId("settings-server-input").fill("lenovo");
  await dlg.getByTestId("settings-server-add").click();
  await expect(dlg.getByTestId("settings-server-option").nth(0).getByRole("checkbox")).toBeChecked();
  await dlg.getByTestId("settings-server-input").fill("bad host!");
  await dlg.getByTestId("settings-server-add").click();
  await expect(dlg.getByTestId("settings-problem")).toContainText("host 名か server_id");
  await expect(dlg.getByTestId("settings-save")).toBeDisabled();
  await dlg.getByTestId("settings-server-other").filter({ hasText: "bad host!" }).getByTestId("settings-server-remove").click();
  await dlg.getByTestId("settings-server-other").filter({ hasText: "gone-host" }).getByTestId("settings-server-remove").click();
  await expect(dlg.getByTestId("settings-problem")).toHaveCount(0);
  await dlg.getByTestId("settings-save").click();
  await expect(dlg).toBeHidden();
  expect(await mock(page, (m) => m.centerSettings)).toEqual({ careery: { servers: ["mac200", "lenovo"] } });
});

test("project settings: when the server list cannot be read, the reason is shown and servers can still be typed", async ({ page }) => {
  await page.goto("/");
  await mock(page, (m) => {
    m.centerVersionsError = "peers unavailable";
  });
  await openGear(page);
  const dlg = page.getByTestId("settings-dialog");
  await dlg.getByTestId("settings-servers-limit").click();
  await expect(dlg.getByTestId("settings-servers-error")).toContainText("peers unavailable");
  await dlg.getByTestId("settings-server-input").fill("srv-typed-1");
  await dlg.getByTestId("settings-server-input").press("Enter");
  await expect(dlg.getByTestId("settings-server-other")).toHaveAttribute("data-server", "srv-typed-1");
  await dlg.getByTestId("settings-save").click();
  await expect(dlg).toBeHidden();
  expect(await mock(page, (m) => m.centerSettings)).toEqual({ careery: { servers: ["srv-typed-1"] } });
});

test("center-wide settings have no 使う server field: nothing is sent for it, and a leftover servers value from an older center is neither shown nor sent back", async ({ page }) => {
  await page.goto("/");
  await seedPeers(page);
  await mock(page, (m) => {
    m.centerCommonSettings = { instructions: "共通", servers: ["legacy-host"] };
  });
  await page.getByTestId("open-settings").click();
  const section = page.getByTestId("center-common-section");
  await expect(page.getByTestId("center-common-instructions")).toHaveValue("共通");
  // the section is not there at all (the other sections are)
  await expect(section.getByTestId("center-common-section-add-dirs")).toBeVisible();
  await expect(section.getByTestId("center-common-section-servers")).toHaveCount(0);
  await expect(section.getByTestId("center-common-servers-limit")).toHaveCount(0);
  await expect(section.getByTestId("center-common-server-input")).toHaveCount(0);
  // the common form does not ask the center for the discovered servers (they are only a choice list for a session)
  expect(await mock(page, (m) => m.calls.filter((c) => c.cmd === "center_call" && (c.args as { name: string }).name === "server_peers").length)).toBe(0);
  await page.getByTestId("center-common-instructions").fill("共通 2");
  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("settings-dialog")).toBeHidden();
  const sent = await mock(page, (m) => m.calls.filter((c) => c.cmd === "center_call" && (c.args as { name: string }).name === "center_settings_update").map((c) => c.args));
  expect(sent).toEqual([{ name: "center_settings_update", arguments: { settings: { instructions: "共通 2", addDirs: null, outputStyle: null, memory: null } } }]);
});

test("add session: 使う server is a checkbox list of the discovered servers (typing is the fallback); the picks go to session_create settings", async ({ page }) => {
  await page.goto("/");
  await seedPeers(page);
  await page.getByTestId("open-add-session").click();
  const dlg = page.getByTestId("add-dialog");
  await expect(dlg.getByTestId("add-section-servers")).toBeVisible();
  await expect(dlg.getByTestId("add-servers-limit")).not.toBeChecked();
  await dlg.getByTestId("add-servers-limit").click();
  await expect(dlg.getByTestId("add-server-option")).toHaveCount(3);
  await expect(dlg.getByTestId("add-server-input")).toBeVisible();
  await dlg.getByTestId("add-server-option").nth(2).getByRole("checkbox").click();
  await dlg.getByTestId("add-name").fill("pm-srv");
  await dlg.getByTestId("add-create").click();
  await expect(dlg).toBeHidden();
  const call = await mock(page, (m) => m.calls.filter((c) => c.cmd === "create_session").at(-1));
  expect(call?.args).toEqual({ name: "pm-srv", path: null, settings: { servers: ["srv-mac"] } });
});

test("a session whose saved settings have no servers item (old format) opens with the field off and nothing to save until changed", async ({ page }) => {
  await page.goto("/");
  await seedPeers(page);
  await mock(page, (m) => {
    m.centerSettings.careery = { instructions: "旧形式" };
  });
  await openGear(page);
  const dlg = page.getByTestId("settings-dialog");
  await expect(dlg.getByTestId("settings-instructions")).toHaveValue("旧形式");
  await expect(dlg.getByTestId("settings-servers-limit")).not.toBeChecked();
  await expect(dlg.getByTestId("settings-save")).toBeDisabled();
});
