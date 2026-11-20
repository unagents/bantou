import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { COORDINATOR_SETTINGS_FILE, createCoordinatorFile, runCoordinatorCli } from "../src/coordinator-settings.js";

let dir: string;
let config: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "center-coordcli-"));
  config = join(dir, "center.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const run = (argv: string[], existing: string[] = ["main", "other"]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = runCoordinatorCli(argv.length ? [argv[0], "--config", config, ...argv.slice(1)] : [], "/nonexistent/default.json", {
    sessionExists: (n) => existing.includes(n),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
};

test("get / set / unset: 設定は coordinator-settings.json に入り、center の読み口（createCoordinatorFile）で読める。出力に効き方が出る", async () => {
  assert.match(run(["get"]).out, /統括の session: 未設定/);
  const s = run(["set", "main"]);
  assert.equal(s.code, 0, s.err);
  assert.match(s.out, /統括の session: main/);
  assert.match(s.out, /次の呼び出しから/);
  assert.match(s.out, /次の起動から/);
  assert.deepEqual(JSON.parse(await readFile(join(dir, COORDINATOR_SETTINGS_FILE), "utf8")), { session: "main" });
  assert.match(run(["get"]).out, /統括の session: main/);
  assert.equal(createCoordinatorFile(dir).read(), "main");
  assert.equal(run(["set", "other"]).code, 0);
  assert.equal(createCoordinatorFile(dir).read(), "other");
  const u = run(["unset"]);
  assert.equal(u.code, 0);
  assert.match(u.out, /次の起動から/);
  assert.equal(createCoordinatorFile(dir).read(), null);
  assert.match(run(["get"]).out, /未設定/);
  assert.match(run(["unset"]).out, /元から無い/);
});

test("set: 存在しない session 名は exit 1 で断り、何も書かない（既存の設定も変えない）", async () => {
  assert.equal(run(["set", "main"]).code, 0);
  const r = run(["set", "ghost"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /存在しない: ghost/);
  assert.equal(createCoordinatorFile(dir).read(), "main");
});

test("使い方の誤りは exit 2 で何も書かない（不明な action・名前なし・不正な名前・余計な引数・不明なオプション）", async () => {
  for (const argv of [[], ["bogus"], ["set"], ["set", "a b"], ["set", "main", "other"], ["get", "main"], ["set", "main", "--x"], ["unset", "main"]]) {
    const r = run(argv);
    assert.equal(r.code, 2, JSON.stringify(argv));
  }
  await assert.rejects(readFile(join(dir, COORDINATOR_SETTINGS_FILE), "utf8"));
});

test("createCoordinatorFile: CLI が外から書き換えた値を、同じ instance が次の read で拾う。壊れた file は無効（null）", async () => {
  const f = createCoordinatorFile(dir);
  assert.equal(f.read(), null);
  run(["set", "main"]);
  assert.equal(f.read(), "main");
  await writeFile(f.path, JSON.stringify({ session: "other" }));
  assert.equal(f.read(), "other");
  await writeFile(f.path, "{ not json");
  assert.equal(f.read(), null);
  await writeFile(f.path, JSON.stringify({ session: "bad name" }));
  assert.equal(f.read(), null);
});
