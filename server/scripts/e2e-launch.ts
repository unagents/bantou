/**
 * e2e: bantou-server を実起動し、messenger 経由で kick_cap / status / worker 報告（MCP）を検証する。
 * claude を実際に複数回起動する（数分かかる）。claude のログインを使う。
 * `E2E_ROOT` で一時ディレクトリの親を変更できる。`E2E_CLAUDE_CONFIG_DIR` で CLAUDE_CONFIG_DIR を渡す。
 * 安全のため、server・cap・worker は本番 broker に繋がない（AGENT_MESSENGER_* / CLAUDE_CODE_MESSAGING_* を除去し、
 * cap と worker は --strict-mcp-config で他の MCP を載せない）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMessengerClient } from "@unagents/messenger-client";
import { MESSENGER_PROTOCOL, parseServerReply, SERVER_NAME, type ServerReply } from "@agent-hand/bantou-protocol";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const serverDir = fileURLToPath(new URL("..", import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_TIMEOUT = 300_000;

const serverLog: string[] = [];
const replies: ServerReply[] = [];
const replyMetas: Array<{ protocol: string; version: string } | null | undefined> = [];

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
      mcp: { port: 0, bind: "127.0.0.1" },
      session: {
        timeoutMs: RUN_TIMEOUT,
        extraArgs: [
          "--strict-mcp-config",
          ...(process.env.E2E_MODEL ? ["--model", process.env.E2E_MODEL] : []),
        ],
        env: process.env.E2E_CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: process.env.E2E_CLAUDE_CONFIG_DIR } : {},
      },
    }),
  );

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("AGENT_MESSENGER_") || k.startsWith("CLAUDE_CODE_MESSAGING_")) delete env[k];
  }

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
    const mcpLine = await waitFor("mcp 起動", 20_000, () => serverLog.find((l) => l.includes("mcp 起動: url=")));
    const mcpUrl = /mcp 起動: url=(\S+)/.exec(mcpLine)?.[1] ?? fail(`mcp url を取れない: ${mcpLine}`);
    if (!mcpUrl.startsWith("http://127.0.0.1:") || mcpUrl.endsWith(":0/mcp")) fail(`mcp url が不正: ${mcpUrl}`);
    await waitFor("peer 登録", 20_000, () => serverLog.find((l) => l.includes("peer 登録:")));
    const protoLine = await waitFor("protocol 登録", 20_000, () => serverLog.find((l) => l.includes("protocol 登録")));
    if (!protoLine.includes(`protocol 登録: ${MESSENGER_PROTOCOL.protocol}@${MESSENGER_PROTOCOL.version}`)) {
      fail(`protocol 登録に失敗: ${protoLine}`);
    }

    client = createMessengerClient({
      env: { AGENT_MESSENGER_DISCOVERY: "off" },
      name: "bantou-e2e-sender",
      brokers: [`http://127.0.0.1:${port}`],
      autoStartBroker: false,
      log: (m) => console.log(`[client] ${m}`),
    });
    client.onMessage((m) => {
      const r = parseServerReply(m.text);
      if (r) {
        replies.push(r);
        replyMetas.push(m.meta);
      }
    });
    await client.connect();

    // center 相当: protocol で server を発見する（peer 名には頼らない）
    const found = await client.listPeers("all", { protocol: MESSENGER_PROTOCOL.protocol });
    console.log(`[e2e] listPeers(protocol=bantou) = ${JSON.stringify(found.map((p) => ({ id: p.id, name: p.name, protocols: p.protocols })))}`);
    if (found.length !== 1 || found[0].name !== SERVER_NAME) fail(`protocol 発見が想定外: ${JSON.stringify(found)}`);
    if (!found[0].protocols?.some((p) => p.name === MESSENGER_PROTOCOL.protocol && p.version === MESSENGER_PROTOCOL.version)) {
      fail(`発見した peer の protocols が不正: ${JSON.stringify(found[0].protocols)}`);
    }
    const serverId = found[0].id;
    const meta = { protocol: MESSENGER_PROTOCOL.protocol, version: found[0].protocols[0].version };

    // meta 付きで発見した id へ送る。返信にも meta が付くことを nextReply で確認する
    const send = (cmd: object): Promise<unknown> => client!.send(serverId, JSON.stringify(cmd), "pull", meta);
    const nextReply = async (what: string, ms: number): Promise<ServerReply> => {
      const r = await waitFor(what, ms, () => replies.shift());
      const rm = replyMetas.shift();
      console.log(`[e2e] ${what}: type=${r.type} meta=${JSON.stringify(rm)}`);
      if (rm?.protocol !== MESSENGER_PROTOCOL.protocol || rm.version !== MESSENGER_PROTOCOL.version) {
        fail(`${what}: 返信の meta が不正: ${JSON.stringify(rm)}`);
      }
      return r;
    };

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

    // 3. worker 報告: cap が worker を claudep 方式で起動 → worker が MCP で report → cap が resume される
    const workerCap = `${capId}-w`;
    const workerId = "w1";
    // cap の Bash は claude の sandbox 下で動き cwd 以外へ書けないため、log は cap の cwd に置く
    const workerLog = join(ws, "caps", workerCap, "worker.log");
    const mcpConfig = JSON.stringify({
      mcpServers: {
        bantou: {
          type: "http",
          url: mcpUrl,
          headers: { "x-bantou-cap-id": workerCap, "x-bantou-worker-id": workerId },
        },
      },
    });
    const workerPrompt =
      "Run the command echo hi with the Bash tool. Then call the mcp__bantou__report tool with kind=done and text='worker finished: hi'. " +
      "After it returns accepted, end your turn.";
    // --allowedTools / --mcp-config は可変長引数なので、prompt は先頭に置く（後ろに置くと飲み込まれる）
    const launch =
      `setsid claude -p ${JSON.stringify(workerPrompt)} --model ${process.env.E2E_MODEL ?? "sonnet"} ` +
      `--output-format stream-json --verbose --strict-mcp-config --mcp-config '${mcpConfig}' ` +
      "--allowedTools 'Bash,mcp__bantou__report' </dev/null >worker.log 2>&1 &";
    const clientSendAt = Date.now();
    await send({
      bantou: 1,
      type: "kick_cap",
      cap_id: workerCap,
      prompt:
        "You are a cap. With the Bash tool, run exactly this one command (it starts a detached worker; do NOT use run_in_background, do NOT wait for the worker):\n\n" +
        launch +
        "\n\nThen reply with only the word LAUNCHED and end your turn immediately. " +
        "Later you will be resumed with a message 'worker w1 から <kind>: <text>'. When that happens, reply with only: WORKER_REPORT <kind> <text>.",
      reason: "e2e worker",
    });
    const w1 = await nextReply("cap_result (worker 起動)", RUN_TIMEOUT + 30_000);
    if (w1.type !== "cap_result" || !w1.ok) fail(`worker 起動の cap_result が不正: ${JSON.stringify(w1)}`);
    if (!w1.result_text.includes("LAUNCHED")) fail(`result_text に LAUNCHED が無い: ${w1.result_text}`);
    await waitFor("report 受信", 180_000, () =>
      serverLog.find((l) => l.includes("report 受信:") && l.includes(`cap_id=${workerCap}`)),
    );
    const w2 = await nextReply("cap_result (report 起因の resume)", RUN_TIMEOUT + 30_000);
    if (w2.type !== "cap_result" || !w2.ok) fail(`report 起因の cap_result が不正: ${JSON.stringify(w2)}`);
    if (w2.cap_id !== workerCap || w2.session_id !== w1.session_id) fail(`resume 先が違う: ${JSON.stringify(w2)}`);
    if (!w2.result_text.includes("WORKER_REPORT done") || !w2.result_text.includes("hi")) {
      fail(`resume 後の result_text が想定外: ${w2.result_text}`);
    }
    if (!serverLog.some((l) => l.includes("mode=resume") && l.includes(w1.session_id))) {
      fail("report 起因の mode=resume が server ログに無い");
    }
    console.log(`[e2e] worker flow: ${Date.now() - clientSendAt}ms`);

    // 安全確認: worker と cap の system/init で mcp_servers が想定通り（本番 broker 系の MCP が載っていない）
    const initOf = (lines: string[]): { mcp_servers?: Array<{ name: string; status: string }> } | undefined => {
      for (const l of lines) {
        try {
          const j = JSON.parse(l) as { type?: string; subtype?: string; mcp_servers?: Array<{ name: string; status: string }> };
          if (j.type === "system" && j.subtype === "init") return j;
        } catch {
          // JSON でない行は無視
        }
      }
      return undefined;
    };
    const workerInit = initOf((await readFile(workerLog, "utf8")).split("\n"));
    const wNames = (workerInit?.mcp_servers ?? []).map((m) => `${m.name}:${m.status}`);
    console.log(`[e2e] worker init mcp_servers=${JSON.stringify(workerInit?.mcp_servers)}`);
    if (wNames.length !== 1 || wNames[0] !== "bantou:connected") fail(`worker の mcp_servers が bantou のみでない: ${wNames}`);
    const logsDir = join(ws, "caps", workerCap, "logs");
    for (const f of (await readdir(logsDir)).filter((n) => n.endsWith(".jsonl") && UUID.test(n.slice(0, -6)))) {
      const capInit = initOf((await readFile(join(logsDir, f), "utf8")).split("\n"));
      console.log(`[e2e] cap init (${f}) mcp_servers=${JSON.stringify(capInit?.mcp_servers)}`);
      if ((capInit?.mcp_servers ?? []).length !== 0) fail(`cap の mcp_servers が空でない: ${JSON.stringify(capInit?.mcp_servers)}`);
    }

    // 4. status
    await send({ bantou: 1, type: "status" });
    const st = await nextReply("status_result", 15_000);
    if (st.type !== "status_result") fail(`status_result でない: ${JSON.stringify(st)}`);
    const cap = st.caps.find((c) => c.id === capId);
    if (!cap) fail(`status に cap が無い: ${JSON.stringify(st)}`);
    if (cap.state !== "idle") fail(`status の ${cap.id} が idle でない: ${cap.state}`);
    if (cap.queued !== 0) fail(`status の ${cap.id} の queued が 0 でない: ${cap.queued}`);

    // 4b. meta 無しの旧形式（名前宛て）も受ける。返信には meta が付く
    await client.send(SERVER_NAME, JSON.stringify({ bantou: 1, type: "status" }));
    const stLegacy = await nextReply("status_result (meta 無しの旧形式)", 15_000);
    if (stLegacy.type !== "status_result") fail(`旧形式の status_result でない: ${JSON.stringify(stLegacy)}`);

    // 4c. 他 protocol の meta は無視される
    await client.send(serverId, JSON.stringify({ bantou: 1, type: "status" }), "pull", { protocol: "other-proto", version: "1.0.0" });
    await sleep(3000);
    if (replies.length > 0) fail(`他 protocol に返信が来た: ${JSON.stringify(replies)}`);
    await waitFor("他 protocol の無視ログ", 5000, () => serverLog.find((l) => l.includes("無視(他 protocol)")));

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
      for (const w of ["protocol 解除", "mcp 停止", "broker 停止", "終了"]) {
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
  if (error) {
    // 失敗時は調査用に一時 dir（worker.log など）を残す
    console.error(`E2E_DIR=${dir}`);
  } else {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  if (error) {
    console.error(`E2E NG: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  console.log("E2E OK");
  const keys = ["bantou: 起動", "broker 起動", "mcp 起動", "report 受信", "mcp 停止", "peer 登録", "protocol 登録", "protocol 解除", "孤児回収", "指示受信", "claude 起動", "claude 終了", "返信", "SIGTERM", "broker 停止", "bantou: 終了"];
  console.log(serverLog.filter((l) => keys.some((k) => l.includes(k))).join("\n"));
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error(`E2E NG: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
