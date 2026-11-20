/**
 * center が持つ「MCP の接続」の一覧（`mcp-connections.json`、mode 0600、秘密を含まない）の形・検証・合成・保存。
 *
 * M1 の範囲: 設定の読み書きと検証だけ。動いている session への渡し方（`--mcp-config`）と center 自身の外部記憶への書き込みは
 * まだこの設定を使わない（読みと書きの切り替えは後のまとまりで同時に行う）。
 * 検証の誤りの文には入力値を含めない（項目名だけ。値に鍵が混ざっても出ない）。
 */
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import { createJsonFile, own, setOwn, type JsonFile } from "./mcp-json-file.js";
import { checkSecretNameShape, SECRET_NAME_ERROR } from "./mcp-secrets.js";
import { memoryUrlSchema } from "./project-settings.js";
import { SESSION_NAME } from "./sessions.js";

export const MCP_CONNECTIONS_FILE = "mcp-connections.json";
/** center が自分で組み立てる物と、口の path と重なる名前。 */
export const RESERVED_NAMES: readonly string[] = ["bantou", "bantou-messenger", "mcp", "conn"];
export const CONNECTION_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const IDENTITY_VALUE = /^[A-Za-z0-9_-]{1,64}$/;
export const TIMEOUT_MIN_MS = 1000;
export const TIMEOUT_MAX_MS = 120000;
export const TIMEOUT_DEFAULT_MS = 60000;
export const HEADERS_MAX = 10;
export const TOOLS_LIST_MAX = 50;
/** claude の道具名の規則（英数字と `_` `-`、64 文字以内。上限は claude の側の値で未確認）。 */
export const VISIBLE_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,100}$/;
const SECRETISH = /key|token|secret|auth|password/i;
const TOOL_PATTERN = /^[A-Za-z0-9_.-]{1,100}\*?$/;

const headerName = z.string().regex(HEADER_NAME, "header 名は RFC 7230 の token 文字");

const authSchema = z
  .object({
    header: headerName.optional(),
    format: z
      .string()
      .max(200)
      .refine((v) => v.split("{secret}").length === 2, { message: "format は {secret} をちょうど 1 つ含む" })
      .refine((v) => !v.includes("${") && !/[\x00-\x1f\x7f]/.test(v), { message: "format に ${ ・制御文字・改行は使えない" })
      .optional(),
    secret: z.string().refine((v) => checkSecretNameShape(v) === undefined, { message: SECRET_NAME_ERROR }).optional(),
  })
  .strict();

const toolListSchema = z
  .array(z.string().regex(TOOL_PATTERN, "道具名は英数字と . _ - （末尾の * だけ可）"))
  .max(TOOLS_LIST_MAX, `道具の指定は ${TOOLS_LIST_MAX} 個以内`);

const baseShape = {
  transport: z.literal("http", { message: "transport は http だけ（stdio は未実装）" }),
  url: memoryUrlSchema,
  auth: authSchema,
  headers: z
    .record(z.string(), z.string().refine((v) => !/[\x00-\x1f\x7f]/.test(v) && v.length <= 1000, { message: "header の値に制御文字・改行は使えない（1000 文字以内）" }))
    .refine((h) => Object.keys(h).length <= HEADERS_MAX, { message: `headers は ${HEADERS_MAX} 個以内` }),
  identity: z
    .object({ header: headerName, value: z.string().regex(IDENTITY_VALUE, "identity.value は英数字と _ - の 64 文字以内").optional() })
    .strict(),
  toolPrefix: z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/, "toolPrefix は英数字と . _ -"),
  tools: z.object({ allow: toolListSchema.optional(), deny: toolListSchema.optional() }).strict(),
  role: z.literal("memory", { message: "role は memory だけ" }),
  exposeMemoryWrite: z.boolean(),
  timeoutMs: z.number().int().min(TIMEOUT_MIN_MS).max(TIMEOUT_MAX_MS),
};

/** 1 件の接続（完全な定義）。 */
export const connectionSchema = z
  .object({
    transport: baseShape.transport,
    url: baseShape.url,
    auth: baseShape.auth.optional(),
    headers: baseShape.headers.optional(),
    identity: baseShape.identity.optional(),
    toolPrefix: baseShape.toolPrefix.optional(),
    tools: baseShape.tools.optional(),
    role: baseShape.role.optional(),
    exposeMemoryWrite: baseShape.exposeMemoryWrite.optional(),
    timeoutMs: baseShape.timeoutMs.optional(),
  })
  .strict();
export type McpConnection = z.infer<typeof connectionSchema>;

