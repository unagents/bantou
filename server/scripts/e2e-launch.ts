/**
 * e2e: bantou-server を実起動し、messenger 経由で launch_session / list_sessions を検証する。
 * 要 tmux と claude。`E2E_ROOT` で一時ディレクトリの親を変更できる。
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createMessengerClient } from "@unagents/messenger-client";
import { parseServerReply, SERVER_NAME, type ServerReply } from "@agent-hand/bantou-protocol";

const run = promisify(execFile);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const serverDir = fileURLToPath(new URL("..", import.meta.url));

const serverLog: string[] = [];
const replies: ServerReply[] = [];

function sh(text: string): string {
  return text.replace(/\n+$/, "");
}

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

async function main(): Promise<void> {
  const root = process.env.E2E_ROOT ?? tmpdir();
  const dir = await mkdtemp(join(root, "bantou-e2e-"));
  const ws = join(dir, "ws");
  const name = `bantou-e2e-${process.pid}`;
  const cfgPath = join(dir, "config.json");
  await writeFile(
    cfgPath,
    JSON.stringify({
      workspace: ws,
      broker: { port: 0, bind: "127.0.0.1", discovery: "off", token: "" },
    }),
  );

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("AGENT_MESSENGER_")) delete env[k];
  delete env.TMUX;

  let server: ChildProcess | undefined;
  let exitCode: number | null | undefined;
  let client: ReturnType<typeof createMessengerClient> | undefined;
  let port = 0;
  let capture = "";
  let error: unknown;

  try {
    server = spawn(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "--config", cfgPath],
      { cwd: serverDir, env, stdio: ["ignore", "pipe", "pipe"] },
    );
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

    // 1. launch
    await send({ bantou: 1, type: "launch_session", name });
    const launched = await nextReply("session_launched", 30_000);
    if (launched.type !== "session_launched") fail(`session_launched でない: ${JSON.stringify(launched)}`);
    if (!launched.ok) fail("ok でない");
    if (launched.tmux !== name) fail(`tmux 名が不一致: ${launched.tmux}`);
    if (launched.cwd !== join(ws, "repos", name)) fail(`cwd が不一致: ${launched.cwd}`);

    // 2. claude の起動画面を待つ
    const end = Date.now() + 60_000;
    let matched = false;
    while (Date.now() < end) {
      try {
        const { stdout } = await run("tmux", ["capture-pane", "-p", "-t", `=${name}:`]);
        capture = stdout;
        if (/❯/.test(stdout) || /trust/i.test(stdout)) {
          matched = true;
          break;
        }
      } catch (e) {
        capture = `capture 失敗: ${(e as Error).message}`;
      }
      await sleep(1000);
    }
    if (!matched) fail("claude の起動画面 (❯ / trust) を 60s 以内に確認できない");

    // 3. list
    await send({ bantou: 1, type: "list_sessions" });
    const list = await nextReply("sessions", 15_000);
    if (list.type !== "sessions") fail(`sessions でない: ${JSON.stringify(list)}`);
    if (!list.sessions.some((s) => s.name === name)) fail("sessions に起動した session が無い");

    // 4. 重複 launch は error
    await send({ bantou: 1, type: "launch_session", name });
    const dup = await nextReply("error (重複)", 30_000);
    if (dup.type !== "error") fail(`error でない: ${JSON.stringify(dup)}`);

    // 5. 非コマンドは無視される
    await client.send(SERVER_NAME, "hello");
    await sleep(3000);
    if (replies.length > 0) fail(`非コマンドに返信が来た: ${JSON.stringify(replies)}`);
    await waitFor("無視ログ", 5000, () => serverLog.find((l) => l.includes("無視:")));
  } catch (e) {
    error = e;
  } finally {
    await run("tmux", ["kill-session", "-t", `=${name}`]).catch(() => {});
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
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

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

  if (error) {
    console.error(`E2E NG: ${error instanceof Error ? error.message : String(error)}`);
    if (capture) console.error(`--- tmux capture (last)\n${sh(capture).split("\n").slice(-30).join("\n")}`);
    process.exit(1);
  }

  console.log("E2E OK");
  const keys = ["起動", "broker 起動", "peer 登録", "指示受信", "tmux 作成", "返信", "SIGTERM", "broker 停止", "終了"];
  const excerpt = serverLog.filter((l) => keys.some((k) => l.includes(`bantou: ${k}`) || l.includes(k)));
  console.log(excerpt.join("\n"));
  console.log(`--- tmux capture (last)\n${sh(capture).split("\n").slice(-30).join("\n")}`);
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error(`E2E NG: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
