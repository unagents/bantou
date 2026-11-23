import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseConfig } from "../src/config.js";
import { createCore } from "../src/core.js";
import { createEventHub } from "../src/events.js";
import type { GraphqlContext, GraphqlServices } from "../src/graphql/context.js";
import { createGraphqlHandler } from "../src/graphql/server.js";
import { startHttpServer } from "../src/http.js";
import { createCenterServer } from "../src/server.js";
import { MAX_ATTACHMENT_BYTES } from "../src/attachments.js";
import { SLEEP_REFUSED_PREFIX } from "../src/resession.js";
import { mutationResolvers } from "../src/graphql/resolvers/mutation.js";

const TOKEN = "test-token-0123456789";

type Call = [string, ...unknown[]];

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest")]);

/** SessionInfo（sessions.ts）の形。activity は内部の値（needs-input）で返し、GraphQL の enum（needs_input）に写る事を見る。 */
const info = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  path: `/w/${name}`,
  state: "connected",
  sleeping: false,
  pid: 1,
  sessionUrl: null,
  startedAt: null,
  source: "session",
  contextUsage: null,
  activity: "needs-input",
  activityAt: null,
  background: { subagents: 0, tasks: 0 },
  remote: { running: 0, waitingReply: 0 },
  instructions: false,
  auth: "ok",
  loginUrl: null,
  loginError: null,
  ...extra,
});

async function boot(over: Partial<Record<string, unknown>> = {}, workspace?: string) {
  const calls: Call[] = [];
  const rec =
    <T>(name: string, ret: T | ((...a: unknown[]) => T)) =>
    (...a: unknown[]): T => {
      calls.push([name, ...a]);
      return typeof ret === "function" ? (ret as (...a: unknown[]) => T)(...a) : ret;
    };
  const core = createCore();
  const events = createEventHub();
  const config = parseConfig({}, "/tmp/c.json");
  const sessions = {
    create: rec("create", async (i: unknown) => info((i as { name: string }).name)),
    update: rec("update", async (i: unknown) => info((i as { newName?: string; name: string }).newName ?? (i as { name: string }).name)),
    sleep: rec("sleep", async (n: unknown) => info(n as string, { sleeping: true, state: "stopped" })),
    wake: rec("wake", async (n: unknown) => info(n as string)),
    updateSettings: rec("updateSettings", async (n: unknown, p: unknown) => ({ name: n, settings: p })),
    updateCenterSettings: rec("updateCenterSettings", async (p: unknown) => ({ settings: p })),
    list: rec("list", () => [] as unknown[]),
  };
  // session_sleep と同じ入口（resession.requestSleep）。引継ぎを頼んで受理して即返す形を返す
  const resession = {
    requestSleep: rec("requestSleep", async (n: unknown) => ({ name: n, state: "connected", accepted: true, sleeping: false, pending: true })),
  };
  const supervisor = {
    list: () => [],
    shutdown: async () => {},
    stop: rec("stop", async () => ({})),
    start: rec("start", async () => ({})),
  };
  const link = {};
  const remotes = { reply: rec("reply", async (i: unknown) => ({ ...(i as object), sent: true })) };
  const login = {
    start: rec("loginStart", async (n: unknown) => ({ name: n, loginUrl: "https://login.example/x" })),
    code: rec("loginCode", async (n: unknown, c: unknown) => ({ name: n, ok: c === "good", auth: c === "good" ? "ok" : "login_required", error: c === "good" ? null : "Invalid code" })),
  };
  const services = {
    config,
    supervisor,
    link,
    remotes,
    sessions,
    resession,
    login,
    core,
    events,
    log: () => {},
    ...(workspace ? { workspace } : {}),
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
  const call = async (query: string, variables: Record<string, unknown> = {}) => {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ query, variables }) });
    return (await r.json()) as { data?: Record<string, any> | null; errors?: { message: string; extensions: { code: string } }[] };
  };
  return { h, core, calls, call, close: () => h.close() };
}

const only = (calls: Call[], name: string) => calls.filter((c) => c[0] === name);

