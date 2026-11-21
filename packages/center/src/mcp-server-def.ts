/**
 * 普通の MCP の設定（Claude Code の mcp.json の `mcpServers` の 1 件）の形の扱い。
 *
 * 追加の MCP の server（設定の `mcpServers`）と外部記憶（設定の `memory`）は、Claude Code の mcp.json に書ける形をそのまま持つ:
 * - stdio: `{ "type"?: "stdio", "command": string, "args"?: string[], "env"?: { [k]: string }, … }`
 * - http / sse など: `{ "type": "http" | "sse" | …, "url": string, "headers"?: { [k]: string }, … }`
 * 書いた項目は手を加えずに claude の `--mcp-config` へ渡す（知らない項目も素通し）。検査は claude 自身が要る物
 * （stdio の command、url の type の url、args・env・headers の形）だけ。header の値（`Authorization: Bearer <値>` など）もそのまま書ける。
 *
 * 旧形式（0.1.56 までの `transport: "http"` + `auth.env` の接続、外部記憶の `{ url, token, agentId }`）も読める（mcp-connections.ts / memoryDefOf）。
 */

/** 普通の MCP の設定 1 件（形は Claude Code の mcp.json の mcpServers の値）。 */
export type McpServerDef = Record<string, unknown>;

/** 接続の名前（claude の道具名 `mcp__<名前>__<道具>` と permissions の規則に入るので、Claude Code の `claude mcp add` と同じ英数字と _ -）。 */
export const SERVER_ENTRY_NAME = /^[A-Za-z0-9_-]+$/;

/** center が自分で組み立てる entry の名前（追加の MCP の server には使えない。外部記憶は設定の `memory` に書く）。 */
export const CENTER_ENTRY_NAMES: readonly string[] = ["bantou", "bantou-messenger", "memory"];

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrRecord = (v: unknown): boolean => isRec(v) && Object.values(v).every((x) => typeof x === "string");

/** 旧形式の接続（mcp-connections.ts の形。`transport` を持つ）か。 */
export const isLegacyConnection = (v: unknown): boolean => isRec(v) && Object.hasOwn(v, "transport");

/** stdio（type 無しか "stdio"）か。 */
export const isStdioDef = (d: McpServerDef): boolean => d.type === undefined || d.type === "stdio";

/**
 * 普通の MCP の設定 1 件の検査。claude が起動できない形だけを断る（誤りの文に値は含めない）。
 * - object であること。type は書くなら文字列。
 * - stdio（type 無しか "stdio"）は command（空でない文字列）。args は文字列の配列、env は文字列の値の object。
 * - それ以外の type（http・sse など）は url（空でない文字列）。headers は文字列の値の object。
 */
export function serverDefIssues(v: unknown): string[] {
  if (!isRec(v)) return ["MCP の server の設定は object で書く"];
  const out: string[] = [];
  if (v.type !== undefined && (typeof v.type !== "string" || v.type === "")) out.push("type は文字列（stdio / http / sse など）");
  else if (isStdioDef(v)) {
    if (typeof v.command !== "string" || v.command === "") out.push("stdio の server には command（文字列）が要る");
  } else if (typeof v.url !== "string" || v.url === "") out.push(`type ${String(v.type)} の server には url（文字列）が要る`);
  if (v.args !== undefined && !(Array.isArray(v.args) && v.args.every((a) => typeof a === "string"))) out.push("args は文字列の配列");
  if (v.env !== undefined && !isStrRecord(v.env)) out.push("env は文字列の値の object");
  if (v.headers !== undefined && !isStrRecord(v.headers)) out.push("headers は文字列の値の object");
  return out;
}

/**
 * 外部記憶の設定を普通の MCP の設定の形にする。旧形式 `{ url, token?, agentId? }`（type も command も無い）は
 * `{ type: "http", url, headers: { Authorization: "Bearer <token>", "X-Agent-Id": <agentId> } }` に読み替える。
 * object でなければ undefined。
 */
export function memoryDefOf(raw: unknown): McpServerDef | undefined {
  if (!isRec(raw)) return undefined;
  if (raw.type !== undefined || raw.command !== undefined || typeof raw.url !== "string") return { ...raw };
  // type も command も無く url がある = 旧形式（外部記憶はいつも http だった）
  const headers: Record<string, unknown> = isRec(raw.headers) ? { ...raw.headers } : {};
  if (typeof raw.token === "string" && raw.token !== "") headers.Authorization = `Bearer ${raw.token}`;
  if (typeof raw.agentId === "string" && raw.agentId !== "") headers["X-Agent-Id"] = raw.agentId;
  const rest: Record<string, unknown> = { ...raw };
  delete rest.url;
  delete rest.token;
  delete rest.agentId;
  delete rest.headers;
  return { type: "http", url: raw.url, ...(Object.keys(headers).length ? { headers } : {}), ...rest };
}

/** 外部記憶の設定の検査（旧形式も読み替えてから見る）。 */
export const memoryDefIssues = (raw: unknown): string[] => {
  const d = memoryDefOf(raw);
  return d === undefined ? ["外部記憶の設定は object で書く"] : serverDefIssues(d);
};

/** 外部記憶の設定（読み替え済み）。不正なら undefined（付けない）。 */
export function validMemoryDef(raw: unknown): McpServerDef | undefined {
  const d = memoryDefOf(raw);
  return d !== undefined && serverDefIssues(d).length === 0 ? d : undefined;
}

/** header の名前を大文字小文字を区別せずに引く。 */
export function headerOf(headers: unknown, name: string): string | undefined {
  if (!isRec(headers)) return undefined;
  const l = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === l && typeof v === "string") return v;
  return undefined;
}

/** 値を env へ移す時の割り当て（変数名を払い出し、値を控える）。 */
export interface SecretAlloc {
  /** 値を env の変数に入れ、その変数の参照 `${名前}` を返す。 */
  put(value: string): string;
  /** 払い出した変数（名前 → 値）。 */
  env: Record<string, string>;
}

export function createSecretAlloc(prefix: string): SecretAlloc {
  const env: Record<string, string> = {};
  let n = 0;
  return {
    env,
    put(value) {
      const name = `${prefix}${n++}`;
      env[name] = value;
      return "${" + name + "}";
    },
  };
}

/**
 * claude の `--mcp-config` に載せる形。書いた項目はそのまま。ただし headers と env の値は、`${…}` を含まない物だけ
 * session の claude の env の変数（alloc）へ移し、`${変数}` の参照を書く（claude が起動時に展開するので、server へ届く値は書いた値と同じ。
 * argv（ps）・status・log に値を出さないため）。`${…}` を含む値は利用者が環境変数を指したものなので、そのまま渡す。
 */
export function toClaudeEntry(def: McpServerDef, alloc: SecretAlloc): McpServerDef {
  const out: McpServerDef = structuredClone(def);
  for (const key of ["headers", "env"] as const) {
    const m = out[key];
    if (!isRec(m)) continue;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(m)) next[k] = typeof v === "string" && v !== "" && !v.includes("${") ? alloc.put(v) : v;
    out[key] = next;
  }
  return out;
}

/**
 * `${VAR}` / `${VAR:-default}` を env で展開する（claude の --mcp-config の展開と同じ書式）。center 自身が外部記憶へ書く時に使う。
 * 無い変数は空文字（default があれば default）。
 */
export function expandEnvRefs(s: string, env: Record<string, string | undefined> = process.env): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, def: string | undefined) => env[name] ?? def ?? "");
}
