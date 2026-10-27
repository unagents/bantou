/**
 * e2e: 本物の bantou-server と、claude の代わりの stub remote-control を使って center を検証する。
 * - rc_start / 切断復帰(--continue) / rc_stop / rc_list
 * - cap_kick（claude を 1 回起動する。claude のログインを使う）/ server_status
 * - stdin EOF で center が自分で終了する
 * `E2E_ROOT` で一時ディレクトリの親を変更できる。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const centerDir = fileURLToPath(new URL("..", import.meta.url));
const serverDir = "/home/vagrant/work/bantou/develop/server";
const RUN_TIMEOUT = 300_000;
const TOOLS = ["cap_kick", "rc_list", "rc_start", "rc_status", "rc_stop", "server_list", "server_status", "worker_resume"];

const serverLog: string[] = [];
const centerLog: string[] = [];

async function waitFor<T>(what: string, ms: number, fn: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`タイムアウト: ${what} (${ms}ms)`);
    await sleep(100);
  }
}

function fail(msg: string): never {
  throw new Error(msg);
}

const STUB = `#!/usr/bin/env node
// claude remote-control の代役。引数は無視する。
const pid = process.pid;
console.log("stub remote-control argv: " + process.argv.slice(2).join(" "));
process.on("SIGTERM", () => {
  console.log("bye");
  process.exit(0);
});
setInterval(() => {}, 1 << 30);
// 初回確認のプロンプトを出し、stdin に y が来るまで Connected を出さない
process.stdout.write("Enable Remote Control? (y/n)");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  input += d;
  if (!/^y\\n/.test(input) || input === "done") return;
  input = "done";
  console.log("");
  console.log("Connected");
  console.log("https://claude.ai/code/session_stub" + pid);
  console.log("https://claude.ai/code?environment=env_stub" + pid);
  const after = Number(process.env.RC_STUB_EXIT_AFTER_MS);
  if (after > 0) setTimeout(() => process.exit(3), after);
});
`;

interface Rc {
  state: string;
  pid: number | null;
  sessionUrl: string | null;
  environmentUrl: string | null;
  restarts: number;
}

async function main(): Promise<void> {
  const root = process.env.E2E_ROOT ?? tmpdir();
  const dir = await mkdtemp(join(root, "bantou-center-e2e-"));
  const ws = join(dir, "ws");
  const proj = join(dir, "proj");
  const logs = join(dir, "logs");
  const stub = join(dir, "rc-stub.mjs");
  const serverCfg = join(dir, "server.json");
  const centerCfg = join(dir, "center.json");
  const capId = `e2e-cap-${process.pid}`;

  let server: ChildProcess | undefined;
  let serverExit: number | null | undefined;
  let client: Client | undefined;
  let error: unknown;
  let port = 0;

  try {
    await mkdir(proj, { recursive: true });
    await writeFile(stub, STUB);
    await chmod(stub, 0o755);

    // 本物の bantou-server
    await writeFile(
      serverCfg,
      JSON.stringify({
        workspace: ws,
        broker: { port: 0, bind: "127.0.0.1", discovery: "off" },
        session: { timeoutMs: RUN_TIMEOUT },
      }),
    );
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith("AGENT_MESSENGER_")) delete env[k];
    server = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "--config", serverCfg], {
      cwd: serverDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.on("exit", (code) => {
      serverExit = code;
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

    // center
    await writeFile(
      centerCfg,
      JSON.stringify({
        projects: [{ name: "e2e-proj", path: proj, autostart: false }],
        remoteControl: { claude: stub, restartDelayMs: 500, maxRestarts: 2, stopGraceMs: 2000 },
        servers: [{ name: "local", broker: `http://127.0.0.1:${port}` }],
        logDir: logs,
      }),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/cli.ts", "--config", centerCfg],
      cwd: centerDir,
      env: { ...(process.env as Record<string, string>), RC_STUB_EXIT_AFTER_MS: "3000" },
      stderr: "pipe",
    });
    let cbuf = "";
    const cerr = transport.stderr as Readable | null;
    cerr?.setEncoding("utf8");
    cerr?.on("data", (chunk: string) => {
      cbuf += chunk;
      const lines = cbuf.split("\n");
      cbuf = lines.pop() ?? "";
      for (const l of lines) {
        centerLog.push(l);
        console.log(`[center] ${l}`);
      }
    });
    client = new Client({ name: "bantou-center-e2e", version: "0.0.0" });
    await client.connect(transport);

    const call = async (name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; json: any }> => {
      const r = (await client!.callTool({ name, arguments: args }, undefined, { timeout: RUN_TIMEOUT + 60_000 })) as {
        isError?: boolean;
        content: { type: string; text: string }[];
      };
      return { isError: r.isError === true, json: JSON.parse(r.content[0].text) };
    };
    const rcStatus = async (): Promise<Rc> => (await call("rc_status", { project: "e2e-proj" })).json as Rc;

    // 4. tool 一覧
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    if (JSON.stringify(names) !== JSON.stringify(TOOLS)) fail(`tool 一覧が想定と違う: ${names.join(",")}`);

    // 5. remote-control
    const started = await call("rc_start", { project: "e2e-proj" });
    if (started.isError) fail(`rc_start 失敗: ${JSON.stringify(started.json)}`);
    let st = await waitFor("rc connected", 10_000, async () => {
      const s = await rcStatus();
      return s.state === "connected" ? s : undefined;
    });
    if (!st.sessionUrl || !st.environmentUrl || !st.pid) fail(`URL / pid が揃わない: ${JSON.stringify(st)}`);
    // stub が 3 秒後に落ちる → --continue で再起動
    st = await waitFor("rc 再起動", 10_000, async () => {
      const s = await rcStatus();
      return s.restarts === 1 && s.state === "connected" ? s : undefined;
    });
    const rcLog = await readFile(join(logs, "e2e-proj.log"), "utf8");
    if (!rcLog.includes("--continue")) fail(`remote-control ログに --continue が無い: ${rcLog}`);
    const stopped = await call("rc_stop", { project: "e2e-proj" });
    if (stopped.json.state !== "stopped") fail(`rc_stop 後が stopped でない: ${JSON.stringify(stopped.json)}`);
    const list = (await call("rc_list")).json as (Rc & { project: string })[];
    if (!list.some((p) => p.project === "e2e-proj" && p.state === "stopped")) {
      fail(`rc_list に stopped の e2e-proj が無い: ${JSON.stringify(list)}`);
    }

    // 6. server 経由
    const servers = (await call("server_list")).json as { name: string; connected: boolean; reachable: boolean }[];
    const local = servers.find((s) => s.name === "local");
    if (!local || !local.reachable || !local.connected) fail(`server_list: ${JSON.stringify(servers)}`);
    const kick = await call("cap_kick", {
      server: "local",
      cap_id: capId,
      prompt: "Run `echo kicked` in Bash and reply with only the command output on one line.",
      reason: "e2e",
    });
    if (kick.isError || kick.json.type !== "cap_result" || kick.json.ok !== true) {
      fail(`cap_kick が cap_result(ok) でない: ${JSON.stringify(kick.json)}`);
    }
    if (!String(kick.json.result_text).includes("kicked")) fail(`result_text に kicked が無い: ${kick.json.result_text}`);
    const status = await call("server_status", { server: "local" });
    const cap = (status.json.caps ?? []).find((c: { id: string }) => c.id === capId);
    if (status.json.type !== "status_result" || !cap || cap.state !== "idle") {
      fail(`server_status に idle の ${capId} が無い: ${JSON.stringify(status.json)}`);
    }

    // 7. stdin EOF で center が自分で終了する
    await client.close();
    client = undefined;
    await waitFor("center 終了", 15_000, () => centerLog.find((l) => l.endsWith("bantou-center: 終了")));
    // SDK の close() は 2 秒後に SIGTERM を送るので、終了しただけでは stdin EOF 経由とは限らない
    if (!centerLog.some((l) => l.includes("終了開始: stdin EOF"))) {
      fail(`stdin EOF で終了していない（終了開始のログが stdin EOF でない）: ${centerLog.filter((l) => l.includes("終了開始")).join(" | ")}`);
    }
  } catch (e) {
    error = e;
  } finally {
    await client?.close().catch(() => {});
    if (server && serverExit === undefined) {
      server.kill("SIGTERM");
      try {
        await waitFor("server 終了", 10_000, () => (serverExit !== undefined ? true : undefined));
      } catch {
        server.kill("SIGKILL");
        error ??= new Error("server が SIGTERM で 10s 以内に終了しない");
      }
    }
  }

  if (!error && serverExit !== 0) error = new Error(`server の exit code が 0 でない: ${serverExit}`);
  await rm(dir, { recursive: true, force: true }).catch(() => {});

  if (error) {
    console.error(`E2E NG: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  console.log("E2E OK");
  const ck = ["起動", "設定読込", "MCP stdio 接続", "server 接続", "remote-control 起動", "remote-control 接続", "remote-control 終了", "再起動予約", "指示送信", "終了開始", "bantou-center: 終了"];
  console.log(centerLog.filter((l) => ck.some((k) => l.includes(k))).join("\n"));
  const sk = ["指示受信", "claude 起動", "claude 終了", "返信", "bantou: 終了"];
  console.log(serverLog.filter((l) => sk.some((k) => l.includes(k))).join("\n"));
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error(`E2E NG: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
