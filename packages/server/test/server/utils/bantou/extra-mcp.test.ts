import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../../../../server/utils/bantou/config";
import { buildExtraMcp, writeMcpConfigFile } from "../../../../server/utils/bantou/extra-mcp";

async function load(extraMcp: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "bantou-extra-mcp-test-"));
  try {
    const p = join(dir, "config.json");
    await writeFile(p, JSON.stringify({ workspace: "/w", extraMcp }));
    return await loadConfig(p);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const sample: NonNullable<Config["extraMcp"]> = {
  both: { command: "npx", args: ["-y", "pkg-a"], env: { K: "V" }, targets: ["cap", "worker"] },
  wonly: { command: "tool-w", args: [], env: {}, targets: ["worker"] },
  conly: { command: "tool-c", args: [], env: {}, targets: ["cap"] },
};

test("extraMcp: worker には worker 指定と両方だけ載る", () => {
  const r = buildExtraMcp(sample, "worker");
  assert.deepEqual(Object.keys(r.servers).sort(), ["both", "wonly"]);
  assert.deepEqual(r.servers.both, { type: "stdio", command: "npx", args: ["-y", "pkg-a"], env: { K: "V" } });
  assert.deepEqual(r.allowedTools.sort(), ["mcp__both", "mcp__wonly"]);
});

test("extraMcp: cap には cap 指定と両方だけ載る", () => {
  const r = buildExtraMcp(sample, "cap");
  assert.deepEqual(Object.keys(r.servers).sort(), ["both", "conly"]);
  assert.ok(!("wonly" in r.servers));
  assert.deepEqual(r.allowedTools.sort(), ["mcp__both", "mcp__conly"]);
});

test("extraMcp: 未設定なら何も載らない", () => {
  assert.deepEqual(buildExtraMcp({}, "cap"), { servers: {}, allowedTools: [] });
});

test("extraMcp: 予約名は組み立て側でも既存優先で捨てて警告", () => {
  const logs: string[] = [];
  const r = buildExtraMcp({ bantou: { command: "x", args: [], env: {}, targets: ["cap", "worker"] } }, "cap", (m) => logs.push(m));
  assert.deepEqual(r, { servers: {}, allowedTools: [] });
  assert.equal(logs.length, 1);
});

test("config: 省略で targets は両方、args/env は空", async () => {
  const c = await load({ a: { command: "npx" } });
  assert.deepEqual(c.extraMcp, { a: { command: "npx", args: [], env: {}, targets: ["cap", "worker"] } });
  assert.deepEqual((await load(undefined)).extraMcp, {});
});

test("config: 予約名 bantou は拒否", async () => {
  await assert.rejects(load({ bantou: { command: "x" } }), /衝突/);
});

test("config: 不正な形は拒否", async () => {
  const bad: unknown[] = [
    [],
    { "a b": { command: "x" } },
    { "a__b": { command: "x" } },
    { a: "x" },
    { a: {} },
    { a: { command: "" } },
    { a: { command: "x", args: "y" } },
    { a: { command: "x", args: [1] } },
    { a: { command: "x", env: { K: 1 } } },
    { a: { command: "x", env: [] } },
    { a: { command: "x", targets: [] } },
    { a: { command: "x", targets: ["cap", "cap"] } },
    { a: { command: "x", targets: ["center"] } },
    { a: { command: "x", url: "http://h" } },
    { a: { command: "x", headers: {} } },
    { a: { command: "x", env: { "K\0": "v" } } },
    { a: { command: "x", env: { K: "v\0" } } },
    { a: { command: "x", targets: null } },
    { a: { command: "x", args: null } },
    { a: { command: "x", env: null } },
  ];
  for (const b of bad) await assert.rejects(load(b), /extraMcp/, JSON.stringify(b));
});

test("config: - と _ ・大小の違いだけの名前の組は拒否", async () => {
  await assert.rejects(load({ "my-x": { command: "x" }, my_x: { command: "x" } }), /衝突/);
  await assert.rejects(load({ "My-X": { command: "x" }, my_x: { command: "x" } }), /衝突/);
  // 衝突しない組は通る
  const c = await load({ "my-x": { command: "x" }, "my-y": { command: "x" } });
  assert.deepEqual(Object.keys(c.extraMcp ?? {}).sort(), ["my-x", "my-y"]);
});

test("config: 予約名 bantou は大小違いも拒否（ban-tou は別名として通る）", async () => {
  await assert.rejects(load({ BANTOU: { command: "x" } }), /衝突/);
  await assert.rejects(load({ Bantou: { command: "x" } }), /衝突/);
  await load({ "ban-tou": { command: "x" } });
});

test("buildExtraMcp: 予約名は大小違いも捨てる", () => {
  const r = buildExtraMcp({ BANTOU: { command: "x", args: [], env: {}, targets: ["cap", "worker"] } }, "cap");
  assert.deepEqual(r.servers, {});
});

test("writeMcpConfigFile: 既存の 0644 の file も書き直しで 0600 になる", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bantou-mcpjson-test-"));
  try {
    const p = join(dir, "mcp.json");
    await writeFile(p, "old\n");
    await chmod(p, 0o644);
    assert.equal((await stat(p)).mode & 0o777, 0o644);
    await writeMcpConfigFile(p, { mcpServers: {} });
    assert.equal((await stat(p)).mode & 0o777, 0o600);
    // 新規作成も 0600
    const q = join(dir, "new.json");
    await writeMcpConfigFile(q, { a: 1 });
    assert.equal((await stat(q)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
