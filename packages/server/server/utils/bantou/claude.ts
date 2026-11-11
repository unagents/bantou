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
  /** `--model <値>`。extraArgs の後ろに置き、同じ指定が extraArgs にあればこちらを後勝ちにする。省けば付けない。 */
  model?: string;
  timeoutMs: number;
  /** 生出力（stream-json 全行）の追記先。省けば書かない。 */
  logFile?: string;
  env?: NodeJS.ProcessEnv;
  /** 子プロセス生成直後に呼ぶ。実行中の子の追跡用。 */
  onSpawn?: (child: ChildProcess) => void;
  /** stdout の空でない 1 行ごとに呼ぶ（activity 用）。例外は握る。 */
  onLine?: (line: string) => void;
  /** `--mcp-config <file>`。 */
  mcpConfigFile?: string;
  /** `--append-system-prompt-file <file>`。 */
  appendSystemPromptFile?: string;
  /** allowedTools に足す。 */
  extraAllowedTools?: string[];
}

/** claude の result 行から読んだ、会話の大きさ。読めない項目は null。 */
export interface ResultUsage {
  /** 最後の応答の input + cache_creation + cache_read（claude の式。output は含まない）。 */
  contextTokens: number | null;
  /** 主モデルの contextWindow。 */
  contextWindow: number | null;
}

export type ClaudeRunResult =
  | { ok: true; sessionId: string; resultText: string; durationMs: number; usage?: ResultUsage }
  | {
      ok: false;
      sessionMissing: boolean;
      timedOut: boolean;
      detail: string;
      durationMs: number;
      /** 子が signal で終わった時の signal。 */
      signal?: NodeJS.Signals | null;
      /** claude の出力から取れた error 文（例: "Prompt is too long"）。detail にも含まれる。 */
      errorText?: string;
      usage?: ResultUsage;
    };

/** claude が継続先 session を見つけられない時の文言（実測）。 */
const SESSION_MISSING = "No conversation found with session ID";

/** cap の Bash sandbox を切る `--settings` の値（空白を含めない。argv の " -- " 分割に影響しない）。 */
export const BASH_SANDBOX_OFF_SETTINGS = JSON.stringify({ sandbox: { enabled: false } });

