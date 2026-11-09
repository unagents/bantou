import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Logger } from "./log.js";

/** login shell への問い合わせの待ち上限。 */
export const PATH_LOGIN_SHELL_TIMEOUT_MS = 5000;

/** login shell の出力から PATH を取り出す目印（rc ファイルの余計な出力が混ざっても拾えるようにする）。 */
export const PATH_BEGIN = "__BANTOU_PATH_BEGIN__";
export const PATH_END = "__BANTOU_PATH_END__";

export type PathSource = "login-shell" | "fixed-list" | "unchanged";

export interface PathResolveDeps {
  /** コマンドを実行して stdout を返す。失敗・タイムアウトは reject。 */
  exec: (file: string, args: string[], timeoutMs: number) => Promise<string>;
  /** 実在するディレクトリか。 */
  isDir: (path: string) => boolean;
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
}

export const defaultPathResolveDeps = (): PathResolveDeps => ({
  exec: (file, args, timeoutMs) =>
    new Promise((resolve, reject) => {
      execFile(file, args, { timeout: timeoutMs, encoding: "utf8" }, (err, stdout) =>
        err ? reject(err) : resolve(stdout),
      );
    }),
  isDir: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  env: process.env,
  home: homedir(),
  platform: process.platform,
});

/** 補う候補（優先順）。macOS は Homebrew 系 + home 配下、Linux は home 配下のみ。それ以外の OS は空。 */
export const fixedPathCandidates = (platform: NodeJS.Platform, home: string): string[] => {
  const homeDirs = home ? [join(home, ".local", "bin"), join(home, ".cargo", "bin"), join(home, ".bun", "bin")] : [];
  if (platform === "darwin") return ["/opt/homebrew/bin", "/usr/local/bin", ...homeDirs];
  if (platform === "linux") return homeDirs;
  return [];
};

const splitPath = (p: string | undefined): string[] => (p ?? "").split(":").filter((d) => d !== "");

/**
 * login shell の出力から PATH を取り出す。目印の間の、最後の組を採る。
 * 絶対パスでない要素は捨てる。取り出せない・空なら null。
 */
export function parseLoginShellPath(out: string): string[] | null {
  const re = new RegExp(`${PATH_BEGIN}([^]*?)${PATH_END}`, "g");
  let last: string | null = null;
  for (const m of out.matchAll(re)) last = m[1] ?? "";
  if (last === null) return null;
  const dirs = splitPath(last.trim()).filter((d) => isAbsolute(d));
  return dirs.length > 0 ? dirs : null;
}

/**
 * PATH を合成する（先に出た要素を残す重複排除、空要素は捨てる）。
 * - login shell の PATH が取れた時: login shell の PATH → 現在の PATH → 固定候補のうち存在して未掲載のもの
 * - 取れなかった時: 固定候補のうち存在するもの → 現在の PATH
 * macOS / Linux 以外は現在の PATH をそのまま返す。
 */
export function composePath(opts: {
  current: string | undefined;
  loginPath: string[] | null;
  platform: NodeJS.Platform;
  home: string;
  isDir: (p: string) => boolean;
}): string {
  if (opts.platform !== "darwin" && opts.platform !== "linux") return opts.current ?? "";
  const fixed = fixedPathCandidates(opts.platform, opts.home).filter(opts.isDir);
  const current = splitPath(opts.current);
  const ordered = opts.loginPath ? [...opts.loginPath, ...current, ...fixed] : [...fixed, ...current];
  return [...new Set(ordered)].join(":");
}

/** center の PATH を決める。login shell（$SHELL -lc）は 1 回だけ、失敗・タイムアウトなら固定候補に落ちる。 */
export async function resolveSessionPath(
  log: Logger,
  deps: PathResolveDeps = defaultPathResolveDeps(),
): Promise<{ path: string; source: PathSource }> {
  const current = deps.env.PATH;
  if (deps.platform !== "darwin" && deps.platform !== "linux") return { path: current ?? "", source: "unchanged" };

  const shell = deps.env.SHELL || "/bin/sh";
  let loginPath: string[] | null = null;
  try {
    const out = await deps.exec(
      shell,
      ["-lc", `printf '${PATH_BEGIN}%s${PATH_END}' "$PATH"`],
      PATH_LOGIN_SHELL_TIMEOUT_MS,
    );
    loginPath = parseLoginShellPath(out);
    if (!loginPath) log(`login shell の PATH が使えない。固定候補で補う: shell=${shell}`);
  } catch (e) {
    log(`login shell での PATH 取得に失敗。固定候補で補う: shell=${shell} ${e instanceof Error ? e.message : String(e)}`);
  }
  const path = composePath({ current, loginPath, platform: deps.platform, home: deps.home, isDir: deps.isDir });
  const source: PathSource = loginPath ? "login-shell" : "fixed-list";
  log(`PATH を補った (source=${source}): ${path}`);
  return { path, source };
}
