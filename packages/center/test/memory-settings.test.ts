import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createMemoryFile, displayUrl, runMemoryCli, MEMORY_SETTINGS_FILE } from "../src/memory-settings.js";

let dir: string;
let config: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "center-memcli-"));
  config = join(dir, "center.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const run = (argv: string[], stdin = "", files: Record<string, string> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = runMemoryCli(argv.length ? [argv[0], "--config", config, ...argv.slice(1)] : [], "/nonexistent/default.json", {
    readStdin: () => stdin,
    readFile: (p) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p];
    },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
};

const centerFile = () => join(dir, "center-settings.json");
const sessionsFile = () => join(dir, "sessions.json");
const readJson = async (p: string): Promise<any> => JSON.parse(await readFile(p, "utf8"));
const seedSessions = (names: string[]) =>
  writeFile(sessionsFile(), JSON.stringify(names.map((name) => ({ name, path: join(dir, name), permissionMode: "auto", settings: { instructions: `i-${name}` }, createdAt: "2026-01-01T00:00:00Z" }))));

test("set / get / unset（共通と session）: 普通の設定（center-settings.json / sessions.json の memory）に普通の MCP の設定の形で書く。token は標準入力から。他の項目は残す。mode 0600", async () => {
  await seedSessions(["a", "b"]);
  await writeFile(centerFile(), JSON.stringify({ instructions: "ic" }));
  const s1 = run(["set", "--url", "http://mem.local:3000/mcp?k=Q", "--agent-id", "shared", "--token-stdin"], "COMMON-SECRET\n");
  assert.equal(s1.code, 0, s1.err);
  const s2 = run(["set", "--session", "a", "--url", "https://own.example/mcp", "--token-stdin"], "OWN-SECRET");
  assert.equal(s2.code, 0, s2.err);
  const common = { type: "http", url: "http://mem.local:3000/mcp?k=Q", headers: { Authorization: "Bearer COMMON-SECRET", "X-Agent-Id": "shared" } };
  const own = { type: "http", url: "https://own.example/mcp", headers: { Authorization: "Bearer OWN-SECRET" } };
  assert.deepEqual(await readJson(centerFile()), { instructions: "ic", memory: common });
  const list = await readJson(sessionsFile());
  assert.deepEqual(list[0].settings, { instructions: "i-a", memory: own });
  assert.deepEqual(list[1].settings, { instructions: "i-b" }, "他の session は変えない");
  assert.equal((await stat(centerFile())).mode & 0o777, 0o600);
  assert.equal((await stat(sessionsFile())).mode & 0o777, 0o600);
  for (const o of [s1.out, s2.out, s1.err, s2.err]) assert.ok(!/SECRET/.test(o), o);
  // get は設定をそのまま出す（運用者の端末）
  const g = run(["get"]);
  assert.equal(g.code, 0);
  assert.ok(g.out.includes(`共通: ${JSON.stringify(common)}`), g.out);
  assert.ok(g.out.includes(`session a: ${JSON.stringify(own)}`), g.out);
  assert.match(run(["get", "--session", "a"]).out, /有効な設定: session の設定/);
  assert.match(run(["get", "--session", "b"]).out, /有効な設定: 全 session 共通/);
  // session_create で作った物の中に無い session は書けない
  const z = run(["set", "--session", "zzz", "--url", "http://m/mcp"]);
  assert.equal(z.code, 1);
  // unset
  assert.equal(run(["unset", "--session", "a"]).code, 0);
  assert.match(run(["get", "--session", "a"]).out, /session a: 未設定/);
  assert.deepEqual((await readJson(sessionsFile()))[0].settings, { instructions: "i-a" });
  assert.equal(run(["unset"]).code, 0);
  assert.match(run(["get"]).out, /共通: 未設定/);
  assert.deepEqual(await readJson(centerFile()), { instructions: "ic" });
});

