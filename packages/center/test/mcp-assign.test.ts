import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { runMcpCli } from "../src/mcp-cli.js";
import { createConnectionsStore, parseConnections, validateAll, type ConnectionsData } from "../src/mcp-connections.js";
import { createSecretsStore } from "../src/mcp-secrets.js";
import { assignBuiltin, buildSessionMcp, centerBaseOf, isAssigned } from "../src/mcp-session.js";
import { assertCenterOnly } from "../src/project-settings.js";

const SECRET = "SeCr3t-Value_9f8e7d6c5b4a3210";
let dir: string;
let config: string;
const transcript: string[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "center-assign-"));
  config = join(dir, "state", "center.json");
  transcript.length = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const run = async (argv: string[], stdin = "") => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMcpCli([argv[0], ...argv.slice(1), "--config", config], "/nonexistent/default.json", {
    readStdin: () => stdin,
    readFile: () => {
      throw new Error("ENOENT");
    },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  transcript.push(...out, ...err);
  return { code, out: out.join("\n"), err: err.join("\n") };
};
const stateDir = (): string => join(dir, "state");
const load = (): ConnectionsData => createConnectionsStore(stateDir()).read();
const secrets = (): ReturnType<typeof createSecretsStore> => createSecretsStore(stateDir());
const BASE = "http://127.0.0.1:4567";

test("割り当て: CLI の set --builtin で session ごとに割り当てる。割り当てた session だけ true。--session 無し・別の名前・他の項目と同時は断る", async () => {
  assert.equal((await run(["set", "bantou-coordinator", "--session", "main", "--builtin", "coordinator"])).code, 0);
  assert.equal(isAssigned(load(), "main", "coordinator"), true);
  assert.equal(isAssigned(load(), "other", "coordinator"), false);
  assert.equal((await run(["set", "bantou-coordinator", "--builtin", "coordinator"])).code, 2, "全 session には割り当てない");
  assert.equal((await run(["set", "coord", "--session", "x", "--builtin", "coordinator"])).code, 2, "名前は固定");
  assert.equal((await run(["set", "bantou-coordinator", "--session", "x", "--builtin", "coordinator", "--url", "https://a.example/mcp"])).code, 2);
  assert.equal((await run(["set", "bantou-coordinator", "--session", "x", "--builtin", "nope"])).code, 2);
  assert.equal(isAssigned(load(), "x", "coordinator"), false);
  // list / get に出る。mcp test は組み込みを試さない
  assert.match((await run(["list", "--session", "main"])).out, /bantou-coordinator: 組み込み/);
  assert.match((await run(["get", "bantou-coordinator", "--session", "main"])).out, /組み込み/);
  assert.equal((await run(["test", "bantou-coordinator", "--session", "main"])).code, 2);
  // 外す
  assert.equal((await run(["unset", "bantou-coordinator", "--session", "main"])).code, 0);
  assert.equal(isAssigned(load(), "main", "coordinator"), false);
  // --off（その session では付けない）も割り当て無し
  await run(["set", "bantou-coordinator", "--session", "main", "--builtin", "coordinator"]);
  await run(["set", "bantou-coordinator", "--session", "main", "--off"]);
  assert.equal(isAssigned(load(), "main", "coordinator"), false);
});

test("割り当ての判定: 名前が違えば効かない（共通・session とも）。壊れた file・不正な形は割り当て無し", () => {
  const coord = { transport: "builtin", builtin: "coordinator" } as const;
  assert.equal(isAssigned({ version: 1, common: { "bantou-coordinator": coord }, sessions: {} }, "any", "coordinator"), true, "共通の割り当ては全 session に効く（運用者が書いた時だけ。CLI は断る）");
  assert.equal(isAssigned({ version: 1, common: { coordinator: coord }, sessions: {} }, "any", "coordinator"), false);
  assert.equal(isAssigned(parseConnections({ garbage: 1 }).data, "main", "coordinator"), false);
  assert.equal(isAssigned(parseConnections({ version: 1, common: {}, sessions: { main: { "bantou-coordinator": { transport: "builtin", builtin: "other" } } } }).data, "main", "coordinator"), false);
  // http の接続を同名で置いても組み込みにはならない
  assert.equal(isAssigned({ version: 1, common: {}, sessions: { main: { "bantou-coordinator": { transport: "http", url: "https://a.example/mcp" } } } }, "main", "coordinator"), false);
  assert.ok(validateAll({ version: 1, common: {}, sessions: { main: { x: coord } } }).some((i) => /組み込みの接続の名前/.test(i.issue)));
});

test("assignBuiltin（旧設定の移行の書き込み）: 付ける・冪等・明示的に外した（null）物は戻さない", () => {
  const d: ConnectionsData = { version: 1, common: {}, sessions: {} };
  assert.equal(assignBuiltin(d, "main", "coordinator"), true);
  assert.equal(isAssigned(d, "main", "coordinator"), true);
  assert.equal(assignBuiltin(d, "main", "coordinator"), false);
  const off: ConnectionsData = { version: 1, common: {}, sessions: { main: { "bantou-coordinator": null } } };
  assert.equal(assignBuiltin(off, "main", "coordinator"), false);
  assert.equal(isAssigned(off, "main", "coordinator"), false);
});

test("--mcp-config: 共通は全 session・session ごとの追加はその session だけ。統括の口は割り当てた session だけ。mcp 設定の無い session は何も足さない", async () => {
  await run(["set", "tool1", "--url", "https://tools.example/mcp"]);
  await run(["set", "only-a", "--session", "a", "--url", "https://a.example/mcp"]);
  await run(["set", "bantou-coordinator", "--session", "a", "--builtin", "coordinator"]);
  const d = load();
  const names = (s: string) => buildSessionMcp(d, secrets(), s, BASE);
  assert.deepEqual(Object.keys(names("a").servers).sort(), ["bantou-coordinator", "only-a", "tool1"]);
  assert.deepEqual(Object.keys(names("b").servers), ["tool1"]);
  assert.deepEqual(names("a").builtins, ["coordinator"]);
  assert.deepEqual(names("b").builtins, []);
  assert.deepEqual((names("a").servers["bantou-coordinator"] as { url: string }).url, `${BASE}/mcp/coordinator`);
  // 共通の接続を session で付けない
  await run(["set", "tool1", "--session", "b", "--off"]);
  assert.deepEqual(Object.keys(buildSessionMcp(load(), secrets(), "b", BASE).servers), []);
  // center の窓口が無い（stdio）時は統括の口は載せない
  const noUrl = buildSessionMcp(d, secrets(), "a", centerBaseOf(null));
  assert.ok(!("bantou-coordinator" in noUrl.servers));
  assert.ok(noUrl.skipped.some((k) => k.name === "bantou-coordinator"));
});

test("鍵: 値は --mcp-config の中身・permissions・skipped・CLI の出力・状態 file（鍵の file 以外）に出ない。env にだけ入る。鍵が無い接続は載せない", async () => {
  await run(["set", "tool1", "--url", "https://tools.example/mcp", "--auth-header", "X-Api", "--auth-format", "Key {secret}", "--secret", "tool1key"]);
  const noKey = buildSessionMcp(load(), secrets(), "a", BASE);
  assert.deepEqual(Object.keys(noKey.servers), [], "鍵が無い接続は載せない");
  assert.deepEqual(noKey.skipped, [{ name: "tool1", reason: "鍵が無い" }]);
  assert.equal((await run(["secret", "set", "tool1key", "--stdin"], SECRET)).code, 0);
  const m = buildSessionMcp(load(), secrets(), "a", BASE);
  assert.deepEqual(m.env, { BANTOU_MCP_SECRET_0: SECRET });
  const visible = JSON.stringify({ servers: m.servers, allow: m.allow, deny: m.deny, skipped: m.skipped, attached: m.attached });
  assert.ok(!visible.includes(SECRET));
  assert.deepEqual((m.servers.tool1 as { headers: Record<string, string> }).headers, { "X-Api": "Key ${BANTOU_MCP_SECRET_0}" });
  for (const c of [["list"], ["list", "--session", "a"], ["get", "tool1"], ["secret", "list"]]) await run(c);
  for (const l of transcript) assert.ok(!l.includes(SECRET), `出力に鍵: ${l.slice(0, 40)}`);
  for (const f of await readdir(stateDir())) {
    if (f.startsWith("mcp-secrets.json")) continue;
    assert.ok(!(await readFile(join(stateDir(), f), "utf8")).includes(SECRET), `${f} に鍵`);
  }
  // session ごとの追加の接続も同じ（別の env 番号）
  await run(["set", "tool2", "--session", "a", "--url", "https://t2.example/mcp", "--secret", "tool1key", "--auth-header", "X-K", "--auth-format", "{secret}"]);
  const m2 = buildSessionMcp(load(), secrets(), "a", BASE);
  assert.deepEqual(Object.keys(m2.env).sort(), ["BANTOU_MCP_SECRET_0", "BANTOU_MCP_SECRET_1"]);
  assert.ok(!JSON.stringify(m2.servers).includes(SECRET));
  assert.deepEqual(Object.keys(buildSessionMcp(load(), secrets(), "b", BASE).env), ["BANTOU_MCP_SECRET_0"], "b には tool2 の鍵は渡らない");
});

test("center-only: 設定の更新の入力（画面・web・MCP の経路）は coordinator・mcp・mcpConnections・mcpSecrets を断る", () => {
  for (const k of ["coordinator", "mcp", "mcpConnections", "mcpSecrets", "memory"]) {
    assert.throws(() => assertCenterOnly({ [k]: { anything: 1 } }), /MCP からは変えられない/, k);
    assert.throws(() => assertCenterOnly({ [k]: null }), /MCP からは変えられない/, k);
  }
  assert.doesNotThrow(() => assertCenterOnly({ instructions: "x" }));
});

test("center-only: mcp-connections.json を書く module は mcp-cli.ts と daemon.ts（旧設定の移行）だけ。tools・http・sessions・server などの経路は接続の store を持たない", async () => {
  const src = join(import.meta.dirname, "..", "src");
  const writers: string[] = [];
  for (const f of await readdir(src)) {
    if (!f.endsWith(".ts")) continue;
    const t = await readFile(join(src, f), "utf8");
    if (/createConnectionsStore\(/.test(t) && !/^(mcp-cli|mcp-connections|daemon)\.ts$/.test(f)) writers.push(`${f}(store を作る)`);
    if (/\.file\.write\(|conns\.file\.write/.test(t) && !/^(mcp-cli|mcp-secrets|mcp-status|mcp-connections|daemon)\.ts$/.test(f)) writers.push(`${f}(書く)`);
  }
  assert.deepEqual(writers, []);
});

test("center-only: 設定の更新を試みても mcp-connections.json は作られない・変わらない（SessionManager 経由）", async () => {
  const { createSessionManager } = await import("../src/sessions.js");
  const { parseConfig } = await import("../src/config.js");
  const { createJsonListStore, createJsonObjectStore } = await import("../src/store.js");
  await run(["set", "tool1", "--url", "https://tools.example/mcp"]);
  const before = await readFile(join(stateDir(), "mcp-connections.json"), "utf8");
  const cfg = parseConfig({ workspace: join(dir, "ws"), projects: [] }, config);
  const mgr = createSessionManager({
    config: cfg,
    supervisor: { add() {}, remove: async () => {}, start: async () => ({}), status: () => ({}), list: () => [], setInstructions() {}, setAddDirs() {}, setOutputStyle() {}, setMemory() {} } as never,
    store: createJsonListStore(join(stateDir(), "sessions.json"), () => {}),
    centerStore: createJsonObjectStore(join(stateDir(), "center-settings.json"), () => {}),
    log: () => {},
    waitMs: 0,
  });
  await mgr.restore();
  for (const patch of [{ mcpConnections: { common: {} } }, { coordinator: { session: "x" } }, { mcp: {} }, { mcpSecrets: { k: "v" } }]) await assert.rejects(mgr.updateCenterSettings(patch as never), /MCP からは変えられない/);
  assert.equal(await readFile(join(stateDir(), "mcp-connections.json"), "utf8"), before);
  assert.deepEqual(mgr.getCenterSettings().settings, {});
  await writeFile(join(dir, "x"), "");
});