test("createSession: sessions.create に name / path / settings を渡し、Session を返す（null の path は渡さない）", async () => {
  const t = await boot();
  try {
    const r = await t.call(
      `mutation($s: ProjectSettingsInput){ a: createSession(name:"a", path:"/p/a", settings:$s){ name activity path } b: createSession(name:"b", path:null){ name } }`,
      { s: { instructions: "hi", addDirs: ["/x"] } },
    );
    assert.equal(r.errors, undefined);
    // 内部の needs-input が GraphQL の enum needs_input で返る
    assert.deepEqual(r.data!.a, { name: "a", activity: "needs_input", path: "/w/a" });
    assert.deepEqual(only(t.calls, "create")[0][1], { name: "a", path: "/p/a", settings: { instructions: "hi", addDirs: ["/x"] } });
    assert.deepEqual(only(t.calls, "create")[1][1], { name: "b" });
  } finally {
    await t.close();
  }
});

test("createSession: 不正な名前は BAD_USER_INPUT で service を呼ばない", async () => {
  const t = await boot();
  try {
    const r = await t.call(`mutation{ createSession(name:"a/b"){ name } }`);
    assert.equal(r.errors![0].extensions.code, "BAD_USER_INPUT");
    assert.match(r.errors![0].message, /英数字と _ - のみ/);
    assert.equal(only(t.calls, "create").length, 0);
  } finally {
    await t.close();
  }
});

test("createSession: service の error は理由つきで返る（mask されない）", async () => {
  const t = await boot({ sessions: { create: async () => { throw new Error("同じ名前の session がある: a"); } } });
  try {
    const r = await t.call(`mutation{ createSession(name:"a"){ name } }`);
    assert.equal(r.errors![0].message, "同じ名前の session がある: a");
    assert.equal(r.errors![0].extensions.code, "OPERATION_FAILED");
  } finally {
    await t.close();
  }
});

test("updateSession: newName / path / move を渡す", async () => {
  const t = await boot();
  try {
    const r = await t.call(`mutation{ updateSession(name:"a", newName:"b", path:"/n", move:true){ name } }`);
    assert.deepEqual(r.data!.updateSession, { name: "b" });
    assert.deepEqual(only(t.calls, "update")[0][1], { name: "a", newName: "b", path: "/n", move: true });
    const bad = await t.call(`mutation{ updateSession(name:"a", newName:"x y"){ name } }`);
    assert.equal(bad.errors![0].extensions.code, "BAD_USER_INPUT");
    assert.equal(only(t.calls, "update").length, 1);
  } finally {
    await t.close();
  }
});

test("sleepSession: resession.requestSleep を通し（sessions.sleep は直接呼ばない）、受理して即返す形 { accepted, sleeping:false, pending:true } で返る", async () => {
  const t = await boot();
  try {
    const r = await t.call(`mutation{ sleepSession(name:"a"){ name state accepted sleeping pending } }`);
    assert.equal(r.errors, undefined);
    assert.deepEqual(r.data!.sleepSession, { name: "a", state: "connected", accepted: true, sleeping: false, pending: true });
    assert.deepEqual(only(t.calls, "requestSleep"), [["requestSleep", "a"]]);
    assert.equal(only(t.calls, "sleep").length, 0, "sessions.sleep を直接呼ばない");
  } finally {
    await t.close();
  }
});

test("sleepSession: すでに眠っている時は { sleeping:true, pending:false } がそのまま返る", async () => {
  const t = await boot({ resession: { requestSleep: async (n: string) => ({ name: n, state: "stopped", accepted: true, sleeping: true, pending: false }) } });
  try {
    const r = await t.call(`mutation{ sleepSession(name:"a"){ name state accepted sleeping pending } }`);
    assert.deepEqual(r.data!.sleepSession, { name: "a", state: "stopped", accepted: true, sleeping: true, pending: false });
  } finally {
    await t.close();
  }
});

