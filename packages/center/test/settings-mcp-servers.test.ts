// 追加の MCP の server（設定の mcpServers）と外部記憶（設定の memory）を、普通の MCP の設定の形（Claude Code の mcp.json）で
// center を起動した所から書き、session の起動の --mcp-config に載せるまで（設定の保存・読み直し・起動・起動元の判定・移行）。
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { request } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseConfig, type Config } from "../src/config.js";
import { createCore } from "../src/core.js";
import { startHttpServer } from "../src/http.js";
import { LAUNCHER_HEADER, LAUNCHER_KEY_ENV, launcherMatches, takeLauncherKey } from "../src/launcher.js";
import { createMcpSource } from "../src/mcp-source.js";
import { buildSessionMcp } from "../src/mcp-session.js";
import { createMemoryFile } from "../src/memory-settings.js";
import { CENTER_ONLY_MCP_ERROR, type ProjectSettings } from "../src/project-settings.js";
import { createRemoteControlSupervisor, type ChildLike, type RemoteControlSupervisor } from "../src/remote-control.js";
import type { RemoteManager } from "../src/remotes.js";
import { createCenterServer } from "../src/server.js";
import type { ServerLink } from "../src/server-link.js";
import { createSessionTokens } from "../src/session-auth.js";
import { createSessionManager, type SavedSession, type SessionManager } from "../src/sessions.js";
import { createJsonListStore, createJsonObjectStore } from "../src/store.js";

class FakeChild extends EventEmitter implements ChildLike {
  pid = 3000 + Math.floor(Math.random() * 1000);
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin: Writable = new Writable({
    write: (chunk, _enc, cb) => {
      for (const line of String(chunk).split("\n").filter(Boolean)) {
        if ((JSON.parse(line) as { t?: string }).t === "stop") setImmediate(() => this.finish());
      }
      cb();
    },
  });
  kill(): boolean {
    setImmediate(() => this.finish());
    return true;
  }
  finish(): void {
    this.stdout.write(`${JSON.stringify({ t: "exit", code: 0, signal: null })}\n`);
    this.emit("exit", 0, null);
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit("close"));
  }
}

let dir: string;
let config: Config;
let launches: { args: string[]; env: NodeJS.ProcessEnv }[];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "center-smcp-"));
  config = parseConfig({ workspace: join(dir, "ws"), remoteControl: { claude: "fake-claude", restartDelayMs: 30, maxRestarts: 0, stopGraceMs: 100 }, logDir: join(dir, "logs") }, join(dir, "c.json"));
  launches = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const MCP_URL = "http://127.0.0.1:4567/mcp/session";
const readJson = async (f: string): Promise<any> => JSON.parse(await readFile(join(dir, f), "utf8"));
const valueOf = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
};
const mcpOf = (args: string[]) => JSON.parse(valueOf(args, "--mcp-config")!).mcpServers as Record<string, Record<string, any>>;
/** --mcp-config の ${VAR} を launch の env で展開する（claude が起動時にする展開と同じ）。 */
const expand = <T>(v: T, env: NodeJS.ProcessEnv): T =>
  JSON.parse(JSON.stringify(v).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, n: string) => (env[n] !== undefined ? JSON.stringify(env[n]).slice(1, -1) : m)));

/** daemon.ts と同じ配線（設定 file・mcpSource・memoryOf・mcpOf）で、本物の supervisor と SessionManager を作る。 */
function boot(extra: { memoryFile?: ReturnType<typeof createMemoryFile> } = {}): { sup: RemoteControlSupervisor; mgr: SessionManager; logs: string[] } {
  const logs: string[] = [];
  const log = (m: string) => void logs.push(m);
  const source = createMcpSource(join(dir, "center-settings.json"), join(dir, "sessions.json"), log);
  // eslint-disable-next-line prefer-const
  let mgr: SessionManager;
  const sup = createRemoteControlSupervisor({
    config,
    log,
    spawnImpl: (_cmd, args, o) => {
      launches.push({ args, env: o.env });
      return new FakeChild();
    },
    memoryOf: (name) => mgr.memoryOf(name),
    mcpOf: (name) => buildSessionMcp(mgr.mcpConnections().data, { get: () => undefined }, name, { port: 7911 }),
    wrapper: { core: createCore(), tokens: createSessionTokens(), path: "/fake/bantou-pty-wrapper", mcpUrl: () => MCP_URL, statusLineSelf: ["/fake/bantou-center"] },
  });
  mgr = createSessionManager({
    config,
    supervisor: sup,
    store: createJsonListStore<SavedSession>(join(dir, "sessions.json"), log),
    centerStore: createJsonObjectStore<ProjectSettings>(join(dir, "center-settings.json"), log),
    mcpSource: source,
    ...(extra.memoryFile ? { memoryFile: extra.memoryFile } : {}),
    log,
    waitMs: 0,
  });
  return { sup, mgr, logs };
}

