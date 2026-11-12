// The assembly (`createCenterClient`): rpc, health, event fan-out. The center is a fake HTTP server on 127.0.0.1.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createCenterClient, type CenterClient, type CenterClientOptions, type SettingsStore } from "../src/index.ts";
import { FakeCenter, deadUrl } from "./helpers/fake-center.ts";

const TOKEN = "tok-ABCDEF123456-secret";
const PASS = "pw-Zx9Qq7Lm";

const memStore = (initial?: unknown): SettingsStore & { value: unknown } => {
  const s = {
    value: initial,
    async read() {
      return s.value;
    },
    async write(v: unknown) {
      s.value = v;
    },
  };
  return s;
};

const live: { c: CenterClient; center?: FakeCenter }[] = [];
const mk = (store: SettingsStore, o: Partial<CenterClientOptions> = {}) => {
  const c = createCenterClient({ settingsStore: store, env: {}, ...o });
  live.push({ c });
  return c;
};
afterEach(async () => {
  for (const l of live.splice(0)) {
    await l.c.close();
    await l.center?.close();
  }
});

async function withCenter(over: Partial<CenterClientOptions> = {}) {
  const center = await FakeCenter.start(TOKEN);
  const u = new URL(center.url);
  u.username = "user";
  u.password = PASS;
  const store = memStore({ enabled: false, port: 7910, workspace: "~/.bantou", token: "", remote: { url: u.href, token: TOKEN } });
  const c = mk(store, over);
  live[live.length - 1]!.center = center;
  return { center, c, store };
}

const post = (c: CenterClient, cmd: string, body?: unknown) => c.rpc(cmd, body === undefined ? "" : JSON.stringify(body));
const noSecret = (v: unknown) => {
  const s = JSON.stringify(v);
  assert.ok(!s.includes(TOKEN), `token in ${s}`);
  assert.ok(!s.includes(PASS), `password in ${s}`);
};

test("only own command names are commands (404): unknown, tools, prototype keys, Cork, ip/snippet", async () => {
  const { c } = await withCenter();
  for (const cmd of ["nope", "constructor", "__proto__", "toString", "hasOwnProperty", "center_status", "center_regenerate_token",
    "center_local_ips", "center_connect_snippets", "workspace_open", "session_output_start", "session_input", "server_retire", ""]) {
    const r = await post(c, cmd);
    assert.equal(r.status, 404, cmd);
  }
});

test("center_get_settings: no token, tokenSet, no userinfo", async () => {
  const { c } = await withCenter();
  const r = await post(c, "center_get_settings");
  assert.equal(r.status, 200);
  const s = r.body as { token: string; tokenSet: boolean; remote: { url: string; token: string; tokenSet: boolean } };
  assert.equal(s.token, "");
  assert.equal(s.remote.token, "");
  assert.equal(s.remote.tokenSet, true);
  assert.ok(!s.remote.url.includes("@"));
  noSecret(r.body);
});

test("center_set_settings is refused by default and changes nothing", async () => {
  const { c, store } = await withCenter();
  const before = JSON.stringify(store.value);
  const r = await post(c, "center_set_settings", { settings: { enabled: false, port: 1, workspace: "~", token: "", remote: { url: "http://127.0.0.1:1/mcp", token: "other-token-0123456789" } } });
  assert.equal(r.status, 403);
  assert.equal(JSON.stringify(store.value), before);
});

test("center_set_settings with the gate open: saves, answer has no token, a new url does not take the old token", async () => {
  const { c, store } = await withCenter({ allowSettingsWrite: true });
  const r = await post(c, "center_set_settings", { settings: { enabled: false, port: 7910, workspace: "~/.bantou", token: "", remote: { url: "http://127.0.0.1:9/mcp" } } });
  assert.equal(r.status, 200);
  noSecret(r.body);
  assert.equal(JSON.stringify(store.value).includes(TOKEN), false);
  const bad = await post(c, "center_set_settings", { settings: { enabled: true, port: 7910, workspace: "~/.bantou", token: "" } });
  assert.equal(bad.status, 400);
  const notObj = await post(c, "center_set_settings", { settings: 1 });
  assert.equal(notObj.status, 400);
});

