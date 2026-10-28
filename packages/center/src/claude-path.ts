import { execFile } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Logger } from "./log.js";

/** claude 実行ファイルをどこから決めたか。 */
export type ClaudeSource = "config" | "login-shell" | "fallback-path" | "PATH";

export interface ResolvedClaude {
  path: string;
  source: ClaudeSource;
}

/** login shell への問い合わせの待ち上限。 */
export const LOGIN_SHELL_TIMEOUT_MS = 5000;

export interface ClaudeResolveDeps {
  /** コマンドを実行して stdout を返す。失敗・タイムアウトは reject。 */
  exec: (file: string, args: string[], timeoutMs: number) => Promise<string>;
  /** 実在し実行可能なファイルか。 */
  isExecutable: (path: string) => Promise<boolean>;
  env: NodeJS.ProcessEnv;
  home: string;
}

export const defaultClaudeResolveDeps = (): ClaudeResolveDeps => ({
  exec: (file, args, timeoutMs) =>
    new Promise((resolve, reject) => {
      execFile(file, args, { timeout: timeoutMs, encoding: "utf8" }, (err, stdout) =>
        err ? reject(err) : resolve(stdout),
      );
    }),
  isExecutable: async (path) => {
    try {
      if (!(await stat(path)).isFile()) return false;
      await access(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  env: process.env,
  home: homedir(),
});

/** login shell 経由の探索パス（home 相対と絶対）。 */
export const claudeFallbackPaths = (home: string): string[] => [
  join(home, ".local", "bin", "claude"),
  "/opt/homebrew/bin/claude",
];

/**
 * claude 実行ファイルを決める。優先順: config > login shell の `command -v claude` > 既知パス > PATH 任せの `claude`。
 * config 指定時は検証せずそのまま使う。
 */
export async function resolveClaude(
  configured: string | undefined,
  log: Logger,
  deps: ClaudeResolveDeps = defaultClaudeResolveDeps(),
): Promise<ResolvedClaude> {
  const done = (r: ResolvedClaude): ResolvedClaude => {
    log(`claude 実行ファイル: ${r.path} (source=${r.source})`);
    return r;
  };
  if (configured !== undefined) return done({ path: configured, source: "config" });

  const shell = deps.env.SHELL || "/bin/sh";
  try {
    const out = await deps.exec(shell, ["-lc", "command -v claude"], LOGIN_SHELL_TIMEOUT_MS);
    const last = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
    if (last && isAbsolute(last) && (await deps.isExecutable(last))) return done({ path: last, source: "login-shell" });
    log(`login shell の解決結果が使えない: shell=${shell} out=${JSON.stringify(last ?? "")}`);
  } catch (e) {
    log(`login shell での解決に失敗: shell=${shell} ${e instanceof Error ? e.message : String(e)}`);
  }

  for (const p of claudeFallbackPaths(deps.home)) {
    if (await deps.isExecutable(p)) return done({ path: p, source: "fallback-path" });
  }
  log("警告: claude が見つからない。PATH 任せの `claude` で起動する（GUI 起動では見つからない可能性がある）");
  return done({ path: "claude", source: "PATH" });
}