test("sleepSession: 断り（SLEEP_REFUSED_PREFIX つきの理由）は、MCP の session_sleep と同じ理由の文のまま OPERATION_FAILED の error で返る", async () => {
  const reason = SLEEP_REFUSED_PREFIX + "作業中は眠らせられない（turn・subagent・background が動いている。終わってから）";
  const t = await boot({ resession: { requestSleep: async () => { throw new Error(reason); } } });
  try {
    const r = await t.call(`mutation{ sleepSession(name:"a"){ name } }`);
    assert.equal(r.errors![0].message, reason);
    assert.equal(r.errors![0].extensions.code, "OPERATION_FAILED");
    assert.equal(r.data, null);
  } finally {
    await t.close();
  }
});

test("sleepSession: 名前の誤りは requestSleep を呼ばず BAD_USER_INPUT", async () => {
  const t = await boot();
  try {
    const r = await t.call(`mutation{ sleepSession(name:"a b"){ name } }`);
    assert.equal(r.errors![0].extensions.code, "BAD_USER_INPUT");
    assert.equal(only(t.calls, "requestSleep").length, 0);
  } finally {
    await t.close();
  }
});

test("wakeSession: sessions.wake を通し（MCP の session_wake と同じ。引継ぎの有無は wake が決める）、Session を返す", async () => {
  const t = await boot();
  try {
    const r = await t.call(`mutation{ wakeSession(name:"a"){ name sleeping } }`);
    assert.equal(r.errors, undefined);
    assert.deepEqual(r.data!.wakeSession, { name: "a", sleeping: false });
    assert.deepEqual(only(t.calls, "wake"), [["wake", "a"]]);
    assert.equal(only(t.calls, "requestSleep").length, 0);
  } finally {
    await t.close();
  }
});

test("updateSessionSettings: null は項目の削除として渡り、memory / mcpServers も拒否しない（決定 6）", async () => {
  const t = await boot();
  try {
    const r = await t.call(
      `mutation($s: ProjectSettingsInput!){ updateSessionSettings(name:"a", settings:$s){ instructions memory mcpServers } }`,
      { s: { instructions: null, memory: { type: "http", url: "http://m" }, mcpServers: { x: { command: "c" } } } },
    );
    assert.equal(r.errors, undefined);
    assert.deepEqual(only(t.calls, "updateSettings")[0].slice(1), ["a", { instructions: null, memory: { type: "http", url: "http://m" }, mcpServers: { x: { command: "c" } } }]);
    assert.deepEqual(r.data!.updateSessionSettings, { instructions: null, memory: { type: "http", url: "http://m" }, mcpServers: { x: { command: "c" } } });
  } finally {
    await t.close();
  }
});

test("updateSessionSettings: instructions の上限（16000 文字）は MCP の道具と同じ検査で断る", async () => {
  const t = await boot();
  try {
    const r = await t.call(`mutation($s: ProjectSettingsInput!){ updateSessionSettings(name:"a", settings:$s){ instructions } }`, { s: { instructions: "x".repeat(16001) } });
    assert.equal(r.errors![0].extensions.code, "BAD_USER_INPUT");
    assert.equal(only(t.calls, "updateSettings").length, 0);
  } finally {
    await t.close();
  }
});

test("updateCenterSettings: sessions.updateCenterSettings に渡し、settings を返す", async () => {
  const t = await boot();
  try {
    const r = await t.call(`mutation{ updateCenterSettings(settings:{ outputStyle:"s", addDirs:null }){ outputStyle addDirs } }`);
    assert.equal(r.errors, undefined);
    assert.deepEqual(only(t.calls, "updateCenterSettings")[0][1], { outputStyle: "s", addDirs: null });
    assert.deepEqual(r.data!.updateCenterSettings, { outputStyle: "s", addDirs: null });
  } finally {
    await t.close();
  }
});

