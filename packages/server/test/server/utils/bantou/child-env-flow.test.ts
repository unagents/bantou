import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { startDaemon } from "../../../../server/utils/bantou/daemon";

const protocolDir = fileURLToPath(new URL("../../../../../protocol/messenger", import.meta.url));
const msgClient = fileURLToPath(new URL("../../../fixtures/msg-client.mjs", import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

async function readJsonWhenReady(path: string, ms: number): Promise<Record<string, string>> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as Record<string, string>;
    } catch {
      if (Date.now() > end) throw new Error(`タイムアウト: ${path}`);
      await sleep(25);
    }
  }
}

/** npx から起動された server の env に入っている物（値は架空）。 */
const LEAKED: Record<string, string> = {
  npm_config_package: "bantou@0.6.10",
  npm_config_yes: "true",
  npm_config_user_agent: "npm/11.0.0 node/v22.0.0 linux x64 workspaces/false",
  npm_config_local_prefix: "/srv/bantou",
  npm_lifecycle_event: "npx",
  npm_lifecycle_script: "bantou",
  npm_execpath: "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
  npm_command: "exec",
  // 利用者の取得元の設定（残す）
  npm_config_registry: "https://registry.example.test/",
};

test("npx の env（実 broker・偽 claude）: cap の本体・task の lane の claude のどれにも npm_config_package などが渡らず、registry は渡る", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bantou-child-env-flow-test-"));
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("AGENT_MESSENGER_") || k.startsWith("CLAUDE_CODE_MESSAGING_")) delete process.env[k];
  }
  const brokerPort = await freePort();
  process.env.AGENT_MESSENGER_HOST = "127.0.0.1";
  process.env.AGENT_MESSENGER_PORT = String(brokerPort);
  process.env.AGENT_MESSENGER_DISCOVERY = "off";
  Object.assign(process.env, LEAKED);
  const ws = join(dir, "ws");
  const cfg = join(dir, "config.json");
  const dumps = join(dir, "dumps");
  await mkdir(dumps);
  // 偽 claude: 受け取った env を書き出して成功を返す。名前は --mcp-config の 2 つ上の dir（本体は cap_id、lane は task_id）
  const fakeClaude = join(dir, "fake-claude");
  await writeFile(
    fakeClaude,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const i = process.argv.indexOf("--mcp-config");
const name = i > 0 ? path.basename(path.dirname(path.dirname(process.argv[i + 1]))) : "none";
fs.writeFileSync(path.join(process.env.FAKE_CLAUDE_ENV_DIR, name + ".json"), JSON.stringify(process.env));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "DONE", session_id: "00000000-0000-4000-8000-000000000001" }));
`,
  );
  await chmod(fakeClaude, 0o755);
  await writeFile(
    cfg,
    JSON.stringify({
      workspace: ws,
      broker: { port: brokerPort, bind: "127.0.0.1", discovery: "off", token: "" },
      mcp: { port: 0, bind: "127.0.0.1" },
      session: { claude: fakeClaude, env: { FAKE_CLAUDE_ENV_DIR: dumps }, timeoutMs: 30_000, maxParallelTasks: 2 },
      update: { spec: "file:/nonexistent/bantou-{version}.tgz" },
    }),
  );
  const daemon = await startDaemon(cfg, {
    protocolDir,
    serverVersion: "0.3.0",
    requestExit: () => {},
    updateFetch: async () => {},
    startMcp: async () => ({ port: 17999, close: async () => {} }),
  });
  const centerProc = spawn(process.execPath, [msgClient, `http://127.0.0.1:${brokerPort}`], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  let centerReady = false;
  createInterface({ input: centerProc.stdout }).on("line", (line) => {
    if (line === '{"ready":true}') centerReady = true;
  });
  try {
    const end = Date.now() + 15_000;
    while (!centerReady) {
      if (Date.now() > end) throw new Error("タイムアウト: center 起動");
      await sleep(25);
    }
    const send = (o: object): void => {
      centerProc.stdin.write(JSON.stringify(o) + "\n");
    };
    const task = (id: string) => ({ bantou: 1, type: "task", cap_id: "c1", task_id: id, goal: `goal ${id}`, deliverables: {}, verify: {}, constraints: [], workers: {} });
    send({ bantou: 1, type: "kick_cap", cap_id: "c1", prompt: "p" });
    send(task("t-1"));
    send(task("t-2"));

    for (const name of ["c1", "t-1", "t-2"]) {
      const env = await readJsonWhenReady(join(dumps, `${name}.json`), 15_000);
      for (const k of Object.keys(LEAKED)) {
        if (k === "npm_config_registry") continue;
        assert.equal(env[k], undefined, `${name}: ${k} は渡さない`);
      }
      assert.equal(env.npm_config_registry, LEAKED.npm_config_registry, `${name}: registry は渡す`);
      assert.equal(env.FAKE_CLAUDE_ENV_DIR, dumps, `${name}: session.env は渡す`);
    }
    // server 自身の env は変えない（自動更新の npx はこれで動く）
    for (const [k, v] of Object.entries(LEAKED)) assert.equal(process.env[k], v);
  } finally {
    centerProc.stdin.end();
    await daemon.stop();
    if (centerProc.exitCode === null) centerProc.kill("SIGTERM");
    process.env = saved;
    await rm(dir, { recursive: true, force: true });
  }
});