/** session ごとの上書き（項目ごと。null = その項目を外す）。 */
export const overrideSchema = z
  .object({
    transport: baseShape.transport.optional(),
    url: baseShape.url.optional(),
    auth: baseShape.auth.nullable().optional(),
    headers: baseShape.headers.nullable().optional(),
    identity: baseShape.identity.nullable().optional(),
    toolPrefix: baseShape.toolPrefix.nullable().optional(),
    tools: baseShape.tools.nullable().optional(),
    role: baseShape.role.nullable().optional(),
    exposeMemoryWrite: baseShape.exposeMemoryWrite.nullable().optional(),
    timeoutMs: baseShape.timeoutMs.nullable().optional(),
  })
  .strict();
export type ConnOverride = z.infer<typeof overrideSchema>;

export interface ConnectionsData {
  version: 1;
  common: Record<string, McpConnection>;
  /** session 名 → 接続名 → 上書き（null = その session ではその接続を付けない）。 */
  sessions: Record<string, Record<string, ConnOverride | null>>;
}

export const emptyConnections = (): ConnectionsData => ({ version: 1, common: {}, sessions: {} });

/** zod の誤りを、入力値を含まない文にする（項目名 + 固定の理由だけ）。 */
export function issuesOf(err: z.ZodError): string[] {
  return [...new Set(err.issues.map((i) => `${i.path.join(".") || "(全体)"}: ${i.code === "custom" || i.code === "invalid_value" ? i.message : "形式が不正"}`))];
}

// ---- 追加の検査（形だけでは表せない物） ----

function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const kind = isIP(h);
  if (kind === 4) {
    const [a, b] = h.split(".").map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (kind === 6) return h === "::1" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
  return false;
}

/** 接続 1 件の追加の検査。opts.allowPlainHttp が無いと、auth がある `http:` の公の host は断る。 */
export function connectionIssues(c: McpConnection, opts: { allowPlainHttp?: boolean } = {}): string[] {
  const out: string[] = [];
  let u: URL | undefined;
  try {
    u = new URL(c.url);
  } catch {
    /* connectionSchema の側で断る */
  }
  if (u) {
    for (const k of u.searchParams.keys()) {
      if (SECRETISH.test(k)) {
        out.push("url: query に鍵らしい名前がある（鍵は auth に入れる）");
        break;
      }
    }
    if (c.auth && u.protocol === "http:" && !isPrivateHost(u.hostname) && !opts.allowPlainHttp)
      out.push("url: 鍵を付ける接続で http: の公の host は平文で鍵が流れる（--allow-plain-http を付けた時だけ保存する）");
  }
  const authHeader = (c.auth?.header ?? "Authorization").toLowerCase();
  const idHeader = c.identity?.header.toLowerCase();
  for (const name of Object.keys(c.headers ?? {})) {
    const l = name.toLowerCase();
    if (!HEADER_NAME.test(name)) out.push("headers: header 名が不正");
    else if (l === authHeader || l === idHeader || l === "cookie" || l === "proxy-authorization") out.push("headers: 鍵・識別・Cookie の header と同じ名前は固定の header に使えない");
    else if (SECRETISH.test(name)) out.push("headers: 鍵らしい名前の header は固定の header に使えない（鍵は auth に入れる）");
  }
  if (idHeader !== undefined && idHeader === authHeader) out.push("identity.header: 鍵の header と同じ名前は使えない");
  return [...new Set(out)];
}

export type ValidateResult = { ok: true; value: McpConnection } | { ok: false; issues: string[] };

export function validateConnection(raw: unknown, opts: { allowPlainHttp?: boolean } = {}): ValidateResult {
  const r = connectionSchema.safeParse(raw);
  if (!r.success) return { ok: false, issues: issuesOf(r.error) };
  const extra = connectionIssues(r.data, opts);
  return extra.length ? { ok: false, issues: extra } : { ok: true, value: r.data };
}

export function validateName(name: string): string | undefined {
  if (!CONNECTION_NAME.test(name)) return "名前は [a-z0-9][a-z0-9_-]{0,31}";
  if (RESERVED_NAMES.includes(name)) return "予約された名前（center が組み立てる物か口の path）";
  return undefined;
}

// ---- 合成 ----

