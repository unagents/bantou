import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../../../../server/utils/bantou/config";
import { buildExtraMcp } from "../../../../server/utils/bantou/extra-mcp";

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
  ];
  for (const b of bad) await assert.rejects(load(b), /extraMcp/, JSON.stringify(b));
});