test("updateCenterSettings: guardrailSchemas を MCP の center_settings_update と同じ検査で通す（名前・templates の path・形）", async () => {
  const t = await boot();
  try {
    const ok = { "openspec-x.1": { schema: "name: x\n", templates: { "a/b.md": "# t" } }, gone: null };
    const r = await t.call(`mutation($s: CenterSettingsInput!){ updateCenterSettings(settings:$s){ guardrailSchemas } }`, { s: { guardrailSchemas: ok } });
    assert.equal(r.errors, undefined);
    assert.deepEqual(only(t.calls, "updateCenterSettings")[0][1], { guardrailSchemas: ok });
    assert.deepEqual(r.data!.updateCenterSettings, { guardrailSchemas: ok });
    // templates 省略・guardrailSchemas 全部削除（null）も通る
    const omit = await t.call(`mutation{ a: updateCenterSettings(settings:{ guardrailSchemas:{ s:{ schema:"y" } } }){ guardrailSchemas } b: updateCenterSettings(settings:{ guardrailSchemas:null }){ guardrailSchemas } }`);
    assert.equal(omit.errors, undefined);
    assert.equal(only(t.calls, "updateCenterSettings").length, 3);
    // 名前の規則・templates の path・schema の型の誤りは service に渡さず BAD_USER_INPUT
    const before = only(t.calls, "updateCenterSettings").length;
    for (const bad of [{ "-x": { schema: "y" } }, { "a b": { schema: "y" } }, { s: { schema: 1 } }, { s: { schema: "y", templates: { "../x": "z" } } }, { s: { schema: "y", templates: { "/abs": "z" } } }, { s: { schema: "y", templates: { a: 1 } } }]) {
      const e = await t.call(`mutation($s: CenterSettingsInput!){ updateCenterSettings(settings:$s){ guardrailSchemas } }`, { s: { guardrailSchemas: bad } });
      assert.equal(e.errors![0].extensions.code, "BAD_USER_INPUT", JSON.stringify(bad));
    }
    assert.equal(only(t.calls, "updateCenterSettings").length, before);
  } finally {
    await t.close();
  }
});

test("startSessionLogin / submitSessionLoginCode: login に渡す。コード不正は error でなく ok:false で返る", async () => {
  const t = await boot();
  try {
    const s = await t.call(`mutation{ startSessionLogin(name:"a"){ name loginUrl } }`);
    assert.deepEqual(s.data!.startSessionLogin, { name: "a", loginUrl: "https://login.example/x" });
    const ok = await t.call(`mutation{ submitSessionLoginCode(name:"a", code:"good"){ ok auth error } }`);
    assert.deepEqual(ok.data!.submitSessionLoginCode, { ok: true, auth: "ok", error: null });
    const ng = await t.call(`mutation{ submitSessionLoginCode(name:"a", code:"bad"){ ok auth error } }`);
    assert.equal(ng.errors, undefined);
    assert.deepEqual(ng.data!.submitSessionLoginCode, { ok: false, auth: "login_required", error: "Invalid code" });
    // コードの形が違えば断る
    const bad = await t.call(`mutation{ submitSessionLoginCode(name:"a", code:"a b"){ ok } }`);
    assert.equal(bad.errors![0].extensions.code, "BAD_USER_INPUT");
    assert.equal(only(t.calls, "loginCode").length, 2);
  } finally {
    await t.close();
  }
});

test("startSessionLogin: login が無い center は理由つきの error", async () => {
  const t = await boot({ login: undefined });
  try {
    const r = await t.call(`mutation{ startSessionLogin(name:"a"){ name } }`);
    assert.match(r.errors![0].message, /再ログインは使えない/);
  } finally {
    await t.close();
  }
});

test("restartSession: stop → start(resume) の順（rc_stop → rc_start と同じ）", async () => {
  const t = await boot();
  try {
    const r = await t.call(`mutation{ restartSession(name:"a") }`);
    assert.equal(r.data!.restartSession, true);
    assert.deepEqual(t.calls.map((c) => c[0]), ["stop", "list", "start"]);
    assert.deepEqual(only(t.calls, "stop")[0], ["stop", "a"]);
    assert.deepEqual(only(t.calls, "start")[0], ["start", "a", { resume: true }]);
  } finally {
    await t.close();
  }
});

test("restartSession: スリープ中の session は start でなく wake で起こす", async () => {
  const t = await boot({ sessions: { list: () => [{ name: "a", sleeping: true }], wake: async () => info("a") } });
  try {
    const r = await t.call(`mutation{ restartSession(name:"a") }`);
    assert.equal(r.data!.restartSession, true);
    assert.equal(only(t.calls, "start").length, 0);
    assert.equal(only(t.calls, "stop").length, 1);
  } finally {
    await t.close();
  }
});

