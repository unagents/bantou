import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseConfig } from "../src/config.js";
import { createCore } from "../src/core.js";
import { createEventHub } from "../src/events.js";
import type { GraphqlServices } from "../src/graphql/context.js";
import { createGraphqlHandler } from "../src/graphql/server.js";
import { startHttpServer } from "../src/http.js";
import { createCenterServer, packageVersion } from "../src/server.js";

const TOKEN = "test-token-0123456789";
const AUTH = { authorization: `Bearer ${TOKEN}` };

type Json = Record<string, unknown>;
type Overrides = Partial<{ [K in keyof GraphqlServices]: unknown }>;

/** 設計書 3 節の query 側の service を、中身の分かる fake で置いた center。 */
async function boot(over: Overrides = {}, configRaw: Json = {}, launcherKey?: string) {
  const config = parseConfig(configRaw, "/x/c.json");
  const core = createCore();
  const events = createEventHub();
  const services = {
    config,
    supervisor: { list: () => [], shutdown: async () => {} },
    link: {},
    sessions: {},
    remotes: {},
    login: undefined,
    core,
    events,
    log: () => {},
    ...over,
  } as unknown as GraphqlServices;
  const h = await startHttpServer({
    createServer: () => createCenterServer({ config, supervisor: services.supervisor, link: services.link, sessions: services.sessions, remotes: services.remotes }),
    graphql: createGraphqlHandler(services, () => {}, launcherKey ? { launcherKey } : {}),
    ...(launcherKey ? { launcherKey } : {}),
    core,
    events,
    port: 0,
    bind: "127.0.0.1",
    token: TOKEN,
    log: () => {},
  });
  const url = `http://127.0.0.1:${h.port}/graphql`;
  const q = async (query: string, headers: Record<string, string> = {}): Promise<{ data?: Json; errors?: { message: string; extensions?: { code?: string } }[] }> =>
    (await (await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...AUTH, ...headers }, body: JSON.stringify({ query }) })).json()) as never;
  return { h, q, core, url };
}

const session = (name: string, extra: Json = {}) => ({
  name, path: `/w/${name}`, state: "connected", sleeping: false, pid: 1, sessionUrl: "https://s/" + name, startedAt: "2026-11-23T00:00:00Z", source: "session",
  contextUsage: { usedTokens: 100, windowTokens: 1000, percent: 10, updatedAt: "2026-11-23T00:00:01Z" },
  activity: "needs-input", activityAt: "2026-11-23T00:00:02Z", background: { subagents: 1, tasks: 2 },
  remote: { running: 1, waitingReply: 2 }, instructions: true, auth: "ok", loginUrl: null, loginError: null, ...extra,
});

test("query sessions / session: session_list と同じ一覧（activity は needs_input に写る）。無い name は null", async () => {
  const { h, q } = await boot({ sessions: { list: () => [session("a"), session("b", { state: "stopped", sleeping: true, activity: "idle", contextUsage: null, background: { subagents: 0, tasks: 0 } })] } });
  try {
    const r = await q("{sessions{reachable reason sessions{name state sessionUrl source path instructions activity activityAt sleeping auth contextUsage{usedTokens windowTokens percent} background{subagents tasks} remote{running waitingReply}}}}");
    assert.equal(r.errors, undefined);
    const s = (r.data as { sessions: { reachable: boolean; reason: null; sessions: Json[] } }).sessions;
    assert.equal(s.reachable, true);
    assert.equal(s.reason, null);
    assert.equal(s.sessions.length, 2);
    assert.deepEqual(s.sessions[0], {
      name: "a", state: "connected", sessionUrl: "https://s/a", source: "session", path: "/w/a", instructions: true, activity: "needs_input", activityAt: "2026-11-23T00:00:02Z",
      sleeping: false, auth: "ok", contextUsage: { usedTokens: 100, windowTokens: 1000, percent: 10 }, background: { subagents: 1, tasks: 2 }, remote: { running: 1, waitingReply: 2 },
    });
    assert.equal(s.sessions[1].sleeping, true);
    assert.equal(s.sessions[1].state, "stopped");
    assert.equal(s.sessions[1].activity, "idle");
    assert.equal(s.sessions[1].contextUsage, null);
    const one = await q('{session(name:"b"){name sleeping}}');
    assert.deepEqual(one.data, { session: { name: "b", sleeping: true } });
    const none = await q('{session(name:"zzz"){name}}');
    assert.deepEqual(none.data, { session: null });
  } finally {
    await h.close();
  }
});

