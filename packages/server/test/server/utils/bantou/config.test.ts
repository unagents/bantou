import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, DEFAULT_SESSION } from "../../../../server/utils/bantou/config";

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
    broker: { port: 0, bind: "0.0.0.0", discovery: "off", token: "t" },
    mcp: { port: 0, bind: "::1" },
    session: {
      claude: "/usr/bin/claude",
      permissionMode: "acceptEdits",
      timeoutMs: 1000,
      maxRetries: 0,
      allowedTools: ["Bash"],
      disallowedTools: ["Edit"],
      extraArgs: ["--model", "x"],
      capBashSandbox: true,
      env: { CLAUDE_CONFIG_DIR: "/c" },
    },
    update: { spec: "file:/x/bantou-{version}.tgz" },
  };
  assert.deepEqual(await load(full), full);
});

test("config: capBashSandbox は既定 false、true / false を受ける", async () => {
  assert.equal((await load({ workspace: "/w" })).session.capBashSandbox, false);
  assert.equal((await load({ workspace: "/w", session: {} })).session.capBashSandbox, false);
  assert.equal((await load({ workspace: "/w", session: { capBashSandbox: true } })).session.capBashSandbox, true);
  assert.equal((await load({ workspace: "/w", session: { capBashSandbox: false } })).session.capBashSandbox, false);
});

test("config: 既定値（bind は 127.0.0.1）", async () => {
  const c = await load({ workspace: "/w" });
  assert.deepEqual(c.broker, { port: 7901, bind: "127.0.0.1", discovery: "on", token: "" });
  assert.deepEqual(c.mcp, { port: 7902, bind: "127.0.0.1" });
  assert.deepEqual(c.session, DEFAULT_SESSION);
  assert.equal(c.session.timeoutMs, 1_800_000);
  assert.equal(c.session.maxRetries, 1);
  assert.equal(c.session.permissionMode, "auto");
  assert.equal(c.session.claude, "claude");
  assert.deepEqual(c.session.env, {});
});

test("config: broker / session 一部指定は残りが既定値", async () => {
  const c = await load({ workspace: "/w", broker: { port: 8000 }, session: { timeoutMs: 5 } });
  assert.deepEqual(c.broker, { port: 8000, bind: "127.0.0.1", discovery: "on", token: "" });
  assert.deepEqual(c.session, { ...DEFAULT_SESSION, timeoutMs: 5 });
});

const bad: [string, unknown, RegExp][] = [
  ["workspace 欠落", {}, /workspace/],
  ["workspace 相対パス", { workspace: "rel/ws" }, /workspace は絶対パス: rel\/ws/],
  ["broker 非オブジェクト", { workspace: "/w", broker: 1 }, /broker はオブジェクト/],
  ["session 非オブジェクト", { workspace: "/w", session: "x" }, /session はオブジェクト/],
  ["port 小数", { workspace: "/w", broker: { port: 1.5 } }, /broker\.port/],
  ["port 負", { workspace: "/w", broker: { port: -1 } }, /broker\.port/],
  ["port 範囲超", { workspace: "/w", broker: { port: 65536 } }, /broker\.port/],
  ["port 文字列", { workspace: "/w", broker: { port: "1" } }, /broker\.port/],
  ["bind 空", { workspace: "/w", broker: { bind: "" } }, /broker\.bind/],
  ["bind 非文字列", { workspace: "/w", broker: { bind: 1 } }, /broker\.bind/],
  ["discovery 不正", { workspace: "/w", broker: { discovery: "yes" } }, /broker\.discovery/],
  ["mcp 非オブジェクト", { workspace: "/w", mcp: 1 }, /mcp はオブジェクト/],
  ["mcp.port 範囲超", { workspace: "/w", mcp: { port: 65536 } }, /mcp\.port/],
  ["mcp.port 文字列", { workspace: "/w", mcp: { port: "1" } }, /mcp\.port/],
  ["mcp.bind 空", { workspace: "/w", mcp: { bind: "" } }, /mcp\.bind/],
  ["token 非文字列", { workspace: "/w", broker: { token: 1 } }, /broker\.token/],
  ["session.command は廃止", { workspace: "/w", session: { command: "claude" } }, /session\.command は廃止。session\.claude を使う/],
  ["claude 空", { workspace: "/w", session: { claude: "" } }, /session\.claude/],
  ["permissionMode 不正", { workspace: "/w", session: { permissionMode: "yolo" } }, /session\.permissionMode/],
  ["timeoutMs 0", { workspace: "/w", session: { timeoutMs: 0 } }, /session\.timeoutMs/],
  ["timeoutMs 小数", { workspace: "/w", session: { timeoutMs: 1.5 } }, /session\.timeoutMs/],
  ["timeoutMs 文字列", { workspace: "/w", session: { timeoutMs: "1" } }, /session\.timeoutMs/],
  ["maxRetries 負", { workspace: "/w", session: { maxRetries: -1 } }, /session\.maxRetries/],
  ["maxRetries 小数", { workspace: "/w", session: { maxRetries: 0.5 } }, /session\.maxRetries/],
  ["allowedTools 非配列", { workspace: "/w", session: { allowedTools: "Bash" } }, /session\.allowedTools/],
  ["allowedTools 要素が数値", { workspace: "/w", session: { allowedTools: ["a", 1] } }, /session\.allowedTools/],
  ["disallowedTools 要素が数値", { workspace: "/w", session: { disallowedTools: [1] } }, /session\.disallowedTools/],
  ["extraArgs 要素が null", { workspace: "/w", session: { extraArgs: [null] } }, /session\.extraArgs/],
  ["capBashSandbox 文字列", { workspace: "/w", session: { capBashSandbox: "true" } }, /session\.capBashSandbox/],
  ["capBashSandbox 数値", { workspace: "/w", session: { capBashSandbox: 0 } }, /session\.capBashSandbox/],
  ["env 配列", { workspace: "/w", session: { env: ["A=1"] } }, /session\.env は文字列値のオブジェクト/],
  ["env 値が数値", { workspace: "/w", session: { env: { A: 1 } } }, /session\.env は文字列値のオブジェクト/],
  ["env キーが空", { workspace: "/w", session: { env: { "": "x" } } }, /session\.env は文字列値のオブジェクト/],
];
for (const [label, cfg, re] of bad) {
  test(`config: ${label} は拒否`, async () => {
    await assert.rejects(load(cfg), re);
  });
}

test("config: update.spec は既定 bantou@{version}、{version} 必須、- 始まりは拒否", async () => {
  assert.deepEqual((await load({ workspace: "/w" })).update, { spec: "bantou@{version}" });
  assert.deepEqual((await load({ workspace: "/w", update: {} })).update, { spec: "bantou@{version}" });
  assert.equal((await load({ workspace: "/w", update: { spec: "file:/t/b-{version}.tgz" } })).update.spec, "file:/t/b-{version}.tgz");
  for (const spec of ["bantou", "", 1, "-x{version}"]) {
    await assert.rejects(load({ workspace: "/w", update: { spec } }), /update\.spec/, String(spec));
  }
  await assert.rejects(load({ workspace: "/w", update: "x" }), /update はオブジェクト/);
});