const STDIO = { command: "npx", args: ["-y", "@example/tools-mcp"], env: { TOOLS_KEY: "STDIO-ENV-VALUE" } };
const HTTP = { type: "http", url: "https://tools.example/mcp", headers: { Authorization: "Bearer HTTP-BEARER-VALUE", "X-Team": "t1" } };
const MEMORY = { type: "http", url: "https://memory.example/mcp", headers: { Authorization: "Bearer MEMORY-BEARER-VALUE" } };
const COORD = { type: "http", url: "http://127.0.0.1:7911/mcp", headers: { Authorization: "Bearer COORD-KEY-0123456789" } };

test("mcpServers: stdio と Bearer 付き http を共通と session ごとに保存でき、読み直し（restore）でも残る。起動の --mcp-config に書いた形のまま載り、header・env の値は ${BANTOU_MCP_SECRET_n} の参照で子の env だけに渡る", async () => {
  const { sup, mgr } = boot();
  await mgr.restore();
  await mgr.updateCenterSettings({ mcpServers: { tools: STDIO } } as never);
  await mgr.create({ name: "pm1", settings: { mcpServers: { web: HTTP } } as never, start: false });
  await mgr.create({ name: "pm2", start: false });
  assert.deepEqual(mgr.getCenterSettings().settings, { mcpServers: { tools: STDIO } });
  assert.deepEqual(mgr.getSettings("pm1").settings, { mcpServers: { web: HTTP } });
  assert.deepEqual((await readJson("center-settings.json")).mcpServers, { tools: STDIO });
  assert.deepEqual((await readJson("sessions.json"))[0].settings.mcpServers, { web: HTTP });
  await sup.start("pm1");
  await sup.start("pm2");
  const [l1, l2] = launches;
  const m1 = mcpOf(l1!.args);
  // 共通 + session ごと。書いた項目はそのまま（値だけ参照）
  assert.deepEqual(expand(m1.tools, l1!.env), STDIO);
  assert.deepEqual(expand(m1.web, l1!.env), HTTP);
  assert.match(m1.tools!.env.TOOLS_KEY, /^\$\{BANTOU_MCP_SECRET_\d+\}$/);
  assert.match(m1.web!.headers.Authorization, /^\$\{BANTOU_MCP_SECRET_\d+\}$/);
  assert.deepEqual(Object.values(l1!.env).filter((v) => v === "Bearer HTTP-BEARER-VALUE"), ["Bearer HTTP-BEARER-VALUE"]);
  // 値は argv（ps に出る）に出ない
  for (const v of ["STDIO-ENV-VALUE", "HTTP-BEARER-VALUE"]) assert.ok(!JSON.stringify(l1!.args).includes(v), v);
  // 他の session には session ごとの server は載らない
  const m2 = mcpOf(l2!.args);
  assert.ok(m2.tools && !m2.web);
  assert.ok(!Object.values(l2!.env).includes("Bearer HTTP-BEARER-VALUE"), "割り当てていない session の子に値は渡らない");
  // 道具の許可
  const perms = JSON.parse(valueOf(l1!.args, "--settings")!).permissions.allow as string[];
  assert.ok(perms.includes("mcp__tools__*") && perms.includes("mcp__web__*"));
  await sup.shutdown();
  // 開き直す（center の再起動 = 読み直し）と残る
  launches = [];
  const b = boot();
  await b.mgr.restore();
  assert.deepEqual(b.mgr.getCenterSettings().settings, { mcpServers: { tools: STDIO } });
  assert.deepEqual(b.mgr.getSettings("pm1").settings, { mcpServers: { web: HTTP } });
  const lb = launches.find((l) => valueOf(l.args, "--remote-control") === "pm1-cap")!;
  assert.deepEqual(expand(mcpOf(lb.args).web, lb.env), HTTP);
  await b.sup.shutdown();
});

