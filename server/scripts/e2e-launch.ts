/**
 * e2e: bantou-server を実起動し、messenger 経由で kick_cap / status を検証する。
 * claude を実際に 2 回起動する（数分かかる）。claude のログインを使う。
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
  await writeFile(
    cfgPath,
    JSON.stringify({
      workspace: ws,
      broker: { port: 0, bind: "127.0.0.1", discovery: "off", token: "" },
      session: { timeoutMs: RUN_TIMEOUT },
    }),
  );

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("AGENT_MESSENGER_")) delete env[k];

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

    // 3. status
    await send({ bantou: 1, type: "status" });
    const st = await nextReply("status_result", 15_000);
    if (st.type !== "status_result") fail(`status_result でない: ${JSON.stringify(st)}`);
    const cap = st.caps.find((c) => c.id === capId);
    if (!cap) fail(`status に cap が無い: ${JSON.stringify(st)}`);
    if (cap.state !== "idle") fail(`status の ${cap.id} が idle でない: ${cap.state}`);
    if (cap.queued !== 0) fail(`status の ${cap.id} の queued が 0 でない: ${cap.queued}`);

    // 4. 非コマンドは無視される
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

  // 5. 終了確認
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
  const keys = ["bantou: 起動", "broker 起動", "peer 登録", "孤児回収", "指示受信", "claude 起動", "claude 終了", "返信", "SIGTERM", "broker 停止", "bantou: 終了"];
  console.log(serverLog.filter((l) => keys.some((k) => l.includes(k))).join("\n"));
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error(`E2E NG: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
