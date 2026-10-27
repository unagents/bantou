import { execFile } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { isValidSessionName, type SessionInfo } from "@agent-hand/bantou-protocol";

const run = promisify(execFile);

export interface LaunchSpec {
  name: string;
  repo?: string;
  branch?: string;
  cwd?: string;
  /** `<workspace>/repos` の絶対パス。 */
  repos: string;
  /** tmux に渡す起動コマンド（shell 経由で実行される）。 */
  command: string;
}

export interface LaunchResult {
  name: string;
  tmux: string;
  cwd: string;
}

/** session の作業ディレクトリを決める。repos 配下のみ許可する。 */
export function resolveCwd(repos: string, name: string, cwd?: string): string {
  const base = resolve(repos);
  const resolved = cwd === undefined ? join(base, name) : resolve(base, cwd);
  if (!inside(base, resolved)) {
    throw new Error("cwd は repos 配下のみ");
  }
  return resolved;
}

function inside(base: string, p: string): boolean {
  return p === base || p.startsWith(base + sep);
}

/** symlink を解決した上でも cwd が repos 配下に収まることを確認する。 */
export async function assertInsideRepos(repos: string, cwd: string): Promise<void> {
  const [r, c] = await Promise.all([realpath(repos), realpath(cwd)]);
  if (!inside(r, c)) throw new Error("cwd は repos 配下のみ");
}

function tmuxEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.TMUX;
  return env;
}

interface ExecError extends Error {
  code?: string | number;
  stderr?: string;
}

/** 外部コマンドを実行する。ENOENT は見つからない旨、その他は stderr 付きで投げる。 */
async function exec(cmd: string, args: string[], label: string): Promise<string> {
  try {
    const { stdout } = await run(cmd, args, { env: tmuxEnv(), encoding: "utf8" });
    return stdout;
  } catch (e) {
    const err = e as ExecError;
    if (err.code === "ENOENT") throw new Error(`${cmd} が見つからない`);
    throw new Error(`${label} 失敗: ${(err.stderr ?? "").trim() || err.message}`);
  }
}

/** tmux session の存在確認。 */
export async function hasSession(name: string): Promise<boolean> {
  try {
    await run("tmux", ["has-session", "-t", `=${name}`], { env: tmuxEnv() });
    return true;
  } catch (e) {
    const err = e as ExecError;
    if (err.code === "ENOENT") throw new Error("tmux が見つからない");
    if (err.code === 1) return false;
    throw new Error(`tmux has-session 失敗: ${(err.stderr ?? "").trim() || err.message}`);
  }
}

/** tmux list-sessions の出力（タブ区切り）を SessionInfo に変換する。 */
export function parseSessions(out: string): SessionInfo[] {
  return out
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => {
      const [name, windows, created, attached] = l.split("\t");
      return {
        name,
        windows: Number(windows),
        created: new Date(Number(created) * 1000).toISOString(),
        attached: Number(attached) > 0,
      };
    });
}

/** tmux session 一覧。server 未起動（session 無し）は空配列。 */
export async function listSessions(): Promise<SessionInfo[]> {
  const fmt = "#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}";
  try {
    const { stdout } = await run("tmux", ["list-sessions", "-F", fmt], {
      env: tmuxEnv(),
      encoding: "utf8",
    });
    return parseSessions(stdout);
  } catch (e) {
    const err = e as ExecError;
    if (err.code === "ENOENT") throw new Error("tmux が見つからない");
    const stderr = err.stderr ?? "";
    if (/no server running|No such file or directory/.test(stderr)) return [];
    throw new Error(`tmux list-sessions 失敗: ${stderr.trim() || err.message}`);
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** repo の取得（clone / fetch）→ cwd 作成 → tmux session 起動。 */
export async function launchSession(spec: LaunchSpec): Promise<LaunchResult> {
  const { name, repo, branch, repos, command } = spec;
  if (!isValidSessionName(name)) throw new Error(`session 名が不正: ${name}`);
  const target = join(resolve(repos), name);
  const cwd = resolveCwd(repos, name, spec.cwd);

  if (await hasSession(name)) throw new Error(`tmux session "${name}" は既に存在する`);

  if (repo) {
    if (await exists(target)) {
      if (!(await exists(join(target, ".git")))) throw new Error(`repos/${name} は git repo でない`);
      await exec("git", ["-C", target, "fetch"], "git fetch");
    } else {
      const args = ["clone", ...(branch ? [`--branch=${branch}`] : []), "--", repo, target];
      await exec("git", args, "git clone");
    }
  }
  await mkdir(cwd, { recursive: true });
  await assertInsideRepos(repos, cwd);

  await exec("tmux", ["new-session", "-d", "-s", name, "-c", cwd, command], "tmux new-session");
  return { name, tmux: name, cwd };
}