test("center_call: allowed tool passes, tool outside the list is 404 and nothing is sent", async () => {
  const { c, center } = await withCenter();
  center.tools.set("remote_list", { ok: true });
  const ok = await post(c, "center_call", { name: "remote_list", arguments: { a: 1 } });
  assert.equal(ok.status, 200);
  assert.deepEqual((ok.body as { content: { text: string }[] }).content[0]!.text, '{"ok":true}');
  for (const name of ["server_retire", "session_delete", "nope"]) {
    const before = center.count("tools/call");
    const r = await post(c, "center_call", { name });
    assert.equal(r.status, 404, name);
    assert.equal(center.count("tools/call"), before);
  }
  assert.equal((await post(c, "center_call", {})).status, 400);
  assert.equal((await post(c, "center_call", { name: "rc_list", arguments: [] })).status, 400);
});

test("a tool result that carries the token and the URL password is cleaned (raw and inside JSON text)", async () => {
  const { c, center } = await withCenter();
  center.tools.set("center_settings_get", { settings: { note: `t=${TOKEN} p=${PASS}`, weird: 'a"b' } });
  center.rawTools.set("rc_list", `leak ${TOKEN} http://user:${PASS}@127.0.0.1:1/mcp`);
  const r1 = await post(c, "center_call", { name: "center_settings_get" });
  assert.equal(r1.status, 200);
  noSecret(r1.body);
  assert.match(JSON.stringify(r1.body), /\*\*\*/);
  const r2 = await post(c, "center_call", { name: "rc_list" });
  noSecret(r2.body);
});

test("a tool error and a center failure do not carry the secrets", async () => {
  const { c, center } = await withCenter();
  center.errorTools.set("rc_list", `bad ${TOKEN} ${PASS}`);
  const r = await post(c, "center_call", { name: "rc_list" });
  assert.equal(r.status, 502);
  noSecret(r.body);
  center.requiredToken = "changed-token-0123456789"; // now 401
  const r2 = await post(c, "center_call", { name: "remote_list" });
  assert.equal(r2.status, 502);
  noSecret(r2.body);
});

test("rpc body: bad JSON 400, array 400, too large 413, empty and null are no args", async () => {
  const { c } = await withCenter();
  assert.equal((await c.rpc("center_get_settings", "{bad")).status, 400);
  assert.equal((await c.rpc("center_get_settings", "[]")).status, 400);
  assert.equal((await c.rpc("center_get_settings", "null")).status, 200);
  assert.equal((await c.rpc("center_get_settings", " ")).status, 200);
  assert.equal((await c.rpc("center_call", JSON.stringify({ name: "x".repeat(2 * 1024 * 1024) }))).status, 413);
});

test("sessions: list is the cache, refresh reads the center, create / update / settings / hints follow the Rust commands", async () => {
  const { c, center } = await withCenter();
  center.tools.set("session_list", [{ name: "a", state: "running", path: "/w/a" }]);
  center.tools.set("session_create", { name: "b", state: "running" });
  center.tools.set("session_update", { name: "c" });
  center.tools.set("session_settings_get", { name: "a", settings: { instructions: "x" } });
  center.tools.set("session_settings_update", { name: "a", settings: { instructions: null } });
  center.tools.set("center_info", { workspace: " /ws " });

  assert.deepEqual((await post(c, "list_sessions")).body, { sessions: [], reachable: true, reason: null, rev: 0 });
  const rf = (await post(c, "refresh_sessions")).body as { sessions: { name: string }[]; rev: number };
  assert.deepEqual(rf.sessions.map((s) => s.name), ["a"]);
  assert.equal(rf.rev, 1);

  const cr = await post(c, "create_session", { name: " b ", path: null, settings: { instructions: "  " } });
  assert.equal(cr.status, 200);
  assert.equal((cr.body as { name: string }).name, "b");
  const sent = center.log.filter((r) => r.body?.method === "tools/call" && r.body.params.name === "session_create").at(-1)!;
  assert.deepEqual(sent.body.params.arguments, { name: "b" });
  assert.ok(center.count("tools/call") >= 3);

  const up = await post(c, "session_update", { name: "a", newName: "c", path: null, moveDir: null });
  assert.equal(up.status, 200);
  const su = center.log.filter((r) => r.body?.params?.name === "session_update").at(-1)!;
  assert.deepEqual(su.body.params.arguments, { name: "a", newName: "c" });

  assert.deepEqual((await post(c, "session_get_settings", { name: "a" })).body, { instructions: "x" });
  assert.deepEqual((await post(c, "session_update_settings", { name: "a", settings: { instructions: "  " } })).body, { instructions: null } as never);
  const sus = center.log.filter((r) => r.body?.params?.name === "session_settings_update").at(-1)!;
  assert.deepEqual(sus.body.params.arguments, { name: "a", settings: { instructions: null } });
  assert.deepEqual((await post(c, "session_path_hints")).body, { workspace: "/ws", canPick: false });

  assert.equal((await post(c, "create_session", {})).status, 400);
  assert.equal((await post(c, "session_update_settings", { name: "a", settings: { instructions: 1 } })).status, 400);
  assert.equal((await post(c, "session_update", { name: "a", moveDir: "yes" })).status, 400);
});

