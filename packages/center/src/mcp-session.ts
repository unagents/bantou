/**
 * 普通の設定（center 共通の設定と session の設定の mcpServers）の MCP の接続を、session の起動の `--mcp-config` に載せる形にする。
 *
 * - 全 session に共通の接続（common）と、その session だけの追加（sessions[session]）を合成した物（effectiveRaw）が載る。
 *   他の session の追加は載らない。
 * - 鍵の値は --mcp-config・argv・log・status に入れない。headers には `${BANTOU_MCP_SECRET_n}` の参照だけを書き、実値は子の env にだけ渡す。
 * - 組み込みの接続（coordinator）は center 自身の口 `/mcp/coordinator` を指す。載るのは割り当てた session だけ。
 * - claude に渡せない設定（toolPrefix・tools.allow・role）の接続は、設定より多く見せてしまうので載せない（名前だけを log に出す）。
 * - 載せない理由は名前と理由の種類だけを返す（値・url・header は出さない）。
 */
import { BUILTIN_NAMES, effectiveRaw, isBuiltin, validateAny, type BuiltinKind, type ConnectionsData, type McpConnection } from "./mcp-connections.js";
import type { SecretsStore } from "./mcp-secrets.js";
import { BANTOU_SERVER_KEY, MEMORY_SERVER_KEY, MESSENGER_SERVER_KEY } from "./wrapper.js";

/** 鍵の実値を渡す env の変数名の接頭（`BANTOU_MCP_SECRET_<通し番号>`）。 */
export const MCP_SECRET_ENV_PREFIX = "BANTOU_MCP_SECRET_";
/** 設定の auth.env に書ける環境変数名の接頭（center の環境に置く鍵。子の process には継承させない）。 */
export const MCP_KEY_ENV_PREFIX = "BANTOU_MCP_KEY_";
/** center の中の組み込みの口の path（http.ts の window "coordinator"）。 */
export const COORDINATOR_MCP_PATH = "/mcp/coordinator";
/** center 自身が組み立てる entry 名。接続の名前がこれと同じ時は center のものを優先して接続の方を載せない。 */
const OWN_KEYS: readonly string[] = [BANTOU_SERVER_KEY, MESSENGER_SERVER_KEY, MEMORY_SERVER_KEY];

export interface SessionMcp {
  /** --mcp-config の mcpServers に足す entry（名前 → 定義）。鍵の実値は含まない。 */
  servers: Record<string, unknown>;
  /** 子の env に足す鍵の実値（変数名 → 値）。log・status に出さない。 */
  env: Record<string, string>;
  /** --settings の permissions.allow / deny に足す規則。 */
  allow: string[];
  deny: string[];
  /** この session に割り当て済みの組み込みの種類。 */
  builtins: BuiltinKind[];
  /** 載せた接続の名前。 */
  attached: string[];
  /** 載せなかった接続（名前と理由の種類だけ）。 */
  skipped: { name: string; reason: string }[];
}

/** session の起動の MCP の設定を作る。centerBase = center の http の origin（`http://host:port`。無ければ null = 組み込みは載せない）。 */
export function buildSessionMcp(
  data: ConnectionsData,
  secrets: Pick<SecretsStore, "get">,
  session: string,
  centerBase: string | null,
  /** auth.env で指した環境変数の値の取得元（center の環境。省略時は process.env）。 */
  envs: Record<string, string | undefined> = process.env,
): SessionMcp {
  const out: SessionMcp = { servers: {}, env: {}, allow: [], deny: [], builtins: [], attached: [], skipped: [] };
  const skip = (name: string, reason: string): void => void out.skipped.push({ name, reason });
  let n = 0;
  for (const [name, raw] of Object.entries(effectiveRaw(data, session))) {
    if (OWN_KEYS.includes(name)) {
      skip(name, "center の組み立てる名前と重なる");
      continue;
    }
    const v = validateAny(raw, name, { allowPlainHttp: true });
    if (!v.ok) {
      skip(name, "設定が不正");
      continue;
    }
    const c = v.value;
    if (isBuiltin(c)) {
      if (centerBase === null) {
        skip(name, "center の窓口が無い");
        continue;
      }
      if (name !== BUILTIN_NAMES[c.builtin]) continue; // validateAny が見ている。型のためだけ
      out.servers[name] = {
        type: "http",
        url: `${centerBase}${COORDINATOR_MCP_PATH}`,
        headers: { Authorization: "Bearer ${BANTOU_SESSION_TOKEN}", "X-Bantou-Session": session },
      };
      out.builtins.push(c.builtin);
      out.allow.push(`mcp__${name}__*`);
      out.attached.push(name);
      continue;
    }
    const conn: McpConnection = c;
    if (conn.toolPrefix !== undefined || conn.tools?.allow !== undefined || conn.role !== undefined) {
      skip(name, "toolPrefix・tools.allow・role は claude に直接渡せない");
      continue;
    }
    const headers: Record<string, string> = { ...(conn.headers ?? {}) };
    if (conn.identity) headers[conn.identity.header] = conn.identity.value ?? session;
    if (conn.auth) {
      // 鍵は設定に書かない。auth.env の環境変数（center の環境）か、旧来の鍵の file（auth.secret / 接続名）から取る
      const sec = conn.auth.env !== undefined ? envs[conn.auth.env] : secrets.get(conn.auth.secret ?? name)?.value;
      if (sec === undefined || sec === "") {
        skip(name, conn.auth.env !== undefined ? "鍵の環境変数が無い" : "鍵が無い");
        continue;
      }
      const envName = `${MCP_SECRET_ENV_PREFIX}${n++}`;
      out.env[envName] = sec;
      headers[conn.auth.header ?? "Authorization"] = (conn.auth.format ?? "Bearer {secret}").replace("{secret}", () => "${" + envName + "}");
    }
    out.servers[name] = { type: "http", url: conn.url, ...(Object.keys(headers).length ? { headers } : {}) };
    out.allow.push(`mcp__${name}__*`);
    for (const t of conn.tools?.deny ?? []) out.deny.push(`mcp__${name}__${t.endsWith("*") ? t.slice(0, -1) + "*" : t}`);
    out.attached.push(name);
  }
  return out;
}

/** 割り当ての判定（毎回呼ぶ）。session の有効な接続に、検査を通る組み込みの種類があるか。file が壊れていれば空の設定なので false。 */
export function isAssigned(data: ConnectionsData, session: string, kind: BuiltinKind): boolean {
  const name = BUILTIN_NAMES[kind];
  const raw = effectiveRaw(data, session)[name];
  if (raw === undefined) return false;
  const v = validateAny(raw, name, { allowPlainHttp: true });
  return v.ok && isBuiltin(v.value) && v.value.builtin === kind;
}

/** center の http の origin（session 向けの窓口の URL `http://host:port/mcp/session` から作る）。 */
export function centerBaseOf(sessionMcpUrl: string | null): string | null {
  if (sessionMcpUrl === null) return null;
  try {
    return new URL(sessionMcpUrl).origin;
  } catch {
    return null;
  }
}