/** common と session の上書きを項目ごとに合成する（1 段。入れ子の中身は丸ごと置き換え）。上書きが null なら undefined（付けない）。 */
export function composeConnection(common: McpConnection | undefined, override: ConnOverride | null | undefined): Record<string, unknown> | undefined {
  if (override === null) return undefined;
  const out: Record<string, unknown> = { ...(common ?? {}) };
  for (const [k, v] of Object.entries(override ?? {})) {
    if (v === null) delete out[k];
    else if (v !== undefined) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** ある scope（session 名。無ければ共通）で有効な接続（合成後。検証前の形）。 */
export function effectiveRaw(data: ConnectionsData, session?: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = Object.create(null);
  if (session === undefined) {
    for (const [n, c] of Object.entries(data.common)) out[n] = { ...c };
    return out;
  }
  const ov = own(data.sessions, session) ?? {};
  for (const n of new Set([...Object.keys(data.common), ...Object.keys(ov)])) {
    const c = composeConnection(own(data.common, n), own(ov, n));
    if (c) out[n] = c;
  }
  return out;
}

export interface ScopeIssue {
  scope: string;
  name?: string;
  issue: string;
}

/** 全体の検査（共通と各 session の合成後）。名前・各接続・役割 memory が 1 つまで。 */
export function validateAll(data: ConnectionsData): ScopeIssue[] {
  const out: ScopeIssue[] = [];
  const scopes: Array<string | undefined> = [undefined, ...Object.keys(data.sessions)];
  for (const s of scopes) {
    const scope = s ?? "common";
    if (s !== undefined && !SESSION_NAME.test(s)) out.push({ scope, issue: "session 名が不正" });
    const eff = effectiveRaw(data, s);
    const roles: string[] = [];
    for (const [name, raw] of Object.entries(eff)) {
      const ne = validateName(name);
      if (ne) out.push({ scope, name, issue: ne });
      const r = validateConnection(raw, { allowPlainHttp: true });
      if (!r.ok) for (const issue of r.issues) out.push({ scope, name, issue });
      else if (r.value.role === "memory") roles.push(name);
    }
    if (roles.length > 1) out.push({ scope, issue: `role memory の接続が ${roles.length} 個ある（1 つまで: ${roles.join(", ")}）` });
  }
  return out;
}

// ---- 読み込み ----

export function parseConnections(raw: unknown): { data: ConnectionsData; problem?: string } {
  const data = emptyConnections();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { data, problem: "形が不正" };
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) return { data, problem: "version が 1 でない" };
  let dropped = 0;
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (isObj(o.common)) {
    for (const [name, v] of Object.entries(o.common)) {
      const r = connectionSchema.safeParse(v);
      if (r.success && validateName(name) === undefined) data.common[name] = r.data;
      else dropped++;
    }
  } else if (o.common !== undefined) dropped++;
  if (isObj(o.sessions)) {
    for (const [s, per] of Object.entries(o.sessions)) {
      if (!SESSION_NAME.test(s) || !isObj(per)) {
        dropped++;
        continue;
      }
      const m: Record<string, ConnOverride | null> = {};
      for (const [name, v] of Object.entries(per)) {
        if (v === null) m[name] = null;
        else {
          const r = overrideSchema.safeParse(v);
          if (r.success && validateName(name) === undefined) m[name] = r.data;
          else dropped++;
        }
      }
      setOwn(data.sessions, s, m);
    }
  } else if (o.sessions !== undefined) dropped++;
  return dropped ? { data, problem: `${dropped} 件の項目が不正（捨てた）` } : { data };
}

export interface ConnectionsStore {
  file: JsonFile<ConnectionsData>;
  read(): ConnectionsData;
}

export function createConnectionsStore(stateDir: string, log: (m: string) => void = () => {}): ConnectionsStore {
  const file = createJsonFile<ConnectionsData>(join(stateDir, MCP_CONNECTIONS_FILE), parseConnections, emptyConnections, log);
  return { file, read: () => file.load().data };
}

// ---- 試す時の道具の見え方 ----

/** 道具名の末尾 `*` だけ許す pattern の照合。 */
export function matchTool(pattern: string, name: string): boolean {
  return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name;
}

/**
 * 先の道具の一覧から、session に見える名前を作る。
 * toolPrefix があれば、前置きで始まる物だけを残して前置きを剥がす（前置きだけの名前は外す）。allow が無ければ全部、deny が勝つ。
 * 役割 memory の接続は exposeMemoryWrite が無い限り `event` を見せない。claude の道具名の規則に合わない物は外す。
 */
export function visibleToolNames(c: McpConnection, remoteNames: string[]): string[] {
  const out: string[] = [];
  for (const raw of remoteNames) {
    let n = raw;
    if (c.toolPrefix !== undefined) {
      if (!raw.startsWith(c.toolPrefix) || raw.length === c.toolPrefix.length) continue;
      n = raw.slice(c.toolPrefix.length);
    }
    if (c.role === "memory" && n === "event" && !c.exposeMemoryWrite) continue;
    if (c.tools?.allow && !c.tools.allow.some((p) => matchTool(p, n))) continue;
    if (c.tools?.deny?.some((p) => matchTool(p, n))) continue;
    if (!VISIBLE_TOOL_NAME.test(n)) continue;
    out.push(n);
  }
  return out;
}

/** 道具の一覧の写しを取った時の設定の hash（URL・headers・toolPrefix・絞り込み。鍵は含めない）。 */
export function configHash(c: McpConnection): string {
  const j = JSON.stringify({ url: c.url, headers: c.headers ?? {}, toolPrefix: c.toolPrefix ?? null, tools: c.tools ?? null, role: c.role ?? null, expose: c.exposeMemoryWrite ?? false });
  return createHash("sha256").update(j).digest("hex").slice(0, 32);
}