/** claude の引数を組み立てる。 */
export function buildClaudeArgs(o: ClaudeRunOptions): string[] {
  const allowed = [...o.allowedTools, ...(o.extraAllowedTools ?? [])];
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    o.permissionMode,
    ...(allowed.length > 0 ? ["--allowedTools", ...allowed] : []),
    ...(o.disallowedTools.length > 0 ? ["--disallowedTools", ...o.disallowedTools] : []),
    // --settings は値 1 つ。可変長引数（--allowedTools 等）の後でも次のフラグで区切れる。extraArgs の前に置き、同じ指定が extraArgs にあればそちらを後勝ちにする
    ...(o.capBashSandbox === true ? [] : ["--settings", BASH_SANDBOX_OFF_SETTINGS]),
    // 本文を argv に直書きすると " -- " を含む時に孤児回収（matchesSession）が照合できなくなるのでファイルで渡す
    ...(o.mcpConfigFile ? ["--mcp-config", o.mcpConfigFile] : []),
    ...(o.appendSystemPromptFile ? ["--append-system-prompt-file", o.appendSystemPromptFile] : []),
    ...o.extraArgs,
    ...(o.model ? ["--model", o.model] : []),
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

const finiteNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * stream-json の最終行（result envelope）から会話の大きさと error 文を読む。result 行でなければ両方 null。
 * - contextTokens: usage.iterations の最後（最後の応答 1 回分）の input + cache_creation + cache_read。iterations が無ければ null
 *   （usage 本体は run 全体の累計なので使わない）。
 * - contextWindow: modelUsage のうち、トークン合計が最大のモデル（主モデル）の contextWindow。
 * - errorText: is_error の result の result 文、または errors 配列（error_* subtype）。
 */
export function readResultDetails(lastLine: string): { usage: ResultUsage | null; errorText: string | null } {
  const none = { usage: null, errorText: null };
  let d: unknown;
  try {
    d = JSON.parse(lastLine);
  } catch {
    return none;
  }
  if (typeof d !== "object" || d === null || Array.isArray(d)) return none;
  const e = d as Record<string, unknown>;
  if (e.type !== "result") return none;
  let contextTokens: number | null = null;
  const u = e.usage as { iterations?: unknown } | null | undefined;
  if (u && Array.isArray(u.iterations) && u.iterations.length > 0) {
    const it = u.iterations[u.iterations.length - 1] as Record<string, unknown> | null;
    if (it && typeof it === "object") {
      const a = finiteNum(it.input_tokens);
      const b = finiteNum(it.cache_creation_input_tokens);
      const c = finiteNum(it.cache_read_input_tokens);
      if (a !== null || b !== null || c !== null) contextTokens = (a ?? 0) + (b ?? 0) + (c ?? 0);
    }
  }
  let contextWindow: number | null = null;
  const mu = e.modelUsage;
  if (mu && typeof mu === "object" && !Array.isArray(mu)) {
    let best = -1;
    for (const v of Object.values(mu as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const m = v as Record<string, unknown>;
      const total = (finiteNum(m.inputTokens) ?? 0) + (finiteNum(m.outputTokens) ?? 0) + (finiteNum(m.cacheReadInputTokens) ?? 0) + (finiteNum(m.cacheCreationInputTokens) ?? 0);
      const w = finiteNum(m.contextWindow);
      if (w !== null && w > 0 && total > best) {
        best = total;
        contextWindow = w;
      }
    }
  }
  let errorText: string | null = null;
  if (e.is_error === true || (typeof e.subtype === "string" && e.subtype !== "success")) {
    if (typeof e.result === "string" && e.result.trim() !== "") errorText = e.result.trim();
    else if (Array.isArray(e.errors)) {
      const t = e.errors.filter((x): x is string => typeof x === "string" && x.trim() !== "").join("; ");
      if (t !== "") errorText = t;
    }
  }
  return {
    usage: contextTokens !== null || contextWindow !== null ? { contextTokens, contextWindow } : null,
    errorText,
  };
}

/**
 * 子へ signal を送る。子は detached（setsid、pgid = pid）で起動するので process group ごと送り、
 * 孫まで止める。group が無い・pid が無い場合は子 1 本へ送る。
 */
export function killGroup(child: Pick<ChildProcess, "pid" | "kill">, signal: NodeJS.Signals): void {
  if (child.pid !== undefined && child.pid > 1) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ESRCH" && code !== "EPERM") throw e;
    }
  }
  child.kill(signal);
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
    const fail = (
      detail: string,
      extra: { sessionMissing?: boolean; timedOut?: boolean; signal?: NodeJS.Signals | null; errorText?: string; usage?: ResultUsage } = {},
    ): void =>
      finish({
        ok: false,
        sessionMissing: extra.sessionMissing ?? false,
        timedOut: extra.timedOut ?? false,
        detail,
        durationMs: Date.now() - started,
        ...(extra.signal ? { signal: extra.signal } : {}),
        ...(extra.errorText !== undefined ? { errorText: extra.errorText } : {}),
        ...(extra.usage ? { usage: extra.usage } : {}),
      });

    let child: ChildProcess;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child) killGroup(child, "SIGKILL");
    }, o.timeoutMs);

    try {
      child = spawn(o.claude, buildClaudeArgs(o), {
        cwd: o.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: o.env ?? process.env,
        detached: true,
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
      try {
        o.onLine?.(line);
      } catch {
        // activity の失敗で実行を壊さない
      }
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

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
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
        const details = readResultDetails(last);
        const extra = {
          ...(details.errorText !== null ? { errorText: details.errorText } : {}),
          ...(details.usage ? { usage: details.usage } : {}),
        };
        // 「終了コード 1」だけにしない: claude の result 行の error 文（例: Prompt is too long）を添える
        const withText = (base: string): string => (details.errorText !== null && !base.includes(details.errorText) ? `${base}: ${details.errorText}` : base);
        if (code !== 0) {
          fail(withText(stderr.trim() || (signal ? `signal ${signal} で終了` : `終了コード ${code}`)), {
            sessionMissing: missing,
            signal,
            ...extra,
          });
          return;
        }
        const env = readResultEnvelope(last);
        if (env === null) {
          fail(withText("応答が成功として読み取れない"), { sessionMissing: missing, ...extra });
          return;
        }
        finish({
          ok: true,
          sessionId: env.sessionId ?? o.sessionId,
          resultText: env.resultText,
          durationMs: Date.now() - started,
          ...(details.usage ? { usage: details.usage } : {}),
        });
      })();
    });
  });
}
