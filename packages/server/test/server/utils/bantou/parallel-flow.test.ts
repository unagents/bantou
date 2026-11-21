import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  parseServerReply,
  type ServerReply,
} from "@agent-hand/bantou-protocol";
import { startDaemon } from "../../../../server/utils/bantou/daemon";

const protocolDir = fileURLToPath(new URL("../../../../../protocol/messenger", import.meta.url));
const fakeClaude = fileURLToPath(new URL("../../../fixtures/fake-claude.sh", import.meta.url));
const msgClient = fileURLToPath(new URL("../../../fixtures/msg-client.mjs", import.meta.url));
type StatusCap = Extract<ServerReply, { type: "status_result" }>["caps"][number];
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

test("並行 task の更新待ち（実 broker・偽 claude）: 動いている task と待っている task を全部数え、全部終わってから終了を頼む", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bantou-parallel-flow-test-"));
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
      session: { claude: fakeClaude, env: { FAKE_CLAUDE_GATE: gate }, timeoutMs: 30_000, maxParallelTasks: 2 },
      update: { spec: "file:/nonexistent/bantou-{version}.tgz" },
    }),
  );
  const exits: string[] = [];
  const daemon = await startDaemon(cfg, {
    protocolDir,
    serverVersion: "0.3.0",
    requestExit: (r) => exits.push(r),
    updateFetch: async () => {},
    updatePollMs: 50,
    startMcp: async () => ({ port: 17999, close: async () => {} }),
  });
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
  const laneState = async (t: string): Promise<string | undefined> =>
    JSON.parse(await readFile(join(ws, "caps", "c1", "logs", "tasks", t, "state.json"), "utf8").catch(() => "{}")).state;
  try {
    await waitFor("center 起動", 15_000, () => (centerReady ? true : undefined));
    const send = async (o: object): Promise<void> => {
      centerProc.stdin.write(JSON.stringify(o) + "\n");
    };
    const next = <T extends ServerReply["type"]>(type: T, from = 0, pred: (r: Extract<ServerReply, { type: T }>) => boolean = () => true): Promise<Extract<ServerReply, { type: T }>> =>
      waitFor(type, 10_000, () => replies.slice(from).find((r) => r.type === type && pred(r as Extract<ServerReply, { type: T }>)) as Extract<ServerReply, { type: T }> | undefined);
    const task = (id: string) => ({ bantou: 1, type: "task", cap_id: "c1", task_id: id, goal: `goal ${id}`, deliverables: {}, verify: {}, constraints: [], workers: {} });

    // 3 つ送る。上限 2 なので 2 つが並行に走り、3 つ目は待つ
    // 続けて 3 つ送る。server は受けた順に待ち行列へ入れる（受け付けの記録の間に後の task が追い越さない）
    for (const t of ["t-1", "t-2", "t-3"]) await send(task(t));
    await waitForAsync("t-1 と t-2 が running", 15_000, async () => (await laneState("t-1")) === "running" && (await laneState("t-2")) === "running");
    // 走っている lane は mcp 設定（header に task_id）を lane の logs/ に持つ
    const mcpOf = (t: string): string => join(ws, "caps", "c1", "logs", "tasks", t, "logs", "mcp.json");
    const mcp1 = JSON.parse(await readFile(mcpOf("t-1"), "utf8")) as { mcpServers: { bantou: { headers: Record<string, string> } } };
    assert.equal(mcp1.mcpServers.bantou.headers["x-bantou-task-id"], "t-1");
    let n = replies.length;
    let cap: StatusCap | undefined;
    for (let i = 0; i < 100; i++) {
      n = replies.length;
      await send({ bantou: 1, type: "status" });
      cap = (await next("status_result", n)).caps.find((c) => c.id === "c1");
      if (cap?.tasks?.some((t) => t.task_id === "t-3")) break;
      await sleep(50);
    }
    assert.equal(cap?.state, "running");
    assert.deepEqual(cap?.tasks?.map((t) => [t.task_id, t.state]), [["t-1", "running"], ["t-2", "running"], ["t-3", "waiting"]]);
    // running の 1 つを除いた動いている lane 1 つ + 待っている task 1 つ（running なら 1 + queued = 3 = 受けた task の数）
    assert.equal(cap?.queued, 2);

    // 更新指示: 動いている 2 つと待っている 1 つを全部数える
    n = replies.length;
    await send({ bantou: 1, type: "update_server", version: "0.3.1" });
    const upd = await next("update_result", n);
    assert.equal(upd.state, "waiting");
    assert.equal(upd.running.caps, 3, JSON.stringify(upd));
    assert.deepEqual(
      (upd.runs ?? []).map((r) => `${r.kind}:${r.id}:${(r as { task_id?: string }).task_id}:${r.phase === "queued" ? "queued" : "live"}`).sort(),
      ["cap:c1:t-1:live", "cap:c1:t-2:live", "cap:c1:t-3:queued"],
    );
    // 待機中の新しい task は断る
    n = replies.length;
    await send(task("t-4"));
    const refused = await next("error", n);
    assert.equal(refused.code, "updating");
    assert.equal(refused.task_id, "t-4");
    assert.match(refused.message, /task t-3/);

    // 偽 claude を終わらせる: t-1・t-2 → t-3 の順に返り、全部終わってから終了を頼む
    await writeFile(gate, "");
    const results = await waitFor("3 つの task_result", 15_000, () => {
      const rs = replies.filter((r) => r.type === "task_result");
      return rs.length >= 3 ? rs : undefined;
    });
    assert.deepEqual(results.map((r) => (r as { task_id: string }).task_id).sort(), ["t-1", "t-2", "t-3"]);
    await waitFor("終了の依頼", 10_000, () => (exits.length > 0 ? true : undefined));
    assert.deepEqual(exits, ["update"]);
    assert.equal(await laneState("t-3"), "idle");
    // task が終わったら lane の mcp.json（extraMcp の env を含みうる）は消える。lane の記録（state.json）は片付けまで残る
    await waitForAsync("mcp.json が消える", 5_000, async () => {
      const left = await Promise.all(["t-1", "t-2", "t-3"].map((t) => readFile(mcpOf(t), "utf8").then(() => true, () => false)));
      return left.every((x) => !x);
    });
    assert.equal(await laneState("t-1"), "idle");
  } finally {
    centerProc.stdin.end();
    await daemon.stop();
    if (centerProc.exitCode === null) centerProc.kill("SIGTERM");
    process.env = saved;
    await rm(dir, { recursive: true, force: true });
  }
});