test("replyWorker: remotes.reply に worker_reply と同じ形（server・session_id・order・content）で渡す", async () => {
  const t = await boot();
  try {
    const r = await t.call(`mutation{ replyWorker(server:"srv", sessionId:"w1", order:"answer", content:"ok") }`);
    assert.equal(r.data!.replyWorker, true);
    assert.deepEqual(only(t.calls, "reply")[0][1], { server: "srv", session_id: "w1", order: "answer", content: "ok" });
    // approve は content なし（null は指定なしと同じ）
    await t.call(`mutation{ replyWorker(server:"srv", sessionId:"w1", order:"approve", content:null) }`);
    assert.deepEqual(only(t.calls, "reply")[1][1], { server: "srv", session_id: "w1", order: "approve" });
    const bad = await t.call(`mutation{ replyWorker(server:"srv", sessionId:"w1", order:"maybe") }`);
    assert.equal(bad.errors![0].extensions.code, "BAD_USER_INPUT");
    const nul = await t.call(`mutation($t:String!){ replyWorker(server:"s", sessionId:"w", order:"answer", content:$t) }`, { t: "a\u0000b" });
    assert.equal(nul.errors![0].extensions.code, "BAD_USER_INPUT");
    assert.equal(only(t.calls, "reply").length, 2);
  } finally {
    await t.close();
  }
});

/** 実行中の端末（wrapper）の代わり。入力とサイズを記録する。 */
function attachSink(core: ReturnType<typeof createCore>, name: string) {
  const got: { input: Buffer[]; size: [number, number][] } = { input: [], size: [] };
  core.register(name);
  core.attach(name, { input: (d) => got.input.push(d), resize: (c, r) => got.size.push([c, r]) });
  return got;
}

test("terminalInput / terminalResize: 実行中の session の端末へ渡る（base64 を復号、サイズは 1〜1000）", async () => {
  const t = await boot();
  try {
    const got = attachSink(t.core, "a");
    const r = await t.call(`mutation($d:String!){ terminalInput(session:"a", dataB64:$d) terminalResize(session:"a", cols:120, rows:40) }`, { d: Buffer.from("ls\r").toString("base64") });
    assert.equal(r.errors, undefined);
    assert.deepEqual(r.data, { terminalInput: true, terminalResize: true });
    assert.equal(got.input[0].toString(), "ls\r");
    assert.deepEqual(got.size, [[120, 40]]);
    const big = await t.call(`mutation{ terminalResize(session:"a", cols:1001, rows:40) }`);
    assert.equal(big.errors![0].extensions.code, "BAD_USER_INPUT");
    const zero = await t.call(`mutation{ terminalResize(session:"a", cols:0, rows:40) }`);
    assert.equal(zero.errors![0].extensions.code, "BAD_USER_INPUT");
    const notB64 = await t.call(`mutation{ terminalInput(session:"a", dataB64:"!!") }`);
    assert.equal(notB64.errors![0].extensions.code, "BAD_USER_INPUT");
    // 空・長さが 4 の倍数でない・padding が途中にある物は通さない
    for (const bad of ["", "YQ", "YQ=", "YQ==YQ==", "YWJj="]) {
      const r = await t.call(`mutation($d:String!){ terminalInput(session:"a", dataB64:$d) }`, { d: bad });
      assert.equal(r.errors![0].extensions.code, "BAD_USER_INPUT", `dataB64=${JSON.stringify(bad)}`);
    }
    assert.equal(got.input.length, 1);
    assert.equal(got.size.length, 1);
  } finally {
    await t.close();
  }
});

