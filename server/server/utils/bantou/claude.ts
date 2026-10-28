import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type RunMode = "new" | "resume";

export interface ClaudeRunOptions {
  /** claude 実行ファイル。 */
  claude: string;
  sessionId: string;
  /** new は `--session-id`、resume は `--resume`。 */
  mode: RunMode;
  prompt: string;
  cwd: string;
  permissionMode: string;
  allowedTools: string[];
  disallowedTools: string[];
  /** true なら `--settings` を足さない（claude の sandbox 設定のまま）。省略は false = sandbox を切る。 */
  capBashSandbox?: boolean;
  /** `--` の前にそのまま付ける。 */
  extraArgs: string[];
  timeoutMs: number;
  /** 生出力（stream-json 全行）の追記先。省けば書かない。 */
  logFile?: string;
  env?: NodeJS.ProcessEnv;
  /** 子プロセス生成直後に呼ぶ。実行中の子の追跡用。 */
  onSpawn?: (child: ChildProcess) => void;
}

export type ClaudeRunResult =
  | { ok: true; sessionId: string; resultText: string; durationMs: number }
  | { ok: false; sessionMissing: boolean; timedOut: boolean; detail: string; durationMs: number };

/** claude が継続先 session を見つけられない時の文言（実測）。 */
const SESSION_MISSING = "No conversation found with session ID";

/** cap の Bash sandbox を切る `--settings` の値（空白を含めない。argv の " -- " 分割に影響しない）。 */
export const BASH_SANDBOX_OFF_SETTINGS = JSON.stringify({ sandbox: { enabled: false } });

/** claude の引数を組み立てる。 */
export function buildClaudeArgs(o: ClaudeRunOptions): string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    o.permissionMode,
    ...(o.allowedTools.length > 0 ? ["--allowedTools", ...o.allowedTools] : []),
    ...(o.disallowedTools.length > 0 ? ["--disallowedTools", ...o.disallowedTools] : []),
    // --settings は値 1 つ。可変長引数（--allowedTools 等）の後でも次のフラグで区切れる。extraArgs の前に置き、同じ指定が extraArgs にあればそちらを後勝ちにする
    ...(o.capBashSandbox === true ? [] : ["--settings", BASH_SANDBOX_OFF_SETTINGS]),
    ...o.extraArgs,
    o.mode === "new" ? "--session-id" : "--resume",
    o.sessionId,
    "--",
    o.prompt,
  ];
}

/** stream-json の最終行（result envelope）を読む。成功以外は null。 */
export function readResultEnvelope(
  lastLine: string,
): { ok: true; sessionId: string | null; resultText: string } | null {
  let d: unknown;
  try {
    d = JSON.parse(lastLine);
  } catch {
    return null;
  }
  if (typeof d !== "object" || d === null || Array.isArray(d)) return null;
  const e = d as Record<string, unknown>;
  if (e.type !== "result" || e.subtype !== "success" || e.is_error === true) return null;
  return {
    ok: true,
    sessionId: typeof e.session_id === "string" ? e.session_id : null,
    resultText: typeof e.result === "string" ? e.result : "",
  };
}

/** claude -p を 1 回起動する。reject しない。 */
export function runClaude(o: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const started = Date.now();
  return new Promise<ClaudeRunResult>((resolve) => {
    let settled = false;
    const finish = (r: ClaudeRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const fail = (detail: string, extra: { sessionMissing?: boolean; timedOut?: boolean } = {}): void =>
      finish({
        ok: false,
        sessionMissing: extra.sessionMissing ?? false,
        timedOut: extra.timedOut ?? false,
        detail,
        durationMs: Date.now() - started,
      });

    let child: ChildProcess;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child?.kill("SIGKILL");
    }, o.timeoutMs);

    try {
      child = spawn(o.claude, buildClaudeArgs(o), {
        cwd: o.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: o.env ?? process.env,
      });
    } catch (e) {
      fail(`claude を起動できない: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    o.onSpawn?.(child);

    // 生出力は届いた行をそのままログへ流す。メモリには最終行だけ持つ。
    // 書き込み失敗は結果に影響させない
    const logStream: Promise<WriteStream | null> = o.logFile
      ? (async () => {
          await mkdir(dirname(o.logFile as string), { recursive: true });
          const ws = createWriteStream(o.logFile as string, { flags: "a" });
          ws.on("error", () => {});
          ws.write(`# ${new Date().toISOString()} mode=${o.mode} session=${o.sessionId}\n`);
          return ws;
        })().catch(() => null)
      : Promise.resolve(null);
    let last = "";
    let pending = "";
    let stderr = "";
    const take = (line: string): void => {
      if (line.trim() === "") return;
      last = line;
      void logStream.then((ws) => ws?.write(line + "\n"));
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      pending += chunk;
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      for (const p of parts) take(p);
    });
    child.stdout?.on("end", () => {
      take(pending);
      pending = "";
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (e: Error) => {
      fail(`claude を起動できない: ${e.message}`);
    });

    child.on("close", (code: number | null) => {
      void (async () => {
        const ws = await logStream;
        if (ws) {
          await new Promise<void>((r) => {
            ws.once("close", () => r());
            ws.once("error", () => r());
            ws.end();
          });
        }
        if (timedOut) {
          fail(`タイムアウト (${o.timeoutMs}ms)`, { timedOut: true });
          return;
        }
        const missing = `${stderr}${last}`.includes(SESSION_MISSING);
        if (code !== 0) {
          fail(stderr.trim() || `終了コード ${code}`, { sessionMissing: missing });
          return;
        }
        const env = readResultEnvelope(last);
        if (env === null) {
          fail("応答が成功として読み取れない", { sessionMissing: missing });
          return;
        }
        finish({
          ok: true,
          sessionId: env.sessionId ?? o.sessionId,
          resultText: env.resultText,
          durationMs: Date.now() - started,
        });
      })();
    });
  });
}
