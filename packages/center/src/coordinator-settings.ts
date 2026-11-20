/**
 * 統括の session の設定の保存先と CLI（`bantou-center coordinator`）。
 *
 * 統括の session（どの session に統括の道具と指示文の部品を付けるか）は center の側だけで扱う。
 * MCP（画面・web・master-cap の設定更新）からは読み書きしない。
 * 保存先は center の状態 dir（config と同じ dir）の `coordinator-settings.json`（`{ "session": "<名前>" }`）。center は書かず、CLI だけが書く。
 * center は道具が呼ばれるたびと session の起動のたびに読む（変更時刻が変わった時だけ読み直す）。
 */
import { readFileSync, renameSync, statSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { coordinatorSchema, readCoordinator } from "./project-settings.js";
import { SESSION_NAME } from "./sessions.js";

export const COORDINATOR_SETTINGS_FILE = "coordinator-settings.json";

export interface CoordinatorFile {
  readonly path: string;
  /** 統括の session の名前（無い・壊れていれば null = 無効）。 */
  read(): string | null;
  /** 設定する（null で消す）。 */
  write(session: string | null): void;
}

let tmpSeq = 0;

export function createCoordinatorFile(stateDir: string, log: (m: string) => void = () => {}): CoordinatorFile {
  const path = join(stateDir, COORDINATOR_SETTINGS_FILE);
  let cache: { key: string; value: string | null } | undefined;
  return {
    path,
    read() {
      let key: string;
      try {
        const st = statSync(path);
        key = `${st.mtimeMs}:${st.size}:${st.ino}`;
      } catch {
        cache = undefined;
        return null;
      }
      if (cache?.key === key) return cache.value;
      let value: string | null;
      try {
        value = readCoordinator(JSON.parse(readFileSync(path, "utf8")));
      } catch (e) {
        log(`統括の設定ファイルを読めない（無効として扱う）: ${path} ${e instanceof Error ? e.name : "error"}`);
        value = null;
      }
      cache = { key, value };
      return value;
    },
    write(session) {
      cache = undefined;
      if (session === null) {
        rmSync(path, { force: true });
        return;
      }
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(coordinatorSchema.parse({ session }), null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}

// ---- CLI ----

export const COORDINATOR_USAGE_TEXT = `usage:
  bantou-center coordinator get   [--config <path>]
  bantou-center coordinator set   <session 名> [--config <path>]
  bantou-center coordinator unset [--config <path>]
set は存在する session だけ受け付ける。統括の session は 1 つだけ。
効き方: 統括の道具は呼ばれた時に設定を見直すので次の呼び出しから。指示文の部品は統括の session の次の起動から（動いている session は起動し直さない）。`;

export const COORDINATOR_EFFECT = "（道具は次の呼び出しから、指示文の部品は統括の session の次の起動から効く）";

export interface CoordinatorCliDeps {
  /** session が存在するか（sessions.json と config の project）。 */
  sessionExists: (name: string) => boolean;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** `bantou-center coordinator ...` の本体。戻り値は exit code（0 成功、2 使い方の誤り、1 失敗）。 */
export function runCoordinatorCli(argv: string[], defaultConfig: string, deps: CoordinatorCliDeps): number {
  const [action, ...rest] = argv;
  if (action !== "get" && action !== "set" && action !== "unset") {
    deps.err(COORDINATOR_USAGE_TEXT);
    return 2;
  }
  let config = defaultConfig;
  const positional: string[] = [];
  try {
    for (let i = 0; i < rest.length; i++) {
      const k = rest[i];
      if (k === "--config") {
        if (i + 1 >= rest.length) throw new Error("--config に値が無い");
        config = rest[++i];
      } else if (k.startsWith("--")) throw new Error(`不明な引数: ${/^--[A-Za-z][A-Za-z0-9-]*/.exec(k)?.[0] ?? "--"}`);
      else positional.push(k);
    }
    if (action === "set") {
      if (positional.length !== 1) throw new Error("set には session 名を 1 つ指定する");
      if (!SESSION_NAME.test(positional[0])) throw new Error("session は英数字と _ - のみ");
    } else if (positional.length > 0) throw new Error(`${action} に位置引数は要らない`);
  } catch (e) {
    deps.err(e instanceof Error ? e.message : String(e));
    deps.err(COORDINATOR_USAGE_TEXT);
    return 2;
  }
  const file = createCoordinatorFile(dirname(resolve(config)));
  try {
    const current = file.read();
    if (action === "get") {
      deps.out(`統括の session: ${current ?? "未設定"}`);
      return 0;
    }
    if (action === "unset") {
      file.write(null);
      deps.out(`統括の session の設定を消した${current === null ? "（元から無い）" : ""}${COORDINATOR_EFFECT}`);
      return 0;
    }
    const name = positional[0];
    if (!deps.sessionExists(name)) {
      deps.err(`session が存在しない: ${name}（先に作る。置き場: ${dirname(resolve(config))}）`);
      return 1;
    }
    file.write(name);
    deps.out(`統括の session: ${name}${current === name ? "（変更なし）" : ""}${COORDINATOR_EFFECT}`);
    return 0;
  } catch (e) {
    deps.err(`失敗: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