test("set --json-stdin / --json-file: 普通の MCP の設定の 1 件（stdio・http など、Bearer の header もそのまま）を書く。{ mcpServers: { 名前: … } } の 1 件も受ける。不正は exit 2 で値を出さず何も書かない。--token は断る", async () => {
  await seedSessions(["a"]);
  const def = { type: "http", url: "https://m.example/mcp", headers: { Authorization: "Bearer J-SECRET", "X-Agent-Id": "pm" } };
  assert.equal(run(["set", "--json-stdin"], JSON.stringify(def)).code, 0);
  assert.deepEqual((await readJson(centerFile())).memory, def);
  const stdio = { command: "npx", args: ["-y", "memory-mcp"], env: { KEY: "S-SECRET" } };
  assert.equal(run(["set", "--session", "a", "--json-file", "/m.json"], "", { "/m.json": JSON.stringify({ mcpServers: { memory: stdio } }) }).code, 0);
  assert.deepEqual((await readJson(sessionsFile()))[0].settings.memory, stdio);
  const before = { c: await readFile(centerFile(), "utf8"), s: await readFile(sessionsFile(), "utf8") };
  for (const [argv, stdin] of [
    [["set", "--json-stdin"], "{ not json BAD-SECRET"],
    [["set", "--json-stdin"], JSON.stringify({ type: "http", headers: { Authorization: "Bearer BAD-SECRET" } })],
    [["set", "--json-stdin"], JSON.stringify({ args: ["BAD-SECRET"] })],
    [["set", "--json-stdin", "--url", "http://m/mcp"], JSON.stringify(def)],
    [["set", "--json-stdin", "--token-stdin"], "BAD-SECRET"],
    [["set", "--url", "http://m/mcp", "--token", "BAD-SECRET"], ""],
  ] as const) {
    const r = run([...argv], stdin);
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.ok(!/BAD-SECRET/.test(r.err + r.out), r.err);
  }
  assert.equal(await readFile(centerFile(), "utf8"), before.c, "断った set は何も変えない");
  assert.equal(await readFile(sessionsFile(), "utf8"), before.s);
  // --token-file
  assert.equal(run(["set", "--url", "http://m/mcp", "--token-file", "/t"], "", { "/t": "FILE-SECRET\n" }).code, 0);
  assert.deepEqual((await readJson(centerFile())).memory, { type: "http", url: "http://m/mcp", headers: { Authorization: "Bearer FILE-SECRET" } });
});

test("set --url: token の指定が無ければ今の Authorization を残す。--clear-token で消す。token の指定と --clear-token は一緒に使えない", async () => {
  assert.equal(run(["set", "--url", "http://m/mcp", "--agent-id", "a1", "--token-stdin"], "KEEP-ME\n").code, 0);
  assert.equal(run(["set", "--url", "http://m2/mcp"]).code, 0);
  assert.deepEqual((await readJson(centerFile())).memory, { type: "http", url: "http://m2/mcp", headers: { Authorization: "Bearer KEEP-ME" } });
  assert.equal(run(["set", "--url", "http://m3/mcp", "--clear-token"]).code, 0);
  assert.deepEqual((await readJson(centerFile())).memory, { type: "http", url: "http://m3/mcp" });
  const r = run(["set", "--url", "http://m3/mcp", "--clear-token", "--token-stdin"], "X");
  assert.equal(r.code, 2);
});

