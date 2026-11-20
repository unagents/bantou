import assert from "node:assert/strict";
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

test("set / get / unset（共通と session）。token は標準入力から読み、出力にも file の表示にも値が出ない（file にはある。mode 0600）", async () => {
  const s1 = run(["set", "--url", "http://mem.local:3000/mcp?k=QSECRET", "--agent-id", "shared", "--token-stdin"], "COMMON-SECRET\n");
  assert.equal(s1.code, 0, s1.err);
  const s2 = run(["set", "--session", "a", "--url", "https://own.example/mcp", "--token-stdin"], "OWN-SECRET");
  assert.equal(s2.code, 0, s2.err);
  const g = run(["get"]);
  assert.equal(g.code, 0);
  assert.match(g.out, /共通: url=http:\/\/mem\.local:3000\/mcp\?… agentId=shared token=設定済み/);
  assert.match(g.out, /session a: url=https:\/\/own\.example\/mcp agentId=\(session 名\) token=設定済み/);
  for (const o of [s1.out, s2.out, g.out, run(["get", "--session", "a"]).out, s1.err, s2.err]) assert.ok(!/SECRET/.test(o), o);
  const raw = await readFile(join(dir, MEMORY_SETTINGS_FILE), "utf8");
  assert.ok(raw.includes("COMMON-SECRET") && raw.includes("OWN-SECRET"));
  assert.equal((await stat(join(dir, MEMORY_SETTINGS_FILE))).mode & 0o777, 0o600);
  const ga = run(["get", "--session", "a"]);
  assert.match(ga.out, /有効な設定: session の設定/);
  assert.match(run(["get", "--session", "zzz"]).out, /有効な設定: 全 session 共通/);
  // unset
  assert.equal(run(["unset", "--session", "a"]).code, 0);
  assert.match(run(["get", "--session", "a"]).out, /session a: 未設定/);
  assert.equal(run(["unset"]).code, 0);
  assert.match(run(["get"]).out, /共通: 未設定/);
  assert.equal(createMemoryFile(dir).resolve("a"), undefined);
});

test("set: token の指定が無ければ今の token を残す。--clear-token で消す。--token-file で読む。--token は断る", async () => {
  assert.equal(run(["set", "--url", "http://m/mcp", "--token-file", "/t"], "", { "/t": "FILE-SECRET\n" }).code, 0);
  assert.equal(createMemoryFile(dir).resolve("x")?.token, "FILE-SECRET");
  assert.equal(run(["set", "--url", "http://m2/mcp"]).code, 0);
  assert.deepEqual(createMemoryFile(dir).resolve("x"), { url: "http://m2/mcp", token: "FILE-SECRET" });
  assert.equal(run(["set", "--url", "http://m2/mcp", "--clear-token"]).code, 0);
  assert.deepEqual(createMemoryFile(dir).resolve("x"), { url: "http://m2/mcp" });
  const r = run(["set", "--url", "http://m/mcp", "--token", "ARGV-SECRET"]);
  assert.equal(r.code, 2);
  assert.ok(!r.err.includes("ARGV-SECRET"));
  assert.deepEqual(createMemoryFile(dir).resolve("x"), { url: "http://m2/mcp" }, "断った set は何も変えない");
});

test("不正な入力は exit 2 で、token の値を出さず、何も書かない", async () => {
  for (const argv of [["set"], ["set", "--url", "ftp://m/x"], ["set", "--url", "http://u:p@m/x"], ["set", "--url", "http://m/x", "--session", "a b"], ["set", "--url", "http://m/x", "--token-stdin", "--clear-token"], ["bogus"], []]) {
    const r = run(argv, "BAD SECRET");
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.ok(!/SECRET/.test(r.err + r.out));
  }
  const bad = run(["set", "--url", "http://m/x", "--token-stdin"], "has space SECRET");
  assert.equal(bad.code, 2);
  assert.ok(!/SECRET/.test(bad.err + bad.out), bad.err);
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
  await assert.rejects(stat(join(dir, MEMORY_SETTINGS_FILE)));
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
});

test("displayUrl は query と fragment を伏せる", () => {
  assert.equal(displayUrl("http://h:1/p?k=v#f"), "http://h:1/p?…");
  assert.equal(displayUrl("http://h/p"), "http://h/p");
});
