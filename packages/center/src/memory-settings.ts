/**
 * 外部記憶（memory）の設定の保存先と CLI（`bantou-center memory`）。
 *
 * 外部記憶の url / token / agentId は center の側だけで扱う。MCP（画面・web・master-cap の設定更新）からは読み書きしない。
 * 保存先は center の状態 dir（config と同じ dir）の `memory-settings.json`（mode 0600）。center は書かず、CLI だけが書く。
 * center は session の起動のたびと memory への送信のたびに読む（変更時刻が変わった時だけ読み直す）ので、
 * center が動いている間に CLI で変えても、次に起動する session から効く。
 */
import { chmodSync, readFileSync, renameSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { memorySchema, type MemorySetting } from "./project-settings.js";
import { SESSION_NAME } from "./sessions.js";

export const MEMORY_SETTINGS_FILE = "memory-settings.json";

/** 保存形。common = 全 session 共通、sessions = session ごと（session の値があれば共通は使わない。項目ごとの合成はしない）。 */
export interface MemoryFileData {
  common?: MemorySetting;
  sessions: Record<string, MemorySetting>;
}

export interface MemoryFile {
  readonly path: string;
  /** 現在の内容（無い・壊れていれば空）。 */
  read(): MemoryFileData;
  write(data: MemoryFileData): void;
  /** session の外部記憶（session の値、無ければ共通、どちらも無ければ undefined）。 */
  resolve(session: string): MemorySetting | undefined;
  /**
   * 旧形式から移せなかった値（memory-settings.json に書けなかった時）をこの起動の間だけ使う。file の値が優先。保存はしない。
   */
  useFallback(data: MemoryFileData): void;
}

let tmpSeq = 0;

/** 1 件の検証（壊れていれば undefined）。保存済みの値を読む時に使う。 */
function parseOne(v: unknown): MemorySetting | undefined {
  const r = memorySchema.safeParse(v);
  if (!r.success) return undefined;
  const { url, token, agentId } = r.data;
  return { url, ...(token ? { token } : {}), ...(agentId ? { agentId } : {}) };
}

export function parseMemoryFile(raw: unknown): MemoryFileData {
  const out: MemoryFileData = { sessions: {} };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const o = raw as Record<string, unknown>;
  const common = parseOne(o.common);
  if (common) out.common = common;
  if (typeof o.sessions === "object" && o.sessions !== null && !Array.isArray(o.sessions)) {
    for (const [name, v] of Object.entries(o.sessions)) {
      const m = SESSION_NAME.test(name) ? parseOne(v) : undefined;
      if (m) out.sessions[name] = m;
    }
  }
  return out;
}

export function createMemoryFile(stateDir: string, log: (m: string) => void = () => {}): MemoryFile {
  const path = join(stateDir, MEMORY_SETTINGS_FILE);
  let cache: { key: string; data: MemoryFileData } | undefined;
  let fallback: MemoryFileData | undefined;
  const read = (): MemoryFileData => {
    let key: string;
    try {
      const st = statSync(path);
      key = `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch {
      cache = undefined;
      return { sessions: {} };
    }
    if (cache?.key === key) return cache.data;
    let data: MemoryFileData;
    try {
      data = parseMemoryFile(JSON.parse(readFileSync(path, "utf8")));
    } catch (e) {
      // 値は log に出さない（理由だけ）
      log(`外部記憶の設定ファイルを読めない（無いとして扱う）: ${path} ${e instanceof Error ? e.name : "error"}`);
      data = { sessions: {} };
    }
    cache = { key, data };
    return data;
  };
  return {
    path,
    read,
    write(data) {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
      cache = undefined;
    },
    resolve(session) {
      const d = read();
      return d.sessions[session] ?? fallback?.sessions[session] ?? d.common ?? fallback?.common;
    },
    useFallback(data) {
      fallback = data;
    },
  };
}

// ---- CLI ----

export const MEMORY_USAGE = `usage:
  bantou-center memory get   [--config <path>] [--session <name>]
  bantou-center memory set   [--config <path>] [--session <name>] --url <url> [--agent-id <id>] [--token-stdin | --token-file <path> | --clear-token]
  bantou-center memory unset [--config <path>] [--session <name>]
--session を省略すると全 session 共通の設定。token は引数に書けない（--token-stdin は標準入力、--token-file は file の中身。末尾の改行は除く）。
set で token の指定が無ければ今の token を残す。get は token を出さず、設定済みかどうかだけ出す。`;

export interface MemoryCliDeps {
  /** 標準入力の全文（--token-stdin の時だけ呼ぶ）。 */
  readStdin: () => string;
  readFile: (path: string) => string;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** 表示用の url（query と fragment は伏せる。秘密が載りうるため）。 */
export function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search || u.hash ? "?…" : ""}`;
  } catch {
    return "(不正)";
  }
}

const describe = (m: MemorySetting | undefined): string =>
  m === undefined ? "未設定" : `url=${displayUrl(m.url)} agentId=${m.agentId ?? "(session 名)"} token=${m.token ? "設定済み" : "なし"}`;

/** `bantou-center memory ...` の本体。戻り値は exit code（0 成功、2 使い方の誤り、1 失敗）。 */
export function runMemoryCli(argv: string[], defaultConfig: string, deps: MemoryCliDeps): number {
  const [action, ...rest] = argv;
  if (action !== "get" && action !== "set" && action !== "unset") {
    deps.err(MEMORY_USAGE);
    return 2;
  }
  const o: { config: string; session?: string; url?: string; agentId?: string; tokenStdin: boolean; tokenFile?: string; clearToken: boolean } = {
    config: defaultConfig,
    tokenStdin: false,
    clearToken: false,
  };
  try {
    for (let i = 0; i < rest.length; i++) {
      const k = rest[i];
      const val = (): string => {
        if (i + 1 >= rest.length) throw new Error(`${k} に値が無い`);
        return rest[++i];
      };
      if (k === "--config") o.config = val();
      else if (k === "--session") o.session = val();
      else if (k === "--url" && action === "set") o.url = val();
      else if (k === "--agent-id" && action === "set") o.agentId = val();
      else if (k === "--token-file" && action === "set") o.tokenFile = val();
      else if (k === "--token-stdin" && action === "set") o.tokenStdin = true;
      else if (k === "--clear-token" && action === "set") o.clearToken = true;
      else if (k === "--token" || k.startsWith("--token=")) throw new Error("token は引数に書けない（--token-stdin か --token-file を使う）");
      else {
        // 値が混ざりうるので、引数の中身は出さない（`--名前` の名前の部分だけ出す）
        const name = /^--[A-Za-z][A-Za-z0-9-]*/.exec(k)?.[0];
        throw new Error(name ? `不明な引数: ${name}（値を引数に書けない。token は標準入力か file を使う）` : "不明な引数（位置引数は受け付けない。値を引数に書けない。token は標準入力か file を使う）");
      }
    }
    if (o.session !== undefined && !SESSION_NAME.test(o.session)) throw new Error("session は英数字と _ - のみ");
    if ([o.tokenStdin, o.tokenFile !== undefined, o.clearToken].filter(Boolean).length > 1) throw new Error("--token-stdin / --token-file / --clear-token は 1 つだけ");
    if (action === "set" && o.url === undefined) throw new Error("set には --url が要る");
  } catch (e) {
    deps.err(e instanceof Error ? e.message : String(e));
    deps.err(MEMORY_USAGE);
    return 2;
  }

  const file = createMemoryFile(dirname(resolve(o.config)));
  try {
    const data = file.read();
    if (action === "get") {
      if (o.session !== undefined) {
        deps.out(`session ${o.session}: ${describe(data.sessions[o.session])}`);
        deps.out(`有効な設定: ${o.session in data.sessions ? "session の設定" : data.common ? "全 session 共通" : "なし"}`);
        return 0;
      }
      deps.out(`共通: ${describe(data.common)}`);
      for (const [n, m] of Object.entries(data.sessions)) deps.out(`session ${n}: ${describe(m)}`);
      return 0;
    }
    const current = o.session === undefined ? data.common : data.sessions[o.session];
    if (action === "unset") {
      if (o.session === undefined) delete data.common;
      else delete data.sessions[o.session];
      file.write(data);
      deps.out(`${o.session === undefined ? "共通" : `session ${o.session}`}: 外部記憶の設定を消した${current ? "" : "（元から無い）"}`);
      return 0;
    }
    let token: string | undefined = current?.token;
    if (o.clearToken) token = undefined;
    else if (o.tokenStdin || o.tokenFile !== undefined) token = (o.tokenStdin ? deps.readStdin() : deps.readFile(o.tokenFile as string)).replace(/\r?\n$/, "");
    const parsed = memorySchema.safeParse({ url: o.url, ...(token ? { token } : {}), ...(o.agentId ? { agentId: o.agentId } : {}) });
    if (!parsed.success) {
      // 入力値を含む message は出さない（token の中身が載りうる）。どの項目かだけ出す
      deps.err(`設定が不正: ${[...new Set(parsed.error.issues.map((i) => `${i.path.join(".") || "(全体)"}: ${i.code === "custom" ? i.message : "形式が不正"}`))].join(" / ")}`);
      return 2;
    }
    const next = parseOne(parsed.data) as MemorySetting;
    if (o.session === undefined) data.common = next;
    else data.sessions[o.session] = next;
    file.write(data);
    deps.out(`${o.session === undefined ? "共通" : `session ${o.session}`}: ${describe(next)}（次に起動する session から効く）`);
    return 0;
  } catch (e) {
    deps.err(`失敗: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
