import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { runMcpCli } from "../src/mcp-cli.js";
import { connectionsFromSettings, validateAll, validateAny, type ConnectionsData } from "../src/mcp-connections.js";
import { createSecretsStore } from "../src/mcp-secrets.js";
import { buildSessionMcp, centerBaseOf, isAssigned } from "../src/mcp-session.js";
import { assertCenterOnly } from "../src/project-settings.js";

const SECRET = "SeCr3t-Value_9f8e7d6c5b4a3210";
const COORD = { transport: "builtin", builtin: "coordinator" } as const;
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
const secrets = (): ReturnType<typeof createSecretsStore> => createSecretsStore(stateDir());
const BASE = "http://127.0.0.1:4567";
/** 普通の設定（center 共通の設定の mcpServers と、session の設定の mcpServers）から接続の一覧を作る。 */
const fromSettings = (common: unknown, sessions: Record<string, unknown>): ConnectionsData =>
  connectionsFromSettings(common === undefined ? undefined : { mcpServers: common }, Object.entries(sessions).map(([n, m]) => [n, { mcpServers: m }])).data;

test("割り当て: session の設定の mcpServers に bantou-coordinator を書いた session だけが割り当て済み。共通に書いても名前が違えば効かない", () => {
  const d = fromSettings({ shared: { transport: "http", url: "https://a.example/mcp" } }, { main: { "bantou-coordinator": COORD }, other: {} });
  assert.equal(isAssigned(d, "main", "coordinator"), true);
  assert.equal(isAssigned(d, "other", "coordinator"), false);
  assert.equal(isAssigned(d, "nobody", "coordinator"), false);
  assert.equal(isAssigned(fromSettings({ "bantou-coordinator": COORD }, {}), "any", "coordinator"), true, "共通に書けば全 session（運用者が書いた時だけ）");
  assert.equal(isAssigned(fromSettings({ coordinator: COORD }, {}), "any", "coordinator"), false);
  assert.equal(isAssigned(fromSettings({}, { main: { "bantou-coordinator": { transport: "builtin", builtin: "other" } } }), "main", "coordinator"), false);
  // 外す: session で null
  assert.equal(isAssigned(fromSettings({ "bantou-coordinator": COORD }, { main: { "bantou-coordinator": null } }), "main", "coordinator"), false);
  // mcpServers が壊れた形
  assert.equal(isAssigned(connectionsFromSettings({ mcpServers: "x" }, [["main", { mcpServers: [1] }]]).data, "main", "coordinator"), false);
});

test("予約名: bantou-coordinator の名前は組み込みだけ。http の接続を同じ名前で置いても割り当て・載せる対象にならず、検査で断る", () => {
  const http = { transport: "http", url: "https://a.example/mcp" };
  assert.equal(validateAny(http, "bantou-coordinator").ok, false);
  const d = fromSettings({}, { main: { "bantou-coordinator": http } });
  assert.equal(isAssigned(d, "main", "coordinator"), false);
  const m = buildSessionMcp(d, secrets(), "main", BASE);
  assert.deepEqual(Object.keys(m.servers), [], "http の同名は載せない（mcp__bantou-coordinator__* の許可を横取りさせない）");
  assert.ok(m.skipped.some((k) => k.name === "bantou-coordinator"));
  assert.ok(validateAll(d).some((i) => i.name === "bantou-coordinator"));
  assert.ok(validateAll(fromSettings({}, { main: { x: COORD } })).some((i) => /組み込みの接続の名前/.test(i.issue)));
});

