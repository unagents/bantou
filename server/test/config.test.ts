import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

async function load(obj: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "bantou-config-test-"));
  try {
    const p = join(dir, "config.json");
    await writeFile(p, JSON.stringify(obj));
    return await loadConfig(p);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("config: 全項目指定はそのまま返る", async () => {
  const full = {
    workspace: "/w",
    broker: { port: 0, bind: "127.0.0.1", discovery: "off", token: "t" },
    session: { command: "claude" },
  };
  assert.deepEqual(await load(full), full);
});

test("config: broker 一部指定は残りが既定値", async () => {
  const c = await load({ workspace: "/w", broker: { port: 8000 } });
  assert.deepEqual(c.broker, { port: 8000, bind: "0.0.0.0", discovery: "on", token: "" });
});

const bad: [string, unknown, RegExp][] = [
  ["broker 非オブジェクト", { workspace: "/w", broker: 1 }, /broker はオブジェクト/],
  ["session 非オブジェクト", { workspace: "/w", session: "x" }, /session はオブジェクト/],
  ["port 小数", { workspace: "/w", broker: { port: 1.5 } }, /broker\.port/],
  ["port 負", { workspace: "/w", broker: { port: -1 } }, /broker\.port/],
  ["port 範囲超", { workspace: "/w", broker: { port: 65536 } }, /broker\.port/],
  ["port 文字列", { workspace: "/w", broker: { port: "1" } }, /broker\.port/],
  ["bind 空", { workspace: "/w", broker: { bind: "" } }, /broker\.bind/],
  ["bind 非文字列", { workspace: "/w", broker: { bind: 1 } }, /broker\.bind/],
  ["discovery 不正", { workspace: "/w", broker: { discovery: "yes" } }, /broker\.discovery/],
  ["token 非文字列", { workspace: "/w", broker: { token: 1 } }, /broker\.token/],
  ["command 空", { workspace: "/w", session: { command: "" } }, /session\.command/],
  ["command 非文字列", { workspace: "/w", session: { command: 1 } }, /session\.command/],
];
for (const [label, cfg, re] of bad) {
  test(`config: ${label} は拒否`, async () => {
    await assert.rejects(load(cfg), re);
  });
}