test("mcpServers: session の同じ名前は共通を丸ごと置き換える（stdio と http を混ぜない）。null で共通の server をその session では外す。統括の MCP の server の 1 項目も同じ欄で書ける", async () => {
  const { sup, mgr } = boot();
  await mgr.restore();
  await mgr.updateCenterSettings({ mcpServers: { tools: STDIO, other: { command: "other-mcp" } } } as never);
  await mgr.create({ name: "pm1", settings: { mcpServers: { tools: HTTP, other: null, "bantou-coordinator": COORD } } as never, start: false });
  await sup.start("pm1");
  const l = launches[0]!;
  const m = mcpOf(l.args);
  assert.deepEqual(expand(m.tools, l.env), HTTP, "共通の stdio の項目（command・args・env）は残らない");
  assert.equal(m.other, undefined);
  assert.equal(m["bantou-coordinator"]!.url, "http://127.0.0.1:7911/mcp");
  await sup.shutdown();
});

test("memory: 外部記憶の欄で Bearer を設定でき（共通・session）、session の起動の --mcp-config の memory に載る（Authorization は参照、X-Agent-Id は session 名）。argv に値は出ない", async () => {
  const { sup, mgr } = boot();
  await mgr.restore();
  await mgr.create({ name: "pm1", start: false });
  await mgr.create({ name: "pm2", start: false });
  await mgr.updateCenterSettings({ memory: MEMORY } as never);
  const own = { type: "http", url: "https://own-memory.example/mcp", headers: { Authorization: "Bearer OWN-MEMORY-VALUE" } };
  await mgr.updateSettings("pm2", { memory: own } as never);
  assert.deepEqual(mgr.getCenterSettings().settings, { memory: MEMORY });
  assert.deepEqual((await readJson("center-settings.json")).memory, MEMORY);
  await sup.start("pm1");
  await sup.start("pm2");
  const [l1, l2] = launches;
  const mem1 = mcpOf(l1!.args).memory!;
  assert.match(mem1.headers.Authorization, /^\$\{BANTOU_MEMORY_SECRET_\d+\}$/);
  assert.deepEqual(expand(mem1, l1!.env), { ...MEMORY, headers: { ...MEMORY.headers, "X-Agent-Id": "pm1" } });
  assert.ok(Object.values(l1!.env).includes("Bearer MEMORY-BEARER-VALUE"));
  assert.ok(!JSON.stringify(l1!.args).includes("MEMORY-BEARER-VALUE"));
  // session の値があれば共通は使わない
  assert.deepEqual(expand(mcpOf(l2!.args).memory, l2!.env), { ...own, headers: { ...own.headers, "X-Agent-Id": "pm2" } });
  assert.ok(!Object.values(l2!.env).includes("Bearer MEMORY-BEARER-VALUE"));
  // memory の道具の許可と指示文の部品
  assert.ok((JSON.parse(valueOf(l1!.args, "--settings")!).permissions.allow as string[]).includes("mcp__memory__*"));
  await sup.shutdown();
});