test("--mcp-config: 共通の設定の接続は全 session・session の設定の接続はその session だけ。統括の口は割り当てた session だけ。何も無い session は何も足さない", () => {
  const d = fromSettings(
    { tool1: { transport: "http", url: "https://tools.example/mcp" } },
    { a: { "only-a": { transport: "http", url: "https://a.example/mcp" }, "bantou-coordinator": COORD }, b: { tool1: null } },
  );
  const m = (s: string) => buildSessionMcp(d, secrets(), s, BASE);
  assert.deepEqual(Object.keys(m("a").servers).sort(), ["bantou-coordinator", "only-a", "tool1"]);
  assert.deepEqual(Object.keys(m("c").servers), ["tool1"], "設定の無い session にも共通は載る");
  assert.deepEqual(Object.keys(m("b").servers), [], "session で外した共通の接続は載らない");
  assert.deepEqual(m("a").builtins, ["coordinator"]);
  assert.deepEqual(m("c").builtins, []);
  assert.equal((m("a").servers["bantou-coordinator"] as { url: string }).url, `${BASE}/mcp/coordinator`);
  assert.ok(m("a").allow.includes("mcp__bantou-coordinator__*"));
  assert.ok(!m("c").allow.includes("mcp__bantou-coordinator__*"));
  // center の窓口が無い（stdio）時は統括の口は載せない
  const noUrl = buildSessionMcp(d, secrets(), "a", centerBaseOf(null));
  assert.ok(!("bantou-coordinator" in noUrl.servers));
  assert.ok(noUrl.skipped.some((k) => k.name === "bantou-coordinator"));
});

test("鍵: auth.env の環境変数の値は --mcp-config・permissions・skipped に出ず、子の env にだけ入る。環境変数が無い接続は載せない。session の追加の鍵は他の session に渡らない", () => {
  const d = fromSettings(
    { tool1: { transport: "http", url: "https://tools.example/mcp", auth: { header: "X-Api", format: "Key {secret}", env: "BANTOU_MCP_KEY_TOOL1" } } },
    { a: { tool2: { transport: "http", url: "https://t2.example/mcp", auth: { env: "BANTOU_MCP_KEY_TOOL2" } } } },
  );
  const none = buildSessionMcp(d, secrets(), "a", BASE, {});
  assert.deepEqual(Object.keys(none.servers), []);
  assert.deepEqual(none.skipped.map((k) => k.reason), ["鍵の環境変数が無い", "鍵の環境変数が無い"]);
  const envs = { BANTOU_MCP_KEY_TOOL1: SECRET, BANTOU_MCP_KEY_TOOL2: `${SECRET}-2` };
  const m = buildSessionMcp(d, secrets(), "a", BASE, envs);
  assert.deepEqual(Object.values(m.env).sort(), [SECRET, `${SECRET}-2`].sort());
  const visible = JSON.stringify({ servers: m.servers, allow: m.allow, deny: m.deny, skipped: m.skipped, attached: m.attached, builtins: m.builtins });
  assert.ok(!visible.includes(SECRET));
  assert.deepEqual((m.servers.tool1 as { headers: Record<string, string> }).headers, { "X-Api": "Key ${BANTOU_MCP_SECRET_0}" });
  const b = buildSessionMcp(d, secrets(), "b", BASE, envs);
  assert.deepEqual(Object.values(b.env), [SECRET], "b には a の追加（tool2）の鍵は渡らない");
});

test("鍵: 設定に書ける環境変数名は BANTOU_MCP_KEY_ の接頭だけ（center 自身の token を外へ送らせない）。値は設定に書けない", () => {
  const base = { transport: "http", url: "https://t.example/mcp" };
  for (const env of ["BANTOU_SESSION_TOKEN", "BANTOU_MEMORY_TOKEN", "PATH", "bantou_mcp_key_x", "BANTOU_MCP_SECRET_0"]) assert.equal(validateAny({ ...base, auth: { env } }, "t").ok, false, env);
  assert.equal(validateAny({ ...base, auth: { env: "BANTOU_MCP_KEY_T" } }, "t").ok, true);
  assert.equal(validateAny({ ...base, auth: { env: "BANTOU_MCP_KEY_T", secret: "s" } }, "t").ok, false, "env と secret は同時に書けない");
  assert.equal(validateAny({ ...base, auth: { value: SECRET } }, "t").ok, false, "値のための欄は無い");
});

