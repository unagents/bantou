/**
 * 普通の設定（center 共通の設定と session の設定の mcpServers）の MCP の接続を、session の起動の `--mcp-config` に載せる形にする。
 *
 * - 全 session に共通の接続（common）と、その session だけの追加（sessions[session]）を合成した物（effectiveRaw）が載る。
 *   他の session の追加は載らない。
 * - 普通の MCP の設定（Claude Code の mcp.json の形。stdio・http・sse など）は書いた項目をそのまま載せる。headers と env の値は
 *   `${BANTOU_MCP_SECRET_n}` の参照に置き換えて実値は子の env にだけ渡す（claude が展開するので server へ届く値は同じ。argv・log・status に値を出さない）。
 * - 旧形式（transport: http + auth.secret）の鍵の値も同じく env で渡す。
 * - claude に渡せない設定（toolPrefix・tools.allow・role）の接続は、設定より多く見せてしまうので載せない（名前だけを log に出す）。
 * - 載せない理由は名前と理由の種類だけを返す（値・url・header は出さない）。
 */
import { effectiveRaw, isPlain, validateAny, type ConnectionsData, type McpConnection } from "./mcp-connections.js";
import { COORDINATOR_CALLER_HEADER, isCoordinatorEntry } from "./coordinator-mcp.js";
import { createSecretAlloc, headerOf, isStdioDef, memoryDefOf, toClaudeEntry, type McpServerDef, type SecretAlloc } from "./mcp-server-def.js";
import type { SecretsStore } from "./mcp-secrets.js";
import { BANTOU_SERVER_KEY, MEMORY_SERVER_KEY, MESSENGER_SERVER_KEY } from "./wrapper.js";

/** 鍵の実値を渡す env の変数名の接頭（`BANTOU_MCP_SECRET_<通し番号>`）。 */
export const MCP_SECRET_ENV_PREFIX = "BANTOU_MCP_SECRET_";
/** 旧設定の auth.env が指していた環境変数名の接頭。設定では読まない。center の環境に残っていても session の子には継承させない。 */
export const MCP_KEY_ENV_PREFIX = "BANTOU_MCP_KEY_";
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
  /** この session の設定に、統括の MCP の server（coordinator-mcp.ts）を指す項目が在るか。 */
  coordinator: boolean;
  /** 載せた接続の名前。 */
  attached: string[];
  /** 載せなかった接続（名前と理由の種類だけ）。 */
  skipped: { name: string; reason: string }[];
}

/** session の起動の MCP の設定を作る。coordinator = 統括の MCP の server の port（その server を指す項目が在るかの判定に使う。無ければ null）。 */
export function buildSessionMcp(
  data: ConnectionsData,
  secrets: Pick<SecretsStore, "get">,
  session: string,
  coordinator: { port: number } | null = null,
): SessionMcp {
  const out: SessionMcp = { servers: {}, env: {}, allow: [], deny: [], coordinator: false, attached: [], skipped: [] };
  const skip = (name: string, reason: string): void => void out.skipped.push({ name, reason });
  const alloc = createSecretAlloc(MCP_SECRET_ENV_PREFIX);
  out.env = alloc.env;
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
    if (isPlain(c)) {
      out.servers[name] = toClaudeEntry(c, alloc);
      if (coordinator !== null && isCoordinatorEntry(c, coordinator)) {
        out.coordinator = true;
        // 統括の server が呼び手の session を知るための header（他の session を眠らせる道具で、自分自身を断るのに使う。書いてあればそのまま）
        const e = out.servers[name] as { headers?: Record<string, string> };
        if (!Object.keys(e.headers ?? {}).some((k) => k.toLowerCase() === COORDINATOR_CALLER_HEADER)) e.headers = { ...(e.headers ?? {}), "X-Bantou-Session": session };
      }
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
      // 旧来の鍵の file（auth.secret / 接続名）から取る
      const sec = secrets.get(conn.auth.secret ?? name)?.value;
      if (sec === undefined || sec === "") {
        skip(name, "鍵が無い");
        continue;
      }
      const ref = alloc.put(sec);
      headers[conn.auth.header ?? "Authorization"] = (conn.auth.format ?? "Bearer {secret}").replace("{secret}", () => ref);
    }
    out.servers[name] = { type: "http", url: conn.url, ...(Object.keys(headers).length ? { headers } : {}) };
    out.allow.push(`mcp__${name}__*`);
    for (const t of conn.tools?.deny ?? []) out.deny.push(`mcp__${name}__${t.endsWith("*") ? t.slice(0, -1) + "*" : t}`);
    out.attached.push(name);
  }
  return out;
}

/** 外部記憶の値を渡す env の変数名の接頭（`BANTOU_MEMORY_SECRET_<通し番号>`）。 */
export const MEMORY_SECRET_ENV_PREFIX = "BANTOU_MEMORY_SECRET_";

/**
 * 外部記憶（設定の memory。普通の MCP の設定の形）を --mcp-config の `memory` の entry にする。headers・env の値は env へ移す（toClaudeEntry）。
 * url の server（http・sse など）で `X-Agent-Id` を書いていなければ session 名を足す（外部記憶の agent の既定）。
 */
export function memoryEntry(def: McpServerDef, session: string, alloc: SecretAlloc = createSecretAlloc(MEMORY_SECRET_ENV_PREFIX)): { entry: McpServerDef; env: Record<string, string> } {
  // 旧形式 { url, token, agentId } も読み替える（token を argv に出さない）
  const d: McpServerDef = { ...(memoryDefOf(def) ?? def) };
  if (!isStdioDef(d) && headerOf(d.headers, "X-Agent-Id") === undefined) d.headers = { ...((d.headers as Record<string, string> | undefined) ?? {}), "X-Agent-Id": session };
  return { entry: toClaudeEntry(d, alloc), env: alloc.env };
}