test("既存の値を書き換えて 1 回で保存できる: 更新 1 回で新しい値が保存され読みに返る。間に設定 file を直接書き換えても、更新は file の古い値で巻き戻らない", async () => {
  const { mgr } = boot();
  await mgr.restore();
  await mgr.create({ name: "pm1", settings: { mcpServers: { web: HTTP }, memory: MEMORY } as never, start: false });
  await mgr.updateCenterSettings({ mcpServers: { tools: STDIO } } as never);
  // 画面で JSON を書き換えて保存（1 回）
  const HTTP2 = { ...HTTP, headers: { Authorization: "Bearer HTTP-BEARER-NEW" } };
  const MEM2 = { ...MEMORY, url: "https://memory2.example/mcp" };
  const r = await mgr.updateSettings("pm1", { mcpServers: { web: HTTP2 }, memory: MEM2 } as never);
  assert.deepEqual(r.settings, { mcpServers: { web: HTTP2 }, memory: MEM2 });
  assert.deepEqual(mgr.getSettings("pm1").settings, { mcpServers: { web: HTTP2 }, memory: MEM2 });
  assert.deepEqual((await readJson("sessions.json"))[0].settings, { mcpServers: { web: HTTP2 }, memory: MEM2 });
  const STDIO2 = { ...STDIO, args: ["-y", "@example/tools-mcp@2"] };
  assert.deepEqual((await mgr.updateCenterSettings({ mcpServers: { tools: STDIO2 } } as never)).settings, { mcpServers: { tools: STDIO2 } });
  assert.deepEqual((await readJson("center-settings.json")).mcpServers, { tools: STDIO2 });
  // 運用者が file を直接書き換えた後でも、画面の更新 1 回が勝つ（他の項目の file の値は取り込む）
  const list = await readJson("sessions.json");
  list[0].settings = { mcpServers: { web: HTTP, extra: { command: "extra-mcp" } }, memory: MEMORY, instructions: "from-file" };
  await writeFile(join(dir, "sessions.json"), JSON.stringify(list));
  await writeFile(join(dir, "center-settings.json"), JSON.stringify({ mcpServers: { tools: STDIO }, memory: MEMORY }));
  const HTTP3 = { ...HTTP, url: "https://tools3.example/mcp" };
  await mgr.updateSettings("pm1", { mcpServers: { web: HTTP3 } } as never);
  const after = (await readJson("sessions.json"))[0].settings;
  assert.deepEqual(after.mcpServers, { web: HTTP3 }, "更新した値（file の古い値に戻らない）");
  assert.deepEqual(after.memory, MEMORY, "更新していない項目は file の値（運用者の書き換え）");
  await mgr.updateCenterSettings({ memory: MEM2 } as never);
  assert.deepEqual(await readJson("center-settings.json"), { mcpServers: { tools: STDIO }, memory: MEM2 });
});

test("旧 memory の設定が移る: memory-settings.json（共通・session）と旧形式の settings.memory は restore で普通の MCP の設定の形になり、起動の --mcp-config に Bearer が載る。file は .migrated。2 回目は何も変わらない", async () => {
  await writeFile(join(dir, "center-settings.json"), JSON.stringify({ instructions: "ic" }));
  await writeFile(
    join(dir, "sessions.json"),
    JSON.stringify([
      { name: "pm1", path: join(dir, "p1"), permissionMode: "auto", createdAt: "2026-01-01T00:00:00Z" },
      { name: "pm2", path: join(dir, "p2"), permissionMode: "auto", settings: { memory: { url: "https://legacy2.example/mcp", token: "LEGACY2-TOKEN", agentId: "ag2" } }, createdAt: "2026-01-01T00:00:00Z" },
    ]),
  );
  const memoryFile = createMemoryFile(dir);
  memoryFile.write({ common: { url: "https://legacy.example/mcp", token: "LEGACY-TOKEN", agentId: "shared" }, sessions: { pm1: { url: "https://legacy1.example/mcp", token: "LEGACY1-TOKEN" } } });
  const { sup, mgr, logs } = boot({ memoryFile });
  await mgr.restore();
  assert.deepEqual((await readJson("center-settings.json")).memory, { type: "http", url: "https://legacy.example/mcp", headers: { Authorization: "Bearer LEGACY-TOKEN", "X-Agent-Id": "shared" } });
  const s = await readJson("sessions.json");
  assert.deepEqual(s[0].settings.memory, { type: "http", url: "https://legacy1.example/mcp", headers: { Authorization: "Bearer LEGACY1-TOKEN" } });
  assert.deepEqual(s[1].settings.memory, { type: "http", url: "https://legacy2.example/mcp", headers: { Authorization: "Bearer LEGACY2-TOKEN", "X-Agent-Id": "ag2" } });
  assert.ok(!existsSync(memoryFile.path) && existsSync(`${memoryFile.path}.migrated`));
  for (const l of logs) assert.ok(!/TOKEN/.test(l), l);
  // restore が起動した session の --mcp-config に載る
  await new Promise((r) => setTimeout(r, 50));
  const l1 = launches.find((l) => valueOf(l.args, "--remote-control") === "pm1-cap")!;
  assert.deepEqual(expand(mcpOf(l1.args).memory, l1.env), { type: "http", url: "https://legacy1.example/mcp", headers: { Authorization: "Bearer LEGACY1-TOKEN", "X-Agent-Id": "pm1" } });
  assert.ok(!JSON.stringify(l1.args).includes("LEGACY1-TOKEN"));
  await sup.shutdown();
  // 2 回目: 何も変わらない
  const before = { s: await readFile(join(dir, "sessions.json"), "utf8"), c: await readFile(join(dir, "center-settings.json"), "utf8") };
  const b = boot({ memoryFile: createMemoryFile(dir) });
  await b.mgr.restore();
  assert.equal(await readFile(join(dir, "sessions.json"), "utf8"), before.s);
  assert.equal(await readFile(join(dir, "center-settings.json"), "utf8"), before.c);
  await b.sup.shutdown();
});