test("center down: refresh keeps the old list with reachable false; path hints have no workspace", async () => {
  const { c, center } = await withCenter();
  center.tools.set("session_list", [{ name: "a" }]);
  await post(c, "refresh_sessions");
  center.requiredToken = "changed-token-0123456789";
  const r = (await post(c, "refresh_sessions")).body as { sessions: unknown[]; reachable: boolean; reason: string };
  assert.equal(r.reachable, false);
  assert.equal(r.sessions.length, 1);
  noSecret(r);
  assert.deepEqual((await post(c, "session_path_hints")).body, { workspace: null, canPick: false });
});

test("health: no target / ok / unreachable, no secrets", async () => {
  const none = mk(memStore());
  const h0 = await none.health();
  assert.equal(h0.status, "no-target");
  assert.equal(h0.connected, false);
  assert.ok(h0.reason);

  const { c, center } = await withCenter();
  const h1 = await c.health();
  assert.equal(h1.status, "ok");
  assert.equal(h1.host, new URL(center.url).host);
  assert.equal(h1.source, "remote");
  noSecret(h1);

  const dead = await deadUrl();
  const u = new URL(dead);
  u.username = "user";
  u.password = PASS;
  const down = mk(memStore({ enabled: false, port: 7910, workspace: "~", token: "", remote: { url: u.href, token: TOKEN } }));
  const h2 = await down.health();
  assert.equal(h2.status, "unreachable");
  noSecret(h2);
});

test("events: both center events and session changes reach every listener; one center subscription", async () => {
  const { c, center } = await withCenter();
  const conns: import("node:http").ServerResponse[] = [];
  center.onGet = (req, res) => {
    if (req.url !== "/events") return false;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": hi\n\n");
    conns.push(res);
    return true;
  };
  const a: unknown[] = [];
  const b: unknown[] = [];
  const ua = c.subscribe((e) => a.push(e));
  const ub = c.subscribe((e) => b.push(e));
  for (let i = 0; i < 100 && conns.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(conns.length, 1);
  conns[0]!.write('event: sessions\ndata: {"reason":"created","name":"pm-a"}\n\n');
  for (let i = 0; i < 100 && (a.length === 0 || b.length === 0); i++) await new Promise((r) => setTimeout(r, 20));
  const want = [{ event: "center-sessions-changed", data: { reason: "created", name: "pm-a" } }];
  assert.deepEqual(a, want);
  assert.deepEqual(b, want);
  center.tools.set("session_list", [{ name: "z" }]);
  await c.sessions.refresh();
  assert.deepEqual(a.at(-1), { event: "bantou://sessions-changed", data: null });
  ua();
  ub();
});

test("openEventStream: SSE frames, comment first, keep-alive, close ends it", async () => {
  const c = mk(memStore(), { keepAliveMs: 30 });
  const { readable, close } = c.openEventStream();
  let text = "";
  readable.on("data", (d: Buffer) => (text += d.toString()));
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(text.startsWith(": ok\n\n"));
  assert.match(text, /: ka\n\n/);
  const ended = new Promise<void>((r) => readable.on("close", () => r()));
  close();
  await ended;
});
