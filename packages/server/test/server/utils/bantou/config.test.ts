import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, defaultMaxParallel, DEFAULT_SESSION } from "../../../../server/utils/bantou/config";

/** maxParallel の既定の計算に使う CPU 数（host に依らず固定）。 */
const CPUS = 4;

async function load(obj: unknown, cpus = CPUS) {
  const dir = await mkdtemp(join(tmpdir(), "bantou-config-test-"));
  try {
    const p = join(dir, "config.json");
    await writeFile(p, JSON.stringify(obj));
    return await loadConfig(p, cpus);
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
      allowedTools: ["Bash"],
      disallowedTools: ["Edit"],
      extraArgs: ["--model", "x"],
      capBashSandbox: true,
      maxParallel: 7,
      env: { CLAUDE_CONFIG_DIR: "/c" },
    },
    update: { spec: "bantou@{version}", checkIntervalMs: 5000, maxWaitMs: 60_000 },
    namePrefix: "prod1",
    extraMcp: { fs: { command: "npx", args: ["-y", "p"], env: { A: "b" }, targets: ["worker"] } },
  };
  assert.deepEqual(await load(full), full);
});

test("config: capBashSandbox は既定 false、true / false を受ける", async () => {
  assert.equal((await load({ workspace: "/w" })).session.capBashSandbox, false);
  assert.equal((await load({ workspace: "/w", session: {} })).session.capBashSandbox, false);
  assert.equal((await load({ workspace: "/w", session: { capBashSandbox: true } })).session.capBashSandbox, true);
  assert.equal((await load({ workspace: "/w", session: { capBashSandbox: false } })).session.capBashSandbox, false);
});

test("config: openspecUrl は既定なし。置けば読む。空・文字列以外は拒否", async () => {
  assert.equal((await load({ workspace: "/w" })).openspecUrl, undefined);
  assert.equal("openspecUrl" in (await load({ workspace: "/w" })), false);
  assert.equal((await load({ workspace: "/w", openspecUrl: "http://127.0.0.1:9000/mcp" })).openspecUrl, "http://127.0.0.1:9000/mcp");
  await assert.rejects(() => load({ workspace: "/w", openspecUrl: "" }), /openspecUrl/);
  await assert.rejects(() => load({ workspace: "/w", openspecUrl: 1 }), /openspecUrl/);
});

test("config: 既定値（bind は 127.0.0.1）", async () => {
  const c = await load({ workspace: "/w" });
  assert.deepEqual(c.broker, { port: 7901, bind: "127.0.0.1", discovery: "on", token: "" });
  assert.deepEqual(c.mcp, { port: 7902, bind: "127.0.0.1" });
  assert.deepEqual(c.session, { ...DEFAULT_SESSION, maxParallel: 3 });
  assert.equal(c.namePrefix, undefined);
  assert.equal(c.session.timeoutMs, 1_800_000);
  assert.equal(c.session.permissionMode, "auto");
  assert.equal(c.session.claude, "claude");
  assert.deepEqual(c.session.env, {});
});

test("config: broker / session 一部指定は残りが既定値", async () => {
  const c = await load({ workspace: "/w", broker: { port: 8000 }, session: { timeoutMs: 5 } });
  assert.deepEqual(c.broker, { port: 8000, bind: "127.0.0.1", discovery: "on", token: "" });
  assert.deepEqual(c.session, { ...DEFAULT_SESSION, timeoutMs: 5, maxParallel: 3 });
});