// ---- 起動元の判定（tools・http） ----

const fakeLink = { list: async () => [], close: async () => {} } as unknown as ServerLink;
const fakeRemotes = { scopeOf: () => ({ servers: undefined, out_of_scope: 0 }), list: () => [] } as unknown as RemoteManager;
const text = (r: unknown): string => (r as { content: { text: string }[] }).content[0]!.text;

async function toolsClient(mgr: SessionManager, sup: RemoteControlSupervisor, launcher: boolean) {
  const server = createCenterServer({ config, supervisor: sup, link: fakeLink, sessions: mgr, remotes: fakeRemotes, launcher });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

test("tools: 起動元は MCP の経路で mcpServers・memory を書けて読める（本物の SessionManager）。起動元でない呼び出し元は断られ（設定は変わらない）、読みにも出ない", async () => {
  const { sup, mgr } = boot();
  await mgr.restore();
  await mgr.create({ name: "pm1", start: false });
  const owner = await toolsClient(mgr, sup, true);
  const other = await toolsClient(mgr, sup, false);
  const u = await owner.callTool({ name: "session_settings_update", arguments: { name: "pm1", settings: { mcpServers: { web: HTTP }, memory: MEMORY } } });
  assert.notEqual(u.isError, true, text(u));
  const c = await owner.callTool({ name: "center_settings_update", arguments: { settings: { mcpServers: { tools: STDIO } } } });
  assert.deepEqual(JSON.parse(text(c)), { settings: { mcpServers: { tools: STDIO } }, launcher: true });
  assert.deepEqual(JSON.parse(text(await owner.callTool({ name: "session_settings_get", arguments: { name: "pm1" } }))).settings, { mcpServers: { web: HTTP }, memory: MEMORY });
  // 起動元でない
  for (const [tool, args] of [
    ["session_settings_update", { name: "pm1", settings: { memory: null } }],
    ["session_settings_update", { name: "pm1", settings: { mcpServers: { web: null } } }],
    ["center_settings_update", { settings: { mcpServers: null } }],
    ["session_create", { name: "pm9", settings: { memory: MEMORY } }],
  ] as const) {
    const r = await other.callTool({ name: tool, arguments: args });
    assert.equal(r.isError, true, tool);
    assert.equal(JSON.parse(text(r)).error, CENTER_ONLY_MCP_ERROR);
  }
  const g = text(await other.callTool({ name: "session_settings_get", arguments: { name: "pm1" } }));
  assert.deepEqual(JSON.parse(g), { name: "pm1", settings: {} });
  assert.deepEqual(JSON.parse(text(await other.callTool({ name: "center_settings_get", arguments: {} }))), { settings: {}, launcher: false });
  assert.ok(!g.includes("BEARER"));
  // 起動元でない呼び出し元の他項目の更新は、memory・mcpServers を消さない
  await other.callTool({ name: "session_settings_update", arguments: { name: "pm1", settings: { instructions: "x" } } });
  assert.deepEqual(mgr.getSettings("pm1").settings, { mcpServers: { web: HTTP }, memory: MEMORY, instructions: "x" });
  assert.equal(mgr.list().some((s) => s.name === "pm9"), false);
  await owner.close();
  await other.close();
  await sup.shutdown();
});

const TOKEN = "test-token-0123456789";
const KEY = "launcher-key-0123456789abcdef";

test("http: /mcp の initialize に起動元の鍵（x-bantou-launcher）が一致すれば起動元（center_info の launcher: true）。鍵が無い・違う・短い鍵の center では起動元でない。起動元の MCP session id を鍵無しで使うと 404（逆も）", async () => {
  const { sup, mgr } = boot();
  await mgr.restore();
  const h = await startHttpServer({
    createServer: (launcher) => createCenterServer({ config, supervisor: sup, link: fakeLink, sessions: mgr, remotes: fakeRemotes, launcher: launcher === true }),
    launcherKey: KEY,
    port: 0,
    bind: "127.0.0.1",
    token: TOKEN,
    log: () => {},
  });
  const url = new URL(`http://127.0.0.1:${h.port}/mcp`);
  const connect = async (headers: Record<string, string>) => {
    const c = new Client({ name: "t", version: "0" });
    const tr = new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${TOKEN}`, ...headers } } });
    await c.connect(tr);
    return { c, tr };
  };
  const launcherOf = async (c: Client) => JSON.parse(text(await c.callTool({ name: "center_info", arguments: {} }))).launcher as boolean;
  try {
    const own = await connect({ [LAUNCHER_HEADER]: KEY });
    const none = await connect({});
    const wrong = await connect({ [LAUNCHER_HEADER]: "launcher-key-WRONG-456789abcdef" });
    assert.equal(await launcherOf(own.c), true);
    assert.equal(await launcherOf(none.c), false);
    assert.equal(await launcherOf(wrong.c), false);
    const r = await none.c.callTool({ name: "center_settings_update", arguments: { settings: { mcpServers: { tools: STDIO } } } });
    assert.equal(r.isError, true);
    const ok = await own.c.callTool({ name: "center_settings_update", arguments: { settings: { mcpServers: { tools: STDIO } } } });
    assert.notEqual(ok.isError, true, text(ok));
    // session id の流用: 起動元の session を鍵無しで、鍵無しの session を鍵付きで使うと 404
    const raw = (sid: string, headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} });
        const req = request(url, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18", ...headers } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end(body);
      });
    assert.equal(await raw(own.tr.sessionId!, {}), 404);
    assert.equal(await raw(none.tr.sessionId!, { [LAUNCHER_HEADER]: KEY }), 404);
    assert.equal(await raw(own.tr.sessionId!, { [LAUNCHER_HEADER]: KEY }), 200);
    await Promise.all([own.c.close(), none.c.close(), wrong.c.close()]);
  } finally {
    await h.close();
    await sup.shutdown();
  }
  // 鍵の比較: 無い・短い鍵は常に一致しない
  assert.equal(launcherMatches(KEY, undefined), false);
  assert.equal(launcherMatches("short", "short"), false);
  assert.equal(launcherMatches(undefined, KEY), false);
  assert.equal(launcherMatches([KEY], KEY), true);
});

test("起動元の鍵（BANTOU_CENTER_LAUNCHER_KEY）は session の子 process の env に渡さない", async () => {
  const prev = process.env[LAUNCHER_KEY_ENV];
  process.env[LAUNCHER_KEY_ENV] = KEY;
  try {
    const { sup, mgr } = boot();
    await mgr.restore();
    await mgr.create({ name: "pm1" });
    assert.ok(launches.length >= 1);
    for (const l of launches) assert.equal(l.env[LAUNCHER_KEY_ENV], undefined);
    await sup.shutdown();
  } finally {
    if (prev === undefined) delete process.env[LAUNCHER_KEY_ENV];
    else process.env[LAUNCHER_KEY_ENV] = prev;
  }
});

test("起動元の鍵: center の起動の最初に env から取り出して消す（login shell・claude の解決などの子 process に渡さない）", () => {
  const env: NodeJS.ProcessEnv = { [LAUNCHER_KEY_ENV]: "k".repeat(32), OTHER: "x" };
  assert.equal(takeLauncherKey(env), "k".repeat(32));
  assert.equal(env[LAUNCHER_KEY_ENV], undefined);
  assert.equal(env.OTHER, "x");
  assert.equal(takeLauncherKey(env), undefined);
  // daemon.ts: 子 process を起こす最初の呼び出し（PATH の解決・claude の解決）より前に取り出している
  const src = readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("export async function runDaemon"));
  const take = body.indexOf("takeLauncherKey()");
  assert.ok(take > 0, "runDaemon が takeLauncherKey を呼ぶ");
  for (const first of ["resolveSessionPath(", "resolveClaude(", "loadConfig("]) assert.ok(take < body.indexOf(first), `${first} より前`);
  assert.ok(!/process\.env\[LAUNCHER_KEY_ENV\]/.test(src), "後から env を読み直さない");
});