test("terminalInput / terminalResize: 未登録の session は NOT_FOUND、実行中でなければ OPERATION_FAILED", async () => {
  const t = await boot();
  try {
    const none = await t.call(`mutation{ terminalInput(session:"zz", dataB64:"YQ==") }`);
    assert.equal(none.errors![0].extensions.code, "NOT_FOUND");
    t.core.register("idle"); // 登録だけ（wrapper が居ない）
    const inp = await t.call(`mutation{ terminalInput(session:"idle", dataB64:"YQ==") }`);
    assert.equal(inp.errors![0].extensions.code, "OPERATION_FAILED");
    assert.match(inp.errors![0].message, /実行中でない/);
    const rs = await t.call(`mutation{ terminalResize(session:"idle", cols:80, rows:24) }`);
    assert.equal(rs.errors![0].extensions.code, "OPERATION_FAILED");
  } finally {
    await t.close();
  }
});

test("attachToSession: 画像を <workspace>/<session>/attachments/ に保存し、path と bytes を返す", async () => {
  const ws = await mkdtemp(join(tmpdir(), "gqlatt-"));
  const t = await boot({}, ws);
  try {
    t.core.register("a");
    const r = await t.call(`mutation($d:String!){ attachToSession(session:"a", type:"image/png", dataB64:$d){ path bytes } }`, { d: PNG.toString("base64") });
    assert.equal(r.errors, undefined);
    assert.equal(r.data!.attachToSession.bytes, PNG.length);
    const path = r.data!.attachToSession.path as string;
    assert.ok(path.startsWith(join(ws, "a", "attachments") + "/"), path);
    assert.ok(path.endsWith(".png"));
    assert.deepEqual(await readFile(path), PNG);
  } finally {
    await t.close();
    await rm(ws, { recursive: true, force: true });
  }
});

test("attachToSession: 型・中身・大きさ・空・未登録・workspace 無しを断り、何も保存しない", async () => {
  const ws = await mkdtemp(join(tmpdir(), "gqlatt-"));
  const t = await boot({}, ws);
  const q = `mutation($t:String!,$d:String!,$s:String! = "a"){ attachToSession(session:$s, type:$t, dataB64:$d){ path } }`;
  try {
    t.core.register("a");
    const png = PNG.toString("base64");
    const bad = async (vars: Record<string, unknown>, code: string, re: RegExp) => {
      const r = await t.call(q, vars);
      assert.equal(r.errors![0].extensions.code, code, JSON.stringify(r.errors));
      assert.match(r.errors![0].message, re);
    };
    await bad({ t: "image/svg+xml", d: png }, "BAD_USER_INPUT", /未対応の型/);
    await bad({ t: "image/jpeg", d: png }, "BAD_USER_INPUT", /画像でない/);
    await bad({ t: "image/png", d: "" }, "BAD_USER_INPUT", /本文が空/);
    await bad({ t: "image/png", d: "!!" }, "BAD_USER_INPUT", /base64/);
    await bad({ t: "image/png", d: png, s: "zz" }, "NOT_FOUND", /未定義の session/);
    // 保存は無い
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(ws), []);
  } finally {
    await t.close();
    await rm(ws, { recursive: true, force: true });
  }
  const t2 = await boot();
  try {
    t2.core.register("a");
    const r = await t2.call(q, { t: "image/png", d: PNG.toString("base64") });
    assert.match(r.errors![0].message, /workspace が無い/);
  } finally {
    await t2.close();
  }
});

test("attachToSession: 20MB を超える bytes は resolver が断る（yoga の body 上限 25MB は base64 で 18.7MB 相当なので HTTP では先に 413 になる）", async () => {
  const ws = await mkdtemp(join(tmpdir(), "gqlatt-"));
  try {
    const core = createCore();
    core.register("a");
    const ctx = { services: { core, workspace: ws, log: () => {} } } as unknown as GraphqlContext;
    const call = (dataB64: string) => mutationResolvers.attachToSession({}, { session: "a", type: "image/png", dataB64 }, ctx) as Promise<unknown>;
    await assert.rejects(call(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 1).toString("base64")), /20MB まで/);
    // ちょうど 20MB は大きさでは断られない（中身が画像でないので別の理由）
    await assert.rejects(call(Buffer.alloc(MAX_ATTACHMENT_BYTES, 1).toString("base64")), /画像でない/);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});