const bad: [string, unknown, RegExp][] = [
  ["workspace 相対パス", { workspace: "rel/ws" }, /workspace は絶対パス: rel\/ws/],
  ["workspace null", { workspace: null }, /workspace は文字列/],
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
  ["maxParallel 0", { workspace: "/w", session: { maxParallel: 0 } }, /session\.maxParallel/],
  ["maxParallel 負", { workspace: "/w", session: { maxParallel: -1 } }, /session\.maxParallel/],
  ["maxParallel 小数", { workspace: "/w", session: { maxParallel: 1.5 } }, /session\.maxParallel/],
  ["maxParallel 文字列", { workspace: "/w", session: { maxParallel: "2" } }, /session\.maxParallel/],
  ["namePrefix 大文字", { workspace: "/w", namePrefix: "Prod" }, /namePrefix/],
  ["namePrefix 空", { workspace: "/w", namePrefix: "" }, /namePrefix/],
  ["namePrefix 17 文字", { workspace: "/w", namePrefix: "a".repeat(17) }, /namePrefix/],
  ["namePrefix ハイフン", { workspace: "/w", namePrefix: "a-b" }, /namePrefix/],
  ["namePrefix 数値", { workspace: "/w", namePrefix: 1 }, /namePrefix/],
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

test("config: maxParallel の既定は CPU 数 − 1（最低 1）。置けば効く", async () => {
  assert.equal(defaultMaxParallel(1), 1);
  assert.equal(defaultMaxParallel(2), 1);
  assert.equal(defaultMaxParallel(4), 3);
  assert.equal(defaultMaxParallel(0), 1);
  assert.equal((await load({ workspace: "/w" }, 1)).session.maxParallel, 1);
  assert.equal((await load({ workspace: "/w", session: {} }, 8)).session.maxParallel, 7);
  assert.equal((await load({ workspace: "/w", session: { maxParallel: 2 } }, 8)).session.maxParallel, 2);
});

test("config: v1 の項目（resource / maxRetries / workerKeepMs など）は読まない（置いても無視）", async () => {
  const c = await load({
    workspace: "/w",
    resource: { sampleMs: 1 },
    session: { maxRetries: -1, workerKeepMs: -1, exitResumeMax: -1, exitRecoverMs: -1, maxParallelTasks: 0 },
  });
  assert.deepEqual(c.session, { ...DEFAULT_SESSION, maxParallel: 3 });
  assert.ok(!("resource" in c));
});

test("config: update の既定は取得元 bantou@{version}・確認 10 分ごと・待ちの上限 30 分。置けば効き、不正は拒否", async () => {
  assert.deepEqual((await load({ workspace: "/w" })).update, { spec: "bantou@{version}", checkIntervalMs: 600_000, maxWaitMs: 1_800_000 });
  assert.deepEqual((await load({ workspace: "/w", update: { checkIntervalMs: 2000 } })).update, { spec: "bantou@{version}", checkIntervalMs: 2000, maxWaitMs: 1_800_000 });
  await assert.rejects(load({ workspace: "/w", update: { spec: "x" } }), /update\.spec/);
  await assert.rejects(load({ workspace: "/w", update: { spec: "-x@{version}" } }), /update\.spec/);
  await assert.rejects(load({ workspace: "/w", update: { checkIntervalMs: 10 } }), /update\.checkIntervalMs/);
  await assert.rejects(load({ workspace: "/w", update: { maxWaitMs: 0 } }), /update\.maxWaitMs/);
  await assert.rejects(load({ workspace: "/w", update: [] }), /update はオブジェクト/);
});

test("config: workspace 省略は config.json のある dir が root。CLAUDE_CONFIG_DIR は <root>/.claude", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bantou-config-root-"));
  try {
    const p = join(dir, "config.json");
    await writeFile(p, JSON.stringify({}));
    const c = await loadConfig(p);
    assert.equal(c.workspace, dir);
    assert.equal(c.session.env.CLAUDE_CONFIG_DIR, join(dir, ".claude"));
    await writeFile(p, JSON.stringify({ session: { env: { CLAUDE_CONFIG_DIR: "/c" } } }));
    assert.equal((await loadConfig(p)).session.env.CLAUDE_CONFIG_DIR, "/c");
    // workspace を明示した従来構成は env を足さない
    await writeFile(p, JSON.stringify({ workspace: "/w" }));
    assert.deepEqual((await loadConfig(p)).session.env, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
