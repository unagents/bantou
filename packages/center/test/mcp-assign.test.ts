import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { runMcpCli } from "../src/mcp-cli.js";
import { connectionsFromSettings, validateAll, validateAny, type ConnectionsData } from "../src/mcp-connections.js";
import { createSecretsStore } from "../src/mcp-secrets.js";
import { buildSessionMcp } from "../src/mcp-session.js";
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
const secrets = (): ReturnType<typeof createSecretsStore> => createSecretsStore(stateDir());
/** 普通の設定（center 共通の設定の mcpServers と、session の設定の mcpServers）から接続の一覧を作る。 */
const fromSettings = (common: unknown, sessions: Record<string, unknown>): ConnectionsData =>
  connectionsFromSettings(common === undefined ? undefined : { mcpServers: common }, Object.entries(sessions).map(([n, m]) => [n, { mcpServers: m }])).data;

const CENTRY = { type: "http", url: "http://127.0.0.1:7911/mcp", headers: { Authorization: `Bearer ${SECRET}` } };
const COORD_AT = { port: 7911 };

test("統括の道具: 設定の mcpServers に統括の MCP の server の 1 項目（type: http・url・headers）を書いた session だけに出る。他の session・共通に書かなければ出ない", () => {
  const d = fromSettings({ shared: { type: "http", url: "https://a.example/mcp" } }, { main: { "bantou-coordinator": CENTRY }, other: {} });
  const m = (s: string) => buildSessionMcp(d, secrets(), s, COORD_AT);
  assert.equal(m("main").coordinator, true);
  assert.equal(m("other").coordinator, false);
  assert.equal(m("nobody").coordinator, false);
  // 名前は自由（url で見る）。別の port・別の host・外した（null）・centerの窓口が無い（null）なら出ない
  assert.equal(buildSessionMcp(fromSettings({}, { main: { anything: CENTRY } }), secrets(), "main", COORD_AT).coordinator, true);
  assert.equal(buildSessionMcp(d, secrets(), "main", { port: 7912 }).coordinator, false);
  assert.equal(buildSessionMcp(d, secrets(), "main", null).coordinator, false);
  assert.equal(buildSessionMcp(fromSettings({ "bantou-coordinator": CENTRY }, { main: { "bantou-coordinator": null } }), secrets(), "main", COORD_AT).coordinator, false);
  assert.equal(buildSessionMcp(fromSettings({ x: { type: "http", url: "http://example.com:7911/mcp" } }, {}), secrets(), "main", COORD_AT).coordinator, false);
  // 共通に書けば全 session（運用者が書いた時だけ）
  assert.equal(buildSessionMcp(fromSettings({ c: CENTRY }, {}), secrets(), "any", COORD_AT).coordinator, true);
});

test("--mcp-config: 統括の server の項目は普通の http の項目としてそのまま載る。Authorization の値は env の参照になり実値は子の env にだけ入る。許可は mcp__<名>__*", () => {
  const d = fromSettings(
    { tool1: { type: "http", url: "https://tools.example/mcp" } },
    { a: { "only-a": { type: "http", url: "https://a.example/mcp" }, "bantou-coordinator": CENTRY }, b: { tool1: null } },
  );
  const m = (s: string) => buildSessionMcp(d, secrets(), s, COORD_AT);
  assert.deepEqual(Object.keys(m("a").servers).sort(), ["bantou-coordinator", "only-a", "tool1"]);
  assert.deepEqual(Object.keys(m("c").servers), ["tool1"], "設定の無い session にも共通は載る");
  assert.deepEqual(Object.keys(m("b").servers), [], "session で外した共通の接続は載らない");
  const e = m("a").servers["bantou-coordinator"] as { type: string; url: string; headers: Record<string, string> };
  assert.equal(e.type, "http");
  assert.equal(e.url, CENTRY.url);
  assert.deepEqual(e.headers, { Authorization: "${BANTOU_MCP_SECRET_0}" });
  assert.ok(!JSON.stringify(m("a").servers).includes(SECRET));
  assert.ok(Object.values(m("a").env).includes(`Bearer ${SECRET}`));
  assert.ok(m("a").allow.includes("mcp__bantou-coordinator__*"));
  assert.ok(!m("c").allow.includes("mcp__bantou-coordinator__*"));
  assert.deepEqual(m("c").env, {});
});

test("独自の書き方は受けない: transport: builtin と auth.env は検査で断る（既存の設定は起動時に普通の書き方へ移る。sessions.test.ts の旧設定の移行）", () => {
  assert.equal(validateAny({ transport: "builtin", builtin: "coordinator" }, "bantou-coordinator").ok, false);
  const base = { transport: "http", url: "https://t.example/mcp" };
  assert.equal(validateAny({ ...base, auth: { env: "BANTOU_MCP_KEY_T" } }, "t").ok, false, "auth.env は無い");
  assert.equal(validateAny({ ...base, auth: { secret: "s" } }, "t").ok, true, "旧来の鍵の file の参照は旧設定の移行元として残る");
  assert.deepEqual(connectionsFromSettings(undefined, [["main", { mcpServers: { "bantou-coordinator": { transport: "builtin", builtin: "coordinator" } } }]]).problems.length > 0, true);
});

test("鍵: 旧来の鍵の file（mcp secret set）の接続も載る。値は --mcp-config・CLI の出力・状態 file（鍵の file 以外）に出ない", async () => {
  assert.equal((await run(["secret", "set", "tool1key", "--stdin"], SECRET)).code, 0);
  const d = fromSettings({ tool1: { transport: "http", url: "https://tools.example/mcp", auth: { secret: "tool1key" } } }, {});
  const m = buildSessionMcp(d, secrets(), "a", null);
  assert.deepEqual(m.env, { BANTOU_MCP_SECRET_0: SECRET });
  assert.ok(!JSON.stringify(m.servers).includes(SECRET));
  for (const c of [["list"], ["secret", "list"]]) await run(c);
  for (const l of transcript) assert.ok(!l.includes(SECRET), `出力に鍵: ${l.slice(0, 40)}`);
  for (const f of await readdir(stateDir())) {
    if (f.startsWith("mcp-secrets.json")) continue;
    assert.ok(!(await readFile(join(stateDir(), f), "utf8")).includes(SECRET), `${f} に鍵`);
  }
});

test("CLI: 統括の server の項目は CLI では書かない（--builtin は無い。旧設定の file も作らない）", async () => {
  assert.equal((await run(["set", "bantou-coordinator", "--session", "main", "--builtin", "coordinator"])).code, 2);
  assert.equal(existsSync(join(stateDir(), "mcp-connections.json")), false);
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

test("統括の道具: 統括の項目は利用者の書いた形（type・url・headers）のまま載る。center は header を足さない", () => {
  const d = fromSettings({}, { main: { "bantou-coordinator": CENTRY } });
  const e = buildSessionMcp(d, secrets(), "main", COORD_AT).servers["bantou-coordinator"] as { type: string; url: string; headers: Record<string, string> };
  assert.equal(e.type, "http");
  assert.equal(e.url, CENTRY.url);
  assert.deepEqual(Object.keys(e.headers), ["Authorization"]);
  assert.ok(!Object.keys(e.headers).some((k) => k.toLowerCase() === "x-bantou-session"));
});
