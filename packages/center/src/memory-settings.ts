/**
 * 外部記憶（memory）の設定の CLI（`bantou-center memory`）と、旧設定の file `memory-settings.json` の読み（移行元）。
 *
 * 外部記憶の設定は普通の設定（center 共通の設定 center-settings.json と session の設定 sessions.json の `memory`）に、
 * 普通の MCP の設定の形（Claude Code の mcp.json の mcpServers の値。例 `{ type: "http", url, headers: { Authorization: "Bearer …" } }`）で持つ。
 * 書くのは center を起動した所の設定の画面（center が保存する）とこの CLI。center は session の起動のたびと memory への送信のたびに file を読む。
 * `memory-settings.json`（0.1.56 までの CLI が書いた物）は center の起動時に普通の設定へ移される（sessions.ts の restore）。
 */
import { chmodSync, readFileSync, renameSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { memorySchema, type MemorySetting } from "./project-settings.js";
import { SESSION_NAME } from "./sessions.js";
import { memoryDefIssues, memoryDefOf, type McpServerDef } from "./mcp-server-def.js";
import { existsSync } from "node:fs";

export type { MemorySetting };

export const MEMORY_SETTINGS_FILE = "memory-settings.json";

/** 保存形。common = 全 session 共通、sessions = session ごと（session の値があれば共通は使わない。項目ごとの合成はしない）。 */
export interface MemoryFileData {
  common?: MemorySetting;
  sessions: Record<string, MemorySetting>;
}

export interface MemoryFile {
  readonly path: string;
  /** file があるか。 */
  exists(): boolean;
  /** file を `.migrated` に退ける（移行の後）。 */
  retire(): void;
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
    exists: () => existsSync(path),
    retire() {
      renameSync(path, `${path}.migrated`);
      cache = undefined;
    },
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
  bantou-center memory set   [--config <path>] [--session <name>] (--json-stdin | --json-file <path>)
  bantou-center memory set   [--config <path>] [--session <name>] --url <url> [--agent-id <id>] [--token-stdin | --token-file <path>]
  bantou-center memory unset [--config <path>] [--session <name>]
--session を省略すると全 session 共通の設定。--json-* は普通の MCP の設定の 1 件（例 {"type":"http","url":"…","headers":{"Authorization":"Bearer …"}}）。
--url の形は { type: "http", url, headers: { Authorization: "Bearer <token>", X-Agent-Id: <id> } } を書く。token は引数に書けない（--token-stdin は標準入力、--token-file は file の中身。末尾の改行は除く）。
書き先は center の状態 dir の center-settings.json（共通）/ sessions.json（session の設定）の memory。`;

export interface MemoryCliDeps {
  /** 標準入力の全文（--token-stdin / --json-stdin の時だけ呼ぶ）。 */
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

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`${path} を読めない（${e instanceof Error ? e.name : "error"}）`);
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** `bantou-center memory ...` の本体。戻り値は exit code（0 成功、2 使い方の誤り、1 失敗）。 */
export function runMemoryCli(argv: string[], defaultConfig: string, deps: MemoryCliDeps): number {
  const [action, ...rest] = argv;
  if (action !== "get" && action !== "set" && action !== "unset") {
    deps.err(MEMORY_USAGE);
    return 2;
  }
  const o: { config: string; session?: string; url?: string; agentId?: string; tokenStdin: boolean; tokenFile?: string; jsonStdin: boolean; jsonFile?: string } = {
    config: defaultConfig,
    tokenStdin: false,
    jsonStdin: false,
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
      else if (k === "--json-file" && action === "set") o.jsonFile = val();
      else if (k === "--json-stdin" && action === "set") o.jsonStdin = true;
      else if (k === "--token" || k.startsWith("--token=")) throw new Error("token は引数に書けない（--token-stdin か --token-file を使う）");
      else {
        // 値が混ざりうるので、引数の中身は出さない（`--名前` の名前の部分だけ出す）
        const name = /^--[A-Za-z][A-Za-z0-9-]*/.exec(k)?.[0];
        throw new Error(name ? `不明な引数: ${name}` : "不明な引数（位置引数は受け付けない）");
      }
    }
    if (o.session !== undefined && !SESSION_NAME.test(o.session)) throw new Error("session は英数字と _ - のみ");
    const json = o.jsonStdin || o.jsonFile !== undefined;
    if ([o.tokenStdin, o.tokenFile !== undefined, o.jsonStdin, o.jsonFile !== undefined].filter(Boolean).length > 1) throw new Error("--token-stdin / --token-file / --json-stdin / --json-file は 1 つだけ");
    if (action === "set" && json && (o.url !== undefined || o.agentId !== undefined)) throw new Error("--json-* と --url / --agent-id は一緒に使えない");
    if (action === "set" && !json && o.url === undefined) throw new Error("set には --json-stdin / --json-file か --url が要る");
  } catch (e) {
    deps.err(e instanceof Error ? e.message : String(e));
    deps.err(MEMORY_USAGE);
    return 2;
  }

  const stateDir = dirname(resolve(o.config));
  const commonPath = join(stateDir, "center-settings.json");
  const sessionsPath = join(stateDir, "sessions.json");
  try {
    const common = readJson(commonPath);
    const sessions = readJson(sessionsPath);
    const list: unknown[] = Array.isArray(sessions) ? sessions : [];
    const rec = o.session === undefined ? undefined : list.find((r) => isRec(r) && r.name === o.session);
    if (o.session !== undefined && !isRec(rec)) {
      deps.err(`session ${o.session} は session_create で作った物の中に無い（sessions.json）`);
      return 1;
    }
    const settingsOf = (r: unknown): Record<string, unknown> => (isRec(r) && isRec(r.settings) ? r.settings : {});
    const current = (): unknown => (o.session === undefined ? (isRec(common) ? common.memory : undefined) : settingsOf(rec).memory);
    if (action === "get") {
      const show = (label: string, m: unknown): void => deps.out(`${label}: ${m === undefined ? "未設定" : JSON.stringify(memoryDefOf(m))}`);
      if (o.session !== undefined) {
        show(`session ${o.session}`, current());
        deps.out(`有効な設定: ${settingsOf(rec).memory !== undefined ? "session の設定" : isRec(common) && common.memory !== undefined ? "全 session 共通" : "なし"}`);
        return 0;
      }
      show("共通", isRec(common) ? common.memory : undefined);
      for (const r of list) if (isRec(r) && typeof r.name === "string" && settingsOf(r).memory !== undefined) show(`session ${r.name}`, settingsOf(r).memory);
      return 0;
    }
    let next: McpServerDef | undefined;
    if (action === "set") {
      if (o.jsonStdin || o.jsonFile !== undefined) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(o.jsonStdin ? deps.readStdin() : deps.readFile(o.jsonFile as string));
        } catch {
          deps.err("設定が不正: JSON として読めない");
          return 2;
        }
        // { "mcpServers": { "<名前>": {...} } } の 1 件も受ける
        if (isRec(parsed) && isRec(parsed.mcpServers) && Object.keys(parsed).length === 1 && Object.keys(parsed.mcpServers).length === 1) parsed = Object.values(parsed.mcpServers)[0];
        const issues = memoryDefIssues(parsed);
        if (issues.length) {
          deps.err(`設定が不正: ${issues.join(" / ")}`);
          return 2;
        }
        next = memoryDefOf(parsed);
      } else {
        const token = o.tokenStdin || o.tokenFile !== undefined ? (o.tokenStdin ? deps.readStdin() : deps.readFile(o.tokenFile as string)).replace(/\r?\n$/, "") : undefined;
        const parsed = memorySchema.safeParse({ url: o.url, ...(token ? { token } : {}), ...(o.agentId ? { agentId: o.agentId } : {}) });
        if (!parsed.success) {
          // 入力値を含む message は出さない（token の中身が載りうる）。どの項目かだけ出す
          deps.err(`設定が不正: ${[...new Set(parsed.error.issues.map((i) => `${i.path.join(".") || "(全体)"}: ${i.code === "custom" ? i.message : "形式が不正"}`))].join(" / ")}`);
          return 2;
        }
        next = memoryDefOf(parsed.data);
      }
    }
    const had = current() !== undefined;
    if (o.session === undefined) {
      const c: Record<string, unknown> = isRec(common) ? { ...common } : {};
      if (next === undefined) delete c.memory;
      else c.memory = next;
      writeJson(commonPath, c);
    } else {
      const r = rec as Record<string, unknown>;
      const st: Record<string, unknown> = { ...settingsOf(r) };
      if (next === undefined) delete st.memory;
      else st.memory = next;
      if (Object.keys(st).length) r.settings = st;
      else delete r.settings;
      writeJson(sessionsPath, list);
    }
    const label = o.session === undefined ? "共通" : `session ${o.session}`;
    deps.out(next === undefined ? `${label}: 外部記憶の設定を消した${had ? "" : "（元から無い）"}` : `${label}: 外部記憶の設定を書いた（次に起動する session から効く）`);
    return 0;
  } catch (e) {
    deps.err(`失敗: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