test("query sessionSettings: 7 項目も絞らずに返す（決定 6）。未定義の session・不正な名前は message つきの error", async () => {
  const all = { instructions: "i", addDirs: ["/a"], outputStyle: "o", servers: ["h1"], memory: { type: "http", url: "u" }, mcpServers: { x: { command: "c" } }, projectMemory: { p: 1 }, mcp: { m: 1 }, mcpConnections: { c: 1 }, mcpSecrets: { s: 1 }, coordinator: { k: 1 } };
  const asked: string[] = [];
  const { h, q } = await boot({
    sessions: {
      getSettings: (name: string) => {
        asked.push(name);
        if (name === "none") throw new Error(`未定義の session: ${name}`);
        return { name, settings: all };
      },
    },
  });
  try {
    const r = await q('{sessionSettings(name:"a"){instructions addDirs outputStyle servers memory mcpServers projectMemory mcp mcpConnections mcpSecrets coordinator}}');
    assert.equal(r.errors, undefined);
    assert.deepEqual(r.data, { sessionSettings: all });
    assert.deepEqual(asked, ["a"]);
    const e = await q('{sessionSettings(name:"none"){instructions}}');
    assert.equal(e.errors?.[0].message, "未定義の session: none");
    const bad = await q('{sessionSettings(name:"a b"){instructions}}');
    assert.match(bad.errors?.[0].message ?? "", /英数字と _ - のみ/);
    assert.deepEqual(asked, ["a", "none"], "不正な名前は service に渡さない");
  } finally {
    await h.close();
  }
});

test("query centerSettings: 共通の設定を絞らずに返し、launcher は返さない（決定 6）", async () => {
  const settings = { instructions: "i", outputStyle: "o", memory: { type: "http" }, mcpServers: { x: 1 }, coordinator: { k: 1 } };
  const { h, q } = await boot({ sessions: { getCenterSettings: () => ({ settings }) } });
  try {
    const r = await q("{centerSettings{instructions outputStyle memory mcpServers coordinator addDirs}}");
    assert.equal(r.errors, undefined);
    assert.deepEqual(r.data, { centerSettings: { ...settings, addDirs: null } });
    const l = await q("{centerSettings{launcher}}");
    assert.ok(l.errors, "launcher は schema に無い");
  } finally {
    await h.close();
  }
});

test("query centerSettings: openspecUrl も返す", async () => {
  const { h, q } = await boot({ sessions: { getCenterSettings: () => ({ settings: { openspecUrl: "http://o/mcp" } }) } });
  try {
    assert.deepEqual((await q("{centerSettings{openspecUrl}}")).data, { centerSettings: { openspecUrl: "http://o/mcp" } });
  } finally {
    await h.close();
  }
});