test("鍵: 旧来の鍵の file（mcp secret set）の接続も載る。値は --mcp-config・CLI の出力・状態 file（鍵の file 以外）に出ない", async () => {
  assert.equal((await run(["secret", "set", "tool1key", "--stdin"], SECRET)).code, 0);
  const d = fromSettings({ tool1: { transport: "http", url: "https://tools.example/mcp", auth: { secret: "tool1key" } } }, {});
  const m = buildSessionMcp(d, secrets(), "a", BASE, {});
  assert.deepEqual(m.env, { BANTOU_MCP_SECRET_0: SECRET });
  assert.ok(!JSON.stringify(m.servers).includes(SECRET));
  for (const c of [["list"], ["secret", "list"]]) await run(c);
  for (const l of transcript) assert.ok(!l.includes(SECRET), `出力に鍵: ${l.slice(0, 40)}`);
  for (const f of await readdir(stateDir())) {
    if (f.startsWith("mcp-secrets.json")) continue;
    assert.ok(!(await readFile(join(stateDir(), f), "utf8")).includes(SECRET), `${f} に鍵`);
  }
});

test("CLI: 組み込みの割り当ては CLI では書かない（旧設定の file も作らない）。普通の設定への案内を出す", async () => {
  const r = await run(["set", "bantou-coordinator", "--session", "main", "--builtin", "coordinator"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /mcpServers/);
  assert.equal((await run(["set", "bantou-coordinator", "--session", "main", "--url", "https://a.example/mcp"])).code, 2, "同名の http も書かない");
  assert.equal(existsSync(join(stateDir(), "mcp-connections.json")), false);
});

test("center-only: 設定の更新の入力は、起動元以外（別 host の desktop・web・他の呼び出し元）からは mcpServers・memory を断る。起動元は通す。旧設定の項目（coordinator・mcp・mcpConnections・mcpSecrets）は誰からも断る", () => {
  for (const k of ["mcpServers", "memory"]) {
    assert.throws(() => assertCenterOnly({ [k]: { anything: 1 } }), /center を起動した所/, k);
    assert.throws(() => assertCenterOnly({ [k]: null }), /center を起動した所/, k);
    assert.doesNotThrow(() => assertCenterOnly({ [k]: { anything: 1 } }, { launcher: true }), k);
  }
  for (const k of ["coordinator", "mcp", "mcpConnections", "mcpSecrets"]) {
    assert.throws(() => assertCenterOnly({ [k]: { anything: 1 } }), /center を起動した所/, k);
    assert.throws(() => assertCenterOnly({ [k]: null }, { launcher: true }), /旧設定の項目/, k);
  }
  assert.doesNotThrow(() => assertCenterOnly({ instructions: "x" }));
});

test("center-only: 設定の更新を受ける tool は必ず起動元の判定（assertCenterOnly(…, { launcher })）を通す。http・server・coordinator・core は mcpServers に触れない。mcp-connections.json を書くのは mcp-cli.ts だけ", async () => {
  const src = join(import.meta.dirname, "..", "src");
  const writers: string[] = [];
  for (const f of await readdir(src)) {
    if (!f.endsWith(".ts")) continue;
    const t = await readFile(join(src, f), "utf8");
    // wrapper.ts の mcpServers は claude の --mcp-config の形（center の設定ではない）。tools.ts は起動元の判定を通した更新だけが扱う（下で見る）
    if (/mcpServers/.test(t) && /^(http|server|coordinator|core)\.ts$/.test(f)) writers.push(`${f}(mcpServers を扱う)`);
    if (/createConnectionsStore\(/.test(t) && !/^(mcp-cli|mcp-connections|daemon)\.ts$/.test(f)) writers.push(`${f}(store を作る)`);
    if (/\.file\.write\(|conns\.file\.write/.test(t) && !/^(mcp-cli|mcp-secrets|mcp-status|mcp-connections)\.ts$/.test(f)) writers.push(`${f}(書く)`);
  }
  assert.deepEqual(writers, []);
  const tools = await readFile(join(src, "tools.ts"), "utf8");
  const calls = tools.match(/assertCenterOnly\([^)]*\)/g) ?? [];
  assert.equal(calls.length, 3, "session_create / session_settings_update / center_settings_update");
  for (const c of calls) assert.match(c, /\{ launcher \}/, c);
  // 読みの応答も起動元以外には memory・mcpServers を出さない
  assert.match(tools, /withoutLauncherKeys/);
});
