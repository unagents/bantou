/**
 * 旧設定の MCP の接続を、普通の書き方（Claude Code の mcp.json の mcpServers の 1 項目 `{ type: "http", url, headers }`）へ移す。
 * 起動時の移行（sessions.ts）だけが使う。移せない物は何も変えず、理由（名前と理由の種類だけ。値は出さない）を返す。
 *
 * - `{ transport: "builtin", builtin: "coordinator" }` → 統括の MCP の server（coordinator-mcp.ts）の 1 項目。
 * - `{ transport: "http", url, auth: { env, header?, format? }, headers?, identity? }` → `{ type: "http", url, headers }`
 *   （鍵は center の環境変数 auth.env の値を header の値にする）。toolPrefix・tools・role を持つ物は普通の書き方で表せないので移さない。
 */
import { MCP_KEY_ENV_PREFIX } from "./mcp-session.js";

export type LegacyResult = { kind: "keep" } | { kind: "moved"; value: Record<string, unknown>; /** 移らなかった項目の名前（値は入れない）。 */ dropped: string[] } | { kind: "fail"; reason: string };

export interface LegacyCtx {
  /** 統括の MCP の server の 1 項目（coordinator-mcp.json から。無ければ null）。 */
  coordinatorEntry: () => Record<string, unknown> | null;
  /** auth.env の値の取得元（center の環境）。 */
  env: () => Record<string, string | undefined>;
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 旧設定の項目か（builtin、または auth.env を持つ）。 */
export const isLegacyEntry = (raw: unknown): boolean =>
  isRec(raw) && (raw.transport === "builtin" || (isRec(raw.auth) && Object.hasOwn(raw.auth, "env")));

/**
 * 1 項目を移す。scope.session = その項目が書かれている session（共通の設定なら undefined）。
 * identity.value を持たない identity は session 名が値になるので、共通の設定では移せない。
 */
export function migrateEntry(raw: unknown, ctx: LegacyCtx, scope: { session?: string }): LegacyResult {
  if (!isLegacyEntry(raw)) return { kind: "keep" };
  const r = raw as Record<string, unknown>;
  if (r.transport === "builtin") {
    if (r.builtin !== "coordinator") return { kind: "fail", reason: "組み込みの接続の種類が不明" };
    const e = ctx.coordinatorEntry();
    return e ? { kind: "moved", value: e, dropped: [] } : { kind: "fail", reason: "統括の MCP の server の設定（coordinator-mcp.json）が無い" };
  }
  if (r.transport !== "http") return { kind: "fail", reason: "auth.env を持つが transport: http でない（項目ごとの上書き）。普通の書き方へ手で移す" };
  if (typeof r.url !== "string") return { kind: "fail", reason: "url が無い" };
  if (r.toolPrefix !== undefined || r.tools !== undefined || r.role !== undefined) return { kind: "fail", reason: "toolPrefix・tools・role は普通の書き方で表せない" };
  const auth = r.auth as Record<string, unknown>;
  if (typeof auth.env !== "string" || Object.hasOwn(auth, "secret")) return { kind: "fail", reason: "auth の形が不正" };
  // 旧の検査: auth.env は BANTOU_MCP_KEY_ 接頭の環境変数だけを指せる（center の他の環境変数は読まない）
  if (!auth.env.startsWith(MCP_KEY_ENV_PREFIX)) return { kind: "fail", reason: `鍵の環境変数名が ${MCP_KEY_ENV_PREFIX} で始まらない` };
  const value = ctx.env()[auth.env];
  if (value === undefined || value === "") return { kind: "fail", reason: `鍵の環境変数（${auth.env}）が center の環境に無い` };
  const dropped: string[] = [];
  for (const k of ["timeoutMs", "exposeMemoryWrite"]) if (Object.hasOwn(r, k)) dropped.push(k);
  const headers: Record<string, string> = {};
  if (isRec(r.headers)) {
    for (const [k, v] of Object.entries(r.headers)) {
      if (typeof v === "string") headers[k] = v;
      else dropped.push(`headers.${k}`);
    }
  }
  if (isRec(r.identity)) {
    const idv = typeof r.identity.value === "string" ? r.identity.value : scope.session;
    if (typeof r.identity.header !== "string" || idv === undefined) return { kind: "fail", reason: "identity の値が session 名になるので共通の設定からは移せない" };
    headers[r.identity.header] = idv;
  }
  const format = typeof auth.format === "string" ? auth.format : "Bearer {secret}";
  headers[typeof auth.header === "string" ? auth.header : "Authorization"] = format.replace("{secret}", () => value);
  return { kind: "moved", value: { type: "http", url: r.url, headers }, dropped };
}