test("query centerInfo.launcher: 起動元の鍵が合う時だけ true（無い・違う・center に鍵が無い時は false）。preflight は X-Bantou-Launcher を許す", async () => {
  const KEY = "launcher-key-0123456789abcdef";
  const withKey = await boot({}, {}, KEY);
  try {
    const ask = (headers?: Record<string, string>) => withKey.q("{centerInfo{launcher}}", headers);
    assert.deepEqual((await ask({ "x-bantou-launcher": KEY })).data, { centerInfo: { launcher: true } });
    assert.deepEqual((await ask()).data, { centerInfo: { launcher: false } });
    assert.deepEqual((await ask({ "x-bantou-launcher": "wrong-wrong-wrong-wrong" })).data, { centerInfo: { launcher: false } });
    const pre = await fetch(withKey.url, {
      method: "OPTIONS",
      headers: { origin: "tauri://localhost", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type,x-bantou-launcher" },
    });
    assert.match(pre.headers.get("access-control-allow-headers") ?? "", /x-bantou-launcher/i);
  } finally {
    await withKey.h.close();
  }
  const noKey = await boot();
  try {
    assert.deepEqual((await noKey.q("{centerInfo{launcher}}", { "x-bantou-launcher": KEY })).data, { centerInfo: { launcher: false } });
  } finally {
    await noKey.h.close();
  }
});

test("query centerSettings: guardrailSchemas（center_settings_get と同じ形）をそのまま返す", async () => {
  const guardrailSchemas = { "openspec-x": { schema: "name: x\n", templates: { "a/b.md": "# t" } }, empty: { schema: "y", templates: {} } };
  const { h, q } = await boot({ sessions: { getCenterSettings: () => ({ settings: { guardrailSchemas } }) } });
  try {
    const r = await q("{centerSettings{guardrailSchemas}}");
    assert.equal(r.errors, undefined);
    assert.deepEqual(r.data, { centerSettings: { guardrailSchemas } });
  } finally {
    await h.close();
  }
});

test("query centerInfo / centerVersion: workspace・システム埋め込み指示の一覧・center の版", async () => {
  const withWs = await boot({}, { workspace: "/ws" });
  try {
    const r = await withWs.q("{centerInfo{workspace systemInstructions{id version title}} centerVersion{version}}");
    assert.equal(r.errors, undefined);
    const d = r.data as { centerInfo: { workspace: string; systemInstructions: { id: string; version: number; title: string }[] }; centerVersion: { version: string } };
    assert.equal(d.centerInfo.workspace, "/ws");
    assert.ok(d.centerInfo.systemInstructions.length > 0);
    for (const p of d.centerInfo.systemInstructions) {
      assert.equal(typeof p.id, "string");
      assert.equal(typeof p.version, "number");
    }
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    assert.equal(d.centerVersion.version, pkg.version);
    assert.equal(packageVersion(), pkg.version);
  } finally {
    await withWs.h.close();
  }
  const noWs = await boot();
  try {
    assert.deepEqual((await noWs.q("{centerInfo{workspace}}")).data, { centerInfo: { workspace: null } });
  } finally {
    await noWs.h.close();
  }
});

test("query remotes: remote_list（owner 無し）の全件。filter は空で呼ぶ", async () => {
  const calls: unknown[] = [];
  const running = { remote_id: "s-cap@srv", session: "s", owners: ["s"], server: "srv", serverName: "srv", server_label: "srv", state: "running", model: "sonnet", createdAt: "2026-11-23T00:00:00Z" };
  const done = { remote_id: "t-cap@srv2", session: "t", owners: ["t"], server: "srv2", serverName: "srv2", server_label: "srv2", state: "stopped", finishedAt: "2026-11-23T00:01:00.000Z", createdAt: "2026-11-23T00:00:30Z" };
  const { h, q } = await boot({ remotes: { list: (f: unknown) => (calls.push(f), [running, done]) } });
  try {
    const r = await q("{remotes{remote_id session owners server serverName server_label state model createdAt finishedAt}}");
    assert.equal(r.errors, undefined);
    assert.deepEqual(r.data, {
      remotes: [
        { ...running, finishedAt: null },
        { ...done, model: null },
      ],
    });
    assert.deepEqual(calls, [{}]);
  } finally {
    await h.close();
  }
});

test("query servers / rcStatus: servers は broker の protocol「bantou」の peer（listServers）と server-info の版。link が投げたら message つきの error。rc_list の写し", async () => {
  let fail = false;
  const peers = [
    { name: "srv", host: "h1", protocol: "2.0.0", last_seen: "2026-11-23T00:00:00Z" },
    { name: "srv2", host: null, protocol: null, last_seen: null },
  ];
  const { h, q } = await boot({
    link: {
      listServers: async () => {
        if (fail) throw new Error("broker に繋がらない");
        return peers;
      },
      serverVersionOf: (s: string) => (s === "srv" ? "0.2.0" : undefined),
    },
    supervisor: { list: () => [{ project: "a", path: "/w/a", state: "error", pid: null, sessionUrl: null, restarts: 3, lastError: "boom" }] },
  });
  try {
    assert.deepEqual((await q("{servers{name host protocol lastSeen version}}")).data, {
      servers: [
        { name: "srv", host: "h1", protocol: "2.0.0", lastSeen: "2026-11-23T00:00:00Z", version: "0.2.0" },
        { name: "srv2", host: null, protocol: null, lastSeen: null, version: null },
      ],
    });
    assert.deepEqual((await q("{rcStatus{project path state pid sessionUrl restarts lastError}}")).data, {
      rcStatus: [{ project: "a", path: "/w/a", state: "error", pid: null, sessionUrl: null, restarts: 3, lastError: "boom" }],
    });
    fail = true;
    assert.equal((await q("{servers{name}}")).errors?.[0].message, "broker に繋がらない");
  } finally {
    await h.close();
  }
});

test("query terminalOutputSince: after より後のチャンク（base64）。続きが無ければ reset。未定義の session は error", async () => {
  const { h, q, core } = await boot();
  try {
    core.register("t");
    for (const s of ["a", "b", "c"]) core.push("t", Buffer.from(s));
    const b64 = (s: string) => Buffer.from(s).toString("base64");
    const all = await q('{terminalOutputSince(session:"t"){reset chunks{id data}}}');
    assert.deepEqual(all.data, { terminalOutputSince: { reset: true, chunks: [{ id: 1, data: b64("a") }, { id: 2, data: b64("b") }, { id: 3, data: b64("c") }] } });
    const rest = await q('{terminalOutputSince(session:"t",after:1){reset chunks{id data}}}');
    assert.deepEqual(rest.data, { terminalOutputSince: { reset: false, chunks: [{ id: 2, data: b64("b") }, { id: 3, data: b64("c") }] } });
    const caughtUp = await q('{terminalOutputSince(session:"t",after:3){reset chunks{id}}}');
    assert.deepEqual(caughtUp.data, { terminalOutputSince: { reset: false, chunks: [] } });
    const ahead = await q('{terminalOutputSince(session:"t",after:99){reset chunks{id}}}');
    assert.equal((ahead.data as { terminalOutputSince: { reset: boolean } }).terminalOutputSince.reset, true);
    // 名前の形式は他の query と同じ検査（subscribe まで届かない）
    const badName = await q('{terminalOutputSince(session:"a b"){reset}}');
    assert.equal(badName.errors?.[0].message, "session の名前は英数字と _ - のみ");
    const none = await q('{terminalOutputSince(session:"nope"){reset}}');
    assert.equal(none.errors?.[0].message, "未定義の session");
    // 取り直しは購読を残さない（subscribe した数だけ解除される）
    let live = 0;
    const orig = core.subscribe.bind(core);
    core.subscribe = (n, a, l) => {
      const u = orig(n, a, l);
      if (!u) return u;
      live++;
      return () => {
        live--;
        u();
      };
    };
    core.push("t", Buffer.from("d"));
    const after = await q('{terminalOutputSince(session:"t",after:3){chunks{id}}}');
    assert.deepEqual(after.data, { terminalOutputSince: { chunks: [{ id: 4 }] } });
    assert.equal(live, 0);
  } finally {
    await h.close();
  }
});
