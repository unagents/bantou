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
async function boot(over: Overrides = {}, configRaw: Json = {}) {
  const config = parseConfig(configRaw, "/x/c.json");
  const core = createCore();
  const events = createEventHub();
  const services = {
    config,
    supervisor: { list: () => [], shutdown: async () => {} },
    link: { list: async () => [] },
    sessions: {},
    remotes: {},
    follow: undefined,
    login: undefined,
    core,
    events,
    log: () => {},
    ...over,
  } as unknown as GraphqlServices;
  const h = await startHttpServer({
    createServer: () => createCenterServer({ config, supervisor: services.supervisor, link: services.link, sessions: services.sessions, remotes: services.remotes }),
    graphql: createGraphqlHandler(services, () => {}),
    core,
    events,
    port: 0,
    bind: "127.0.0.1",
    token: TOKEN,
    log: () => {},
  });
  const url = `http://127.0.0.1:${h.port}/graphql`;
  const q = async (query: string): Promise<{ data?: Json; errors?: { message: string; extensions?: { code?: string } }[] }> =>
    (await (await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...AUTH }, body: JSON.stringify({ query }) })).json()) as never;
  return { h, q, core };
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
  const rec = {
    remote_id: "c-1-s", session: "s", owners: ["s"], server: "srv", server_id: "sid", peer: "p", server_label: "host", state: "running", createdAt: "2026-11-23T00:00:00Z",
    pending: [{ at: "2026-11-23T00:00:01Z", owner: "s", prompt: "do" }],
    activity: { at: "t", received_ms_ago: 5, stale: false, agents: [{ kind: "cap", id: "c", cap_id: "c-1-s", state: "running", task: "t", silent_ms: 3 }] },
    worker_reports: [{ cap_id: "c-1-s", worker_id: "w", kind: "ask", text: "?", at: "t" }],
  };
  const { h, q } = await boot({ remotes: { list: (f: unknown) => (calls.push(f), [rec]) } });
  try {
    const r = await q("{remotes{remote_id session owners server server_id peer server_label state createdAt pending{owner prompt} activity{stale agents{kind state silent_ms}} worker_reports{worker_id kind text}}}");
    assert.equal(r.errors, undefined);
    assert.deepEqual(r.data, {
      remotes: [{
        remote_id: "c-1-s", session: "s", owners: ["s"], server: "srv", server_id: "sid", peer: "p", server_label: "host", state: "running", createdAt: "2026-11-23T00:00:00Z",
        pending: [{ owner: "s", prompt: "do" }], activity: { stale: false, agents: [{ kind: "cap", state: "running", silent_ms: 3 }] }, worker_reports: [{ worker_id: "w", kind: "ask", text: "?" }],
      }],
    });
    assert.deepEqual(calls, [{}]);
  } finally {
    await h.close();
  }
});

test("query servers / rcStatus: server_list・rc_list の写し。link が投げたら message つきの error", async () => {
  let fail = false;
  const { h, q } = await boot({
    link: { list: async () => { if (fail) throw new Error("broker に繋がらない"); return [{ name: "srv", connected: true, reachable: true, peerId: "me", serverPeer: "p", server_id: "sid", host: "h", user: "u", workspace: "/w" }]; } },
    supervisor: { list: () => [{ project: "a", path: "/w/a", state: "error", pid: null, sessionUrl: null, restarts: 3, lastError: "boom" }] },
  });
  try {
    assert.deepEqual((await q("{servers{name connected reachable peerId serverPeer server_id host user workspace}}")).data, {
      servers: [{ name: "srv", connected: true, reachable: true, peerId: "me", serverPeer: "p", server_id: "sid", host: "h", user: "u", workspace: "/w" }],
    });
    assert.deepEqual((await q("{rcStatus{project path state pid sessionUrl restarts lastError}}")).data, {
      rcStatus: [{ project: "a", path: "/w/a", state: "error", pid: null, sessionUrl: null, restarts: 3, lastError: "boom" }],
    });
    fail = true;
    const e = await q("{servers{name}}");
    assert.equal(e.errors?.[0].message, "broker に繋がらない");
  } finally {
    await h.close();
  }
});

test("query serverPeers: refresh: true の時だけ check してから snapshot。follow が無ければ error", async () => {
  const order: string[] = [];
  const snap = {
    pair: { server: "0.2.0", protocol: "1.9.0" },
    peers: [{ key: "k", id: "i", name: "n", state: "updating", detail: "d", since: "t", update: { to: "0.2.0", running: { caps: 1, workers: 2, reports: 3 } } }],
  };
  const follow = { check: async () => void order.push("check"), snapshot: () => (order.push("snapshot"), snap) };
  const { h, q } = await boot({ follow });
  try {
    const sel = "{pair{server protocol} peers{key id name state detail since update{to running{caps workers reports}}}}";
    const a = await q(`{serverPeers${sel}}`);
    assert.equal(a.errors, undefined);
    assert.deepEqual(a.data, { serverPeers: snap });
    assert.deepEqual(order, ["snapshot"]);
    order.length = 0;
    await q(`{serverPeers(refresh:true)${sel}}`);
    assert.deepEqual(order, ["check", "snapshot"]);
    order.length = 0;
    await q(`{serverPeers(refresh:false)${sel}}`);
    assert.deepEqual(order, ["snapshot"]);
  } finally {
    await h.close();
  }
  const none = await boot();
  try {
    const e = await none.q("{serverPeers{pair{protocol}}}");
    assert.equal(e.errors?.[0].message, "版の確認が無効");
  } finally {
    await none.h.close();
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