test("--session: config の projects 由来の session（sessions.json に記録が無い）は center-settings.json の projectMemory に書く。どちらにも無い session は断る", async () => {
  await writeFile(config, JSON.stringify({ projects: [{ name: "cfg", path: join(dir, "cfgp") }] }));
  await writeFile(centerFile(), JSON.stringify({ instructions: "ic", memory: { type: "http", url: "http://common/mcp" } }));
  assert.equal(run(["set", "--session", "cfg", "--url", "http://cfg/mcp", "--token-stdin"], "CFG-T").code, 0);
  const c = await readJson(centerFile());
  assert.deepEqual(c, { instructions: "ic", memory: { type: "http", url: "http://common/mcp" }, projectMemory: { cfg: { type: "http", url: "http://cfg/mcp", headers: { Authorization: "Bearer CFG-T" } } } });
  const g = run(["get", "--session", "cfg"]);
  assert.equal(g.code, 0);
  assert.match(g.out, /http:\/\/cfg\/mcp/);
  assert.match(g.out, /有効な設定: session の設定/);
  assert.equal(run(["unset", "--session", "cfg"]).code, 0);
  assert.deepEqual(await readJson(centerFile()), { instructions: "ic", memory: { type: "http", url: "http://common/mcp" } });
  const r = run(["set", "--session", "nobody", "--url", "http://x/mcp"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /config の projects にも無い/);
});

test("書く直前に file を読み直し、該当の項目だけを変える（読んだ後に他から書かれた記録・項目を巻き戻さない）", async () => {
  await seedSessions(["a"]);
  await writeFile(centerFile(), JSON.stringify({ instructions: "before" }));
  // 標準入力を読む時（= 書く前）に、center が別の記録と項目を保存した
  const r = runMemoryCli(["set", "--config", config, "--session", "a", "--url", "http://a/mcp", "--token-stdin"], "/nonexistent/default.json", {
    readStdin: () => {
      writeFileSync(sessionsFile(), JSON.stringify([
        { name: "a", path: join(dir, "a"), permissionMode: "auto", settings: { instructions: "changed-by-center" }, createdAt: "2026-01-01T00:00:00Z" },
        { name: "b", path: join(dir, "b"), permissionMode: "auto", createdAt: "2026-01-01T00:00:00Z" },
      ]));
      writeFileSync(centerFile(), JSON.stringify({ instructions: "after" }));
      return "T-A";
    },
    readFile: () => "",
    out: () => {},
    err: () => {},
  });
  assert.equal(r, 0);
  const list = await readJson(sessionsFile());
  assert.deepEqual(list.map((x: { name: string }) => x.name), ["a", "b"], "読んだ後に足された記録が残る");
  assert.deepEqual(list[0].settings, { instructions: "changed-by-center", memory: { type: "http", url: "http://a/mcp", headers: { Authorization: "Bearer T-A" } } });
  assert.deepEqual(await readJson(centerFile()), { instructions: "after" }, "session の設定だけを書く時は共通の file に触れない");
});

test("不正な入力は exit 2 で、token の値を出さず、何も書かない", async () => {
  for (const argv of [["set"], ["set", "--url", "ftp://m/x"], ["set", "--url", "http://u:p@m/x"], ["set", "--url", "http://m/x", "--session", "a b"], ["set", "--url", "http://m/x", "--token-stdin", "--token-file", "/x"], ["bogus"], []]) {
    const r = run(argv, "BAD SECRET");
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.ok(!/SECRET/.test(r.err + r.out));
  }
  const bad = run(["set", "--url", "http://m/x", "--token-stdin"], "has space SECRET");
  assert.equal(bad.code, 2);
  assert.ok(!/SECRET/.test(bad.err + bad.out), bad.err);
  await assert.rejects(stat(centerFile()));
  await assert.rejects(stat(join(dir, MEMORY_SETTINGS_FILE)));
});

test("引数に書かれた値（--token VALUE / --token=VALUE / 余分な位置引数 / 不明な --x=VALUE）は error の文にも出力にも出ず、何も書かない", async () => {
  const cases = [
    ["set", "--url", "http://m/x", "--token", "ARGSECRET1"],
    ["set", "--url", "http://m/x", "--token=ARGSECRET2"],
    ["set", "--url", "http://m/x", "ARGSECRET3"],
    ["get", "ARGSECRET4"],
    ["unset", "--bogus=ARGSECRET5"],
    ["set", "--url", "http://m/x", "--url=ARGSECRET6"],
    ["set", "--url", "http://m/x", "-tARGSECRET7"],
  ];
  for (const argv of cases) {
    const r = run(argv);
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.ok(!/ARGSECRET/.test(r.err + r.out), `${JSON.stringify(argv)}: ${r.err}`);
  }
  assert.match(run(["unset", "--bogus=ARGSECRET5"]).err, /--bogus/, "名前は出す");
  await assert.rejects(stat(centerFile()));
});

test("MemoryFile: 外から書き換えられた内容を次の resolve から読む。壊れた file は無いとして扱い、値は log に出ない", async () => {
  const logs: string[] = [];
  const f = createMemoryFile(dir, (m) => logs.push(m));
  assert.equal(f.resolve("a"), undefined);
  await writeFile(f.path, JSON.stringify({ sessions: { a: { url: "http://x/mcp" } }, common: { url: "http://c/mcp" } }));
  assert.deepEqual(f.resolve("a"), { url: "http://x/mcp" });
  assert.deepEqual(f.resolve("b"), { url: "http://c/mcp" });
  await writeFile(f.path, '{"common": {"url": "http://c/mcp", "token": "BROKEN-SECRET"');
  assert.equal(f.resolve("a"), undefined);
  assert.ok(logs.length > 0 && logs.every((l) => !l.includes("SECRET")));
  await writeFile(f.path, JSON.stringify({ common: { url: "ftp://bad" }, sessions: { "a b": { url: "http://x/mcp" } } }));
  assert.equal(f.resolve("a b"), undefined);
  // 移行元の file: exists / retire（.migrated に退ける）
  assert.equal(f.exists(), true);
  f.retire();
  assert.equal(f.exists(), false);
  await stat(`${f.path}.migrated`);
});

test("displayUrl は query と fragment を伏せる", () => {
  assert.equal(displayUrl("http://h:1/p?k=v#f"), "http://h:1/p?…");
  assert.equal(displayUrl("http://h/p"), "http://h/p");
});
