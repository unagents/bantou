/**
 * 計測: cap（claude -p）が起動したプロセスが cap の終了後も生き残るか（setsid 無し / 有り）。
 * server の kick_cap 経由で測る（端末から直接 claude -p を起動すると session / pgid が違い、結果が流用できない）。
 * 終了後に残った probe プロセスの ps を出して kill する。`E2E_CLAUDE_CONFIG_DIR` / `E2E_ROOT` は e2e と同じ。
 * 追加で `PROBE_SIGTERM=1` なら、cap の実行中に server へ SIGTERM を送り、server 終了後に probe が残るかも測る。
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMessengerClient } from "@unagents/messenger-client";
import { parseServerReply, SERVER_NAME, type ServerReply } from "@agent-hand/bantou-protocol";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const serverDir = fileURLToPath(new URL("..", import.meta.url));
// 正規表現の [b] で、このパターンを含むコマンド行（シェル・pgrep 自身）に一致しないようにする
const PATTERN = "^[b]antou-probe-(plain|setsid) 600$";
const sigterm = process.env.PROBE_SIGTERM === "1";

function probes(): string {
  try {
    const pids = execFileSync("pgrep", ["-f", PATTERN], { encoding: "utf8" }).split("\n").filter(Boolean);
    if (pids.length === 0) return "";
    // pid ppid pgid sid args（外から見た値）
    return execFileSync("ps", ["-o", "pid,ppid,pgid,sid,args", "-p", pids.join(",")], { encoding: "utf8" }).trimEnd();
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  // server は URL を指名せず通常の解決で繋ぐ。テストでは自前 broker の空き port を先に決め、env（解決の 1 段目）でそこへ向ける（テスト専用の上書き）
  const brokerPort = await new Promise<number>((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });
  const dir = await mkdtemp(join(process.env.E2E_ROOT ?? tmpdir(), "bantou-prb-"));
  const cfgPath = join(dir, "config.json");
  await writeFile(
    cfgPath,
    JSON.stringify({
      workspace: join(dir, "ws"),
      broker: { port: brokerPort, bind: "127.0.0.1", discovery: "off", token: "" },
      mcp: { port: 0, bind: "127.0.0.1" },
      session: {
        extraArgs: [
          "--strict-mcp-config",
          ...(process.env.E2E_MODEL ? ["--model", process.env.E2E_MODEL] : []),
        ],
        // 既定（未設定）は sandbox を切る。E2E_CAP_BASH_SANDBOX=1 で sandbox 有効のまま計測する
        capBashSandbox: process.env.E2E_CAP_BASH_SANDBOX === "1",
        env: process.env.E2E_CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: process.env.E2E_CLAUDE_CONFIG_DIR } : {},
      },
    }),
  );
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("AGENT_MESSENGER_") || k.startsWith("CLAUDE_CODE_MESSAGING_")) delete env[k];
  }
  env.AGENT_MESSENGER_HOST = "127.0.0.1";
  env.AGENT_MESSENGER_PORT = String(brokerPort);
  env.AGENT_MESSENGER_DISCOVERY = "off";
  const lines: string[] = [];
  const server: ChildProcess = spawn(process.execPath, ["bin/bantou.mjs", "--config", cfgPath], {
    cwd: serverDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let exited = false;
  server.on("exit", () => {
    exited = true;
  });
  for (const s of [server.stdout, server.stderr]) {
    let buf = "";
    s?.setEncoding("utf8");
    s?.on("data", (c: string) => {
      buf += c;
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const l of parts) {
        lines.push(l);
        if (!l.includes("messenger:")) console.log(`[server] ${l}`);
      }
    });
  }
  const waitLine = async (what: string, ms: number): Promise<string> => {
    const end = Date.now() + ms;
    for (;;) {
      const l = lines.find((x) => x.includes(what));
      if (l) return l;
      if (Date.now() > end) throw new Error(`タイムアウト: ${what}`);
      await sleep(100);
    }
  };
  let client: ReturnType<typeof createMessengerClient> | undefined;
  try {
    const port = Number(/broker 起動: port=(\d+)/.exec(await waitLine("broker 起動: port=", 20_000))?.[1]);
    await waitLine("peer 登録:", 20_000);
    const replies: ServerReply[] = [];
    client = createMessengerClient({
      env: { AGENT_MESSENGER_DISCOVERY: "off" },
      name: "bantou-probe-sender",
      brokers: [`http://127.0.0.1:${port}`],
      autoStartBroker: false,
      log: () => {},
    });
    client.onMessage((m) => {
      const r = parseServerReply(m.text);
      if (r) replies.push(r);
    });
    await client.connect();
    const before = probes();
    if (before) throw new Error(`既に probe が居る:\n${before}`);

    const prompt =
      "With the Bash tool run exactly these two commands in ONE Bash call, then reply with the raw output only and end your turn at once " +
      "(do NOT use run_in_background, do NOT wait):\n\n" +
      "bash -c 'exec -a bantou-probe-plain sleep 600' </dev/null >/dev/null 2>&1 &\n" +
      "echo plain: $(ps -o pid,ppid,pgid,sid,args -p $! | tail -n 1)\n" +
      "setsid bash -c 'exec -a bantou-probe-setsid sleep 600' </dev/null >/dev/null 2>&1 &\n" +
      "echo setsid: $(ps -o pid,ppid,pgid,sid,args -p $! | tail -n 1)";
    const t0 = Date.now();
    await client.send(SERVER_NAME, JSON.stringify({ bantou: 1, type: "kick_cap", cap_id: `probe-${process.pid}`, prompt }));
    if (sigterm) {
      await sleep(1500);
      // cap の実行中に SIGTERM（server は cap の pid を SIGKILL する）
      await waitLine("claude 起動:", 20_000);
      const seen = await (async () => {
        for (let i = 0; i < 100; i++) {
          if (probes()) return probes();
          await sleep(300);
        }
        return "";
      })();
      console.log(`[probe] cap 実行中の probe:\n${seen}`);
      server.kill("SIGTERM");
      const end = Date.now() + 15_000;
      while (!exited && Date.now() < end) await sleep(100);
      console.log(`[probe] server exited=${exited} ms=${Date.now() - t0}`);
    } else {
      const end = Date.now() + 300_000;
      while (replies.length === 0 && Date.now() < end) await sleep(200);
      const r = replies[0];
      console.log(`[probe] cap 所要 ${Date.now() - t0}ms reply=${JSON.stringify(r)}`);
      await sleep(2000);
    }
    console.log(`[probe] cap 終了後の probe:\n${probes() || "(なし)"}`);
  } finally {
    await client?.close().catch(() => {});
    if (!exited) {
      server.kill("SIGTERM");
      await sleep(3000);
      if (!exited) server.kill("SIGKILL");
    }
    try {
      execFileSync("pkill", ["-f", PATTERN]);
    } catch {
      // 残っていなければ pkill は 1 を返す
    }
    await sleep(500);
    console.log(`[probe] 後始末後の probe: ${probes() || "(なし)"}`);
    if (process.env.PROBE_KEEP === "1") console.log(`[probe] dir=${dir}`);
    else await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((e: unknown) => {
  console.error(`PROBE NG: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
