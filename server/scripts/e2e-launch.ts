/**
 * e2e: bantou-server を実起動し、messenger 経由で kick_cap / resume_worker / spawn_worker / worker_report / status を検証する。
 * claude を実際に 6 回起動する（数分かかる）。claude のログインを使う。
 * CLAUDE_CONFIG_DIR は config の session.env で渡す（環境変数にあれば同じ値）。
 * `E2E_ROOT` で一時ディレクトリの親を変更できる。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMessengerClient } from "@unagents/messenger-client";
import { parseServerReply, SERVER_NAME, type ServerReply } from "@agent-hand/bantou-protocol";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const serverDir = fileURLToPath(new URL("..", import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_TIMEOUT = 300_000;

const serverLog: string[] = [];
const replies: ServerReply[] = [];

async function waitFor<T>(what: string, ms: number, fn: () => T | undefined): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`タイムアウト: ${what} (${ms}ms)`);
    await sleep(100);
  }
}

function fail(msg: string): never {
  throw new Error(msg);
}

async function readStateFile(path: string): Promise<{ session_id: string | null; state: string }> {
  return JSON.parse(await readFile(path, "utf8")) as { session_id: string | null; state: string };
}

async function main(): Promise<void> {
  const root = process.env.E2E_ROOT ?? tmpdir();
  const dir = await mkdtemp(join(root, "bantou-e2e-"));
  const ws = join(dir, "ws");
  const cfgPath = join(dir, "config.json");
  const capId = `e2e-cap-${process.pid}`;
  const workerId = `e2e-worker-${process.pid}`;
  const flowCapId = `e2e-flowcap-${process.pid}`;
  const flowWorkerId = `e2e-flowworker-${process.pid}`;
  const sessionEnv: Record<string, string> = {};
  if (process.env.CLAUDE_CONFIG_DIR) sessionEnv.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
  await writeFile(
    cfgPath,
    JSON.stringify({
      workspace: ws,
      broker: { port: 0, bind: "127.0.0.1", discovery: "off", token: "" },
      session: { timeoutMs: RUN_TIMEOUT, env: sessionEnv },
    }),
  );

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("AGENT_MESSENGER_") || k.startsWith("CLAUDE_CODE_MESSAGING_")) delete env[k];

  let server: ChildProcess | undefined;
  let exitCode: number | null | undefined;
  let client: ReturnType<typeof createMessengerClient> | undefined;
  let port = 0;
  let error: unknown;

  try {
    server = spawn(process.execPath, ["bin/bantou.mjs", "--config", cfgPath], {
      cwd: serverDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.on("exit", (code) => {
      exitCode = code;
    });
    for (const s of [server.stdout, server.stderr]) {
      let buf = "";
      s?.setEncoding("utf8");
      s?.on("data", (chunk: string) => {
        buf += chunk;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) {
          serverLog.push(l);
          console.log(`[server] ${l}`);
        }
      });
    }

    const brokerLine = await waitFor("broker 起動", 20_000, () =>
      serverLog.find((l) => l.includes("broker 起動: port=")),
    );
    port = Number(/broker 起動: port=(\d+)/.exec(brokerLine)?.[1]);
    if (!port) fail(`broker port を取れない: ${brokerLine}`);
    await waitFor("peer 登録", 20_000, () => serverLog.find((l) => l.includes("peer 登録:")));

    client = createMessengerClient({
      env: { AGENT_MESSENGER_DISCOVERY: "off" },
      name: "bantou-e2e-sender",
      brokers: [`http://127.0.0.1:${port}`],
      autoStartBroker: false,
      log: (m) => console.log(`[client] ${m}`),
    });
    client.onMessage((m) => {
      const r = parseServerReply(m.text);
      if (r) replies.push(r);
    });
    await client.connect();

    const send = (cmd: object): Promise<unknown> => client!.send(SERVER_NAME, JSON.stringify(cmd));
    const nextReply = (what: string, ms: number): Promise<ServerReply> =>
      waitFor(what, ms, () => replies.shift());

    // 1. kick_cap（new）
    await send({
      bantou: 1,
      type: "kick_cap",
      cap_id: capId,
      prompt: "Run `echo kicked` in Bash and reply with only the command output on one line.",
      reason: "e2e",
    });
    const c1 = await nextReply("cap_result (1 回目)", RUN_TIMEOUT + 30_000);
    if (c1.type !== "cap_result") fail(`cap_result でない: ${JSON.stringify(c1)}`);
    if (!c1.ok) fail(`cap_result が ok でない: ${JSON.stringify(c1)}`);
    if (c1.cap_id !== capId) fail(`cap_id 不一致: ${c1.cap_id}`);
    if (!c1.result_text.includes("kicked")) fail(`result_text に kicked が無い: ${c1.result_text}`);
    if (!UUID.test(c1.session_id)) fail(`session_id が UUID でない: ${c1.session_id}`);
    const capState = await readStateFile(join(ws, "caps", capId, "state.json"));
    if (capState.session_id !== c1.session_id) fail(`state.json の session_id 不一致: ${capState.session_id}`);
    if (capState.state !== "idle") fail(`cap の state が idle でない: ${capState.state}`);

    // 2. kick_cap（resume）
    await send({
      bantou: 1,
      type: "kick_cap",
      cap_id: capId,
      prompt: "Reply with only the word you echoed in the previous turn.",
    });
    const c2 = await nextReply("cap_result (2 回目)", RUN_TIMEOUT + 30_000);
    if (c2.type !== "cap_result") fail(`cap_result でない: ${JSON.stringify(c2)}`);
    if (!c2.ok) fail(`2 回目が ok でない: ${JSON.stringify(c2)}`);
    if (c2.session_id !== c1.session_id) fail(`session_id が変わった: ${c1.session_id} -> ${c2.session_id}`);
    if (!c2.result_text.includes("kicked")) fail(`2 回目の result_text に kicked が無い: ${c2.result_text}`);
    if (!serverLog.some((l) => l.includes("mode=resume") && l.includes(c1.session_id))) {
      fail("server ログに該当 session の mode=resume が無い");
    }

    // 3. resume_worker
    await send({
      bantou: 1,
      type: "resume_worker",
      worker_id: workerId,
      prompt: "Reply with only the word pong.",
    });
    const w1 = await nextReply("worker_result", RUN_TIMEOUT + 30_000);
    if (w1.type !== "worker_result") fail(`worker_result でない: ${JSON.stringify(w1)}`);
    if (!w1.ok) fail(`worker_result が ok でない: ${JSON.stringify(w1)}`);
    if (w1.worker_id !== workerId) fail(`worker_id 不一致: ${w1.worker_id}`);
    if (!w1.result_text.toLowerCase().includes("pong")) fail(`result_text に pong が無い: ${w1.result_text}`);
    const workerState = await readStateFile(join(ws, "workers", workerId, "state.json"));
    if (workerState.session_id !== w1.session_id) fail(`worker の session_id 不一致: ${workerState.session_id}`);

    // 3b. cap -> spawn_worker -> worker -> worker_report -> cap 再開 -> cap_result
    await send({
      bantou: 1,
      type: "kick_cap",
      cap_id: flowCapId,
      prompt:
        `Spawn exactly one worker. Send bantou-server a spawn_worker with worker_id "${flowWorkerId}" and cap_id "${flowCapId}". ` +
        'The worker prompt must tell it: run `echo hi` in Bash, then send a worker_report with kind "done" and the command output as text. ' +
        "After you sent spawn_worker, end your turn at once. " +
        "When you are later resumed with a worker report, reply with only: REPORT=<the report text>.",
      reason: "e2e flow",
    });
    const f1 = await nextReply("cap_result (flow 1 回目)", RUN_TIMEOUT + 30_000);
    if (f1.type !== "cap_result" || !f1.ok || f1.cap_id !== flowCapId) fail(`flow 1 回目が不正: ${JSON.stringify(f1)}`);
    const f2 = await nextReply("cap_result (worker_report 後の cap 再開)", 2 * RUN_TIMEOUT + 30_000);
    if (f2.type !== "cap_result" || !f2.ok || f2.cap_id !== flowCapId) fail(`flow 2 回目が不正: ${JSON.stringify(f2)}`);
    if (f2.session_id !== f1.session_id) fail(`cap の session_id が変わった: ${f1.session_id} -> ${f2.session_id}`);
    if (!f2.result_text.includes("hi")) fail(`再開した cap の result_text に hi が無い: ${f2.result_text}`);
    const owner = JSON.parse(await readFile(join(ws, "workers", flowWorkerId, "owner.json"), "utf8")) as { cap_id: string };
    if (owner.cap_id !== flowCapId) fail(`owner.json の cap_id 不一致: ${owner.cap_id}`);
    for (const w of [
      "指示受信: type=spawn_worker",
      "指示受信: type=worker_report",
      `claude 起動: kind=worker id=${flowWorkerId} mode=new`,
      `claude 起動: kind=cap id=${flowCapId} mode=resume`,
    ]) {
      if (!serverLog.some((l) => l.includes(w))) fail(`server ログに "${w}" が無い`);
    }
    if (replies.length > 0) fail(`flow 後に想定外の返信: ${JSON.stringify(replies)}`);

    // 4. status
    await send({ bantou: 1, type: "status" });
    const st = await nextReply("status_result", 15_000);
    if (st.type !== "status_result") fail(`status_result でない: ${JSON.stringify(st)}`);
    const cap = st.caps.find((c) => c.id === capId);
    const worker = st.workers.find((w) => w.id === workerId);
    const flowCap = st.caps.find((c) => c.id === flowCapId);
    const flowWorker = st.workers.find((w) => w.id === flowWorkerId);
    if (!cap || !worker || !flowCap || !flowWorker) fail(`status に cap / worker が無い: ${JSON.stringify(st)}`);
    for (const a of [cap, worker, flowCap, flowWorker]) {
      if (a.state !== "idle") fail(`status の ${a.id} が idle でない: ${a.state}`);
      if (a.queued !== 0) fail(`status の ${a.id} の queued が 0 でない: ${a.queued}`);
    }

    // 5. 非コマンドは無視される
    await client.send(SERVER_NAME, "hello");
    await sleep(3000);
    if (replies.length > 0) fail(`非コマンドに返信が来た: ${JSON.stringify(replies)}`);
    await waitFor("無視ログ", 5000, () => serverLog.find((l) => l.includes("無視:")));
  } catch (e) {
    error = e;
  } finally {
    await client?.close().catch(() => {});
    if (server && exitCode === undefined) {
      server.kill("SIGTERM");
      try {
        await waitFor("server 終了", 10_000, () => (exitCode !== undefined ? true : undefined));
      } catch {
        server.kill("SIGKILL");
        error ??= new Error("server が SIGTERM で 10s 以内に終了しない");
      }
    }
  }

  // 6. 終了確認
  if (!error) {
    try {
      if (exitCode !== 0) fail(`server の exit code が 0 でない: ${exitCode}`);
      for (const w of ["broker 停止", "終了"]) {
        if (!serverLog.some((l) => l.includes(w))) fail(`server ログに "${w}" が無い`);
      }
      const closed = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(3000),
      }).then(
        () => false,
        () => true,
      );
      if (!closed) fail(`port ${port} がまだ開いている`);
    } catch (e) {
      error = e;
    }
  }
  await rm(dir, { recursive: true, force: true }).catch(() => {});

  if (error) {
    console.error(`E2E NG: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  console.log("E2E OK");
  const keys = ["spawn_worker", "worker_report", "bantou: 起動", "broker 起動", "peer 登録", "孤児回収", "指示受信", "claude 起動", "claude 終了", "返信", "SIGTERM", "broker 停止", "bantou: 終了"];
  console.log(serverLog.filter((l) => keys.some((k) => l.includes(k))).join("\n"));
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error(`E2E NG: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
