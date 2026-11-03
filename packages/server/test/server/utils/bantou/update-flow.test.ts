import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  MESSENGER_PROTOCOL,
  parseServerReply,
  type ServerReply,
} from "@agent-hand/bantou-protocol";
import { startDaemon } from "../../../../server/utils/bantou/daemon";

const protocolDir = fileURLToPath(new URL("../../../../../packages/protocol/messenger", import.meta.url));
const fakeClaude = fileURLToPath(new URL("../../../fixtures/fake-claude.sh", import.meta.url));
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

async function waitFor<T>(what: string, ms: number, fn: () => T | undefined): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`タイムアウト: ${what}`);
    await sleep(25);
  }
}

async function waitForAsync(what: string, ms: number, fn: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`タイムアウト: ${what}`);
    await sleep(50);
  }
}

test("更新フロー（実 broker・偽 claude）: 待機中は kick_cap を理由付きで断り、終わったら終了を頼む", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bantou-flow-test-"));
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("AGENT_MESSENGER_") || k.startsWith("CLAUDE_CODE_MESSAGING_")) delete process.env[k];
  }
  const brokerPort = await freePort();
  process.env.AGENT_MESSENGER_HOST = "127.0.0.1";
  process.env.AGENT_MESSENGER_PORT = String(brokerPort);
  process.env.AGENT_MESSENGER_DISCOVERY = "off";
  const ws = join(dir, "ws");
  const cfg = join(dir, "config.json");
  const gate = join(dir, "gate"); // このファイルができるまで偽 claude は終わらない
  await writeFile(
    cfg,
    JSON.stringify({
      workspace: ws,
      broker: { port: brokerPort, bind: "127.0.0.1", discovery: "off", token: "" },
      mcp: { port: 0, bind: "127.0.0.1" },
      session: { claude: fakeClaude, env: { FAKE_CLAUDE_GATE: gate }, timeoutMs: 30_000 },
      update: { spec: "file:/nonexistent/bantou-{version}.tgz" },
    }),
  );
  const exits: string[] = [];
  const fetched: string[] = [];
  const daemon = await startDaemon(cfg, {
    protocolDir,
    serverVersion: "0.3.0",
    requestExit: (r) => exits.push(r),
    updateFetch: async (spec, version) => {
      fetched.push(`${spec}|${version}`);
    },
    updatePollMs: 50,
    startMcp: async () => ({ port: 17999, close: async () => {} }),
  });
  // center 役は別 process（broker は 1 process 1 peer）
  const centerProc = spawn(process.execPath, [msgClient, `http://127.0.0.1:${brokerPort}`], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const replies: ServerReply[] = [];
  let centerReady = false;
  createInterface({ input: centerProc.stdout }).on("line", (line) => {
    if (line === '{"ready":true}') {
      centerReady = true;
      return;
    }
    const r = parseServerReply(line);
    if (r) replies.push(r);
  });
  try {
    await waitFor("center 起動", 15_000, () => (centerReady ? true : undefined));
    const send = async (o: object): Promise<void> => {
      centerProc.stdin.write(JSON.stringify(o) + "\n");
    };
    const next = <T extends ServerReply["type"]>(type: T, from = 0): Promise<Extract<ServerReply, { type: T }>> =>
      waitFor(type, 10_000, () => replies.slice(from).find((r) => r.type === type) as Extract<ServerReply, { type: T }> | undefined);

    // hello
    await send({ bantou: 1, type: "hello" });
    const hello = await next("hello_result");
    assert.equal(hello.server_version, "0.3.0");
    assert.equal(hello.protocol_version, MESSENGER_PROTOCOL.version);
    assert.equal(hello.update, null);

    // server.ready が書かれている
    const ready = JSON.parse(await readFile(join(ws, "server.ready"), "utf8"));
    assert.deepEqual(ready, { pid: process.pid, version: "0.3.0" });

    // cap を走らせる（2 秒）
    await send({ bantou: 1, type: "kick_cap", cap_id: "c1", prompt: "go" });
    // pull 配送の遅延があるので、cap が実際に running になるのを見てから進める
    await waitForAsync("cap running", 15_000, async () => {
      const st = JSON.parse(await readFile(join(ws, "caps", "c1", "state.json"), "utf8").catch(() => "{}"));
      return st.state === "running";
    });

    // 更新指示: すぐ waiting が返る（cap の終了を待たない）
    let n = replies.length;
    await send({ bantou: 1, type: "update_server", version: "0.3.1" });
    const upd = await next("update_result", n);
    assert.equal(upd.state, "waiting");
    assert.equal(upd.from, "0.3.0");
    assert.equal(upd.to, "0.3.1");
    assert.equal(upd.running.caps, 1, JSON.stringify(replies));
    assert.deepEqual(fetched, ["file:/nonexistent/bantou-0.3.1.tgz|0.3.1"]);

    // 待機中の kick_cap は理由付きで断る（再送できる形）
    n = replies.length;
    await send({ bantou: 1, type: "kick_cap", cap_id: "c2", prompt: "again" });
    const refused = await next("error", n);
    assert.equal(refused.code, "updating");
    assert.equal(refused.retryable, true);
    assert.equal(refused.cap_id, "c2");
    assert.equal(refused.command, "kick_cap");
    assert.match(refused.message, /0\.3\.0→0\.3\.1/);
    assert.match(refused.message, /再送/);
    // c2 は実行されていない
    await assert.rejects(stat(join(ws, "caps", "c2", "state.json")));

    // status と hello は待機中も答える
    n = replies.length;
    await send({ bantou: 1, type: "status" });
    assert.equal((await next("status_result", n)).caps.find((c) => c.id === "c1")?.state, "running");
    n = replies.length;
    await send({ bantou: 1, type: "hello" });
    const h2 = await next("hello_result", n);
    assert.equal(h2.update?.state, "waiting");
    assert.equal(h2.update?.to, "0.3.1");

    // 別の版は conflict
    n = replies.length;
    await send({ bantou: 1, type: "update_server", version: "0.3.2" });
    const conflict = await next("error", n);
    assert.equal(conflict.code, "update_conflict");
    assert.equal(exits.length, 0, "cap が動いている間は終了を頼まない");

    // cap を終わらせる → 結果が返り、その後に終了を頼む
    await writeFile(gate, "");
    const capResult = await next("cap_result");
    assert.equal(capResult.ok, true);
    assert.equal(capResult.cap_id, "c1");
    await waitFor("終了の依頼", 5000, () => (exits.length > 0 ? true : undefined));
    assert.deepEqual(exits, ["update"]);
    assert.deepEqual(JSON.parse(await readFile(join(ws, "update.json"), "utf8")), {
      state: "restart",
      to: "0.3.1",
      spec: "file:/nonexistent/bantou-0.3.1.tgz",
    });
  } finally {
    centerProc.stdin.end();
    await daemon.stop();
    if (centerProc.exitCode === null) centerProc.kill("SIGTERM");
    process.env = saved;
    await rm(dir, { recursive: true, force: true });
  }
});
