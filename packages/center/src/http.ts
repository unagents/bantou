import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { MIN_TOKEN_LEN } from "./config.js";
import type { Core } from "./core.js";
import type { SessionTokens } from "./session-auth.js";
import type { Logger } from "./log.js";

export const MCP_PATH = "/mcp";
/** session（master-cap）向けの MCP 窓口。認証は session ごとの使い捨て token + header X-Bantou-Session。 */
export const SESSION_MCP_PATH = "/mcp/session";
const OWNER_HEADER = "x-bantou-session";
const SESSION_NAME = /^[A-Za-z0-9_-]+$/;
/** core の SSE に流す keep-alive コメントの間隔。 */
export const SSE_KEEPALIVE_MS = 15_000;
const CORE_PATH = /^\/sessions\/([A-Za-z0-9_-]+)\/(output|input|resize)$/;
/** POST ボディの上限。 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** リクエストが無いまま放置された session を閉じるまでの時間（30 分）。 */
export const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
/** 同時に保持する session 数の上限。超えたら新規 initialize を 503 で断る。 */
export const MAX_SESSIONS = 32;
/** 放置 session の掃除間隔。 */
const SWEEP_INTERVAL_MS = 60 * 1000;

export interface HttpHandle {
  /** 実際に待ち受けているポート（port 0 指定時の確認用）。 */
  port: number;
  /** http server と全 MCP session を閉じる。 */
  close(): Promise<void>;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  /** どの窓口で作った MCP session か（別の窓口からは使えない）。 */
  window: "external" | "session";
  /** session 窓口の呼び出し元 session 名。 */
  owner?: string;
  /** 最後にリクエストを受けた／処理が終わった時刻。 */
  lastActive: number;
  /** 処理中のリクエスト数（開きっぱなしの SSE ストリームを含む）。 */
  inflight: number;
}

/** HTTP ステータス付きのエラー。 */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** wildcard bind か（どのホスト名宛でも受ける待受）。 */
const isWildcard = (bind: string): boolean => bind === "" || bind === "0.0.0.0" || bind === "::";

/** loopback だけに待ち受ける bind か。 */
const isLoopback = (bind: string): boolean => ["127.0.0.1", "localhost", "::1", "[::1]"].includes(bind);

/**
 * DNS rebinding 対策で許可する Host ヘッダ値と Origin。bind が wildcard 以外ならその名前も許可する。
 * loopback 以外に bind する時は別ホストから届く前提なので、Host / Origin の絞り込みはせず null を返す（Bearer token で守る）。
 */
export function allowedHostsFor(bind: string, port: number): { hosts: string[]; origins: string[] } | null {
  if (!isLoopback(bind)) return null;
  const names = ["127.0.0.1", "localhost", "[::1]"];
  if (!isWildcard(bind)) names.push(bind.includes(":") && !bind.startsWith("[") ? `[${bind}]` : bind);
  const hosts = [...new Set(names)].map((n) => `${n}:${port}`);
  return { hosts, origins: hosts.map((h) => `http://${h}`) };
}

/** Authorization ヘッダが `Bearer <token>` で token と一致するか（定時間比較）。 */
export function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(header.slice("Bearer ".length)), digest(token));
}

const sendJson = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

const rpcError = (res: ServerResponse, status: number, message: string, headers?: Record<string, string>): void =>
  sendJson(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null }, headers);

/** ボディを JSON として読む。上限超過は HttpError(413)、不正 JSON は Error。 */
function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) {
      reject(new HttpError(413, "ボディが大きすぎる"));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        // 読むのをやめて捨てる。socket は 413 を返してから閉じる（呼び出し側が connection: close を付ける）
        req.removeAllListeners("data");
        chunks.length = 0;
        reject(new HttpError(413, "ボディが大きすぎる"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("JSON として不正"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Streamable HTTP で MCP を提供する（`/mcp`、`Authorization: Bearer <token>` 必須）。
 * McpServer は transport を 1 つしか持てないので、MCP session ごとに McpServer と transport を作る。
 */
export async function startHttpServer(opts: {
  createServer: () => McpServer;
  /** /mcp/session 用の MCP server。owner = 認証済みの呼び出し元 session 名。省略時は /mcp/session を提供しない。 */
  createSessionServer?: (owner: string) => McpServer;
  /** /mcp/session の認証（session ごとの使い捨て token）。createSessionServer と一緒に渡す。 */
  sessionAuth?: SessionTokens;
  /** pty 出力の core。渡すと /sessions/<name>/{output,input,resize} を外向け token で提供する。 */
  core?: Core;
  /** SSE の keep-alive 間隔（テスト用）。 */
  keepAliveMs?: number;
  port: number;
  bind: string;
  /** Bearer token（MIN_TOKEN_LEN 文字以上）。合わない・無いリクエストは 401。 */
  token: string;
  log: Logger;
  /** 放置 session を閉じるまでの時間。 */
  sessionIdleTtlMs?: number;
  /** 放置 session の掃除間隔。 */
  sweepIntervalMs?: number;
  /** 同時 session 数の上限。 */
  maxSessions?: number;
}): Promise<HttpHandle> {
  const { log, token } = opts;
  if (token.length < MIN_TOKEN_LEN) throw new Error(`token は ${MIN_TOKEN_LEN} 文字以上が必要`);
  const idleTtlMs = opts.sessionIdleTtlMs ?? SESSION_IDLE_TTL_MS;
  const maxSessions = opts.maxSessions ?? MAX_SESSIONS;
  const sessions = new Map<string, Session>();
  /** initialize 処理中（まだ sessions に入っていない）の数。上限判定に含める。 */
  let pending = 0;
  let allowed = allowedHostsFor(opts.bind, opts.port);

  /** ボディを読む。失敗時は応答済みで undefined を返す（413 は読み捨てて connection: close）。 */
  const readBody = async (req: IncomingMessage, res: ServerResponse): Promise<{ body: unknown } | undefined> => {
    try {
      return { body: await readJson(req) };
    } catch (e) {
      if (e instanceof HttpError) {
        rpcError(res, e.status, e.message, { connection: "close" });
      } else {
        rpcError(res, 400, (e as Error).message);
      }
      return undefined;
    }
  };

  const closeSession = async (id: string, s: Session, reason: string): Promise<void> => {
    if (!sessions.delete(id)) return;
    log(`MCP session 終了: ${id} (${reason}, 計 ${sessions.size})`);
    await s.server.close().catch(() => {});
  };

  /** core の SSE / 入力 / サイズ変更（認証済み）。 */
  const handleCore = async (
    req: IncomingMessage,
    res: ServerResponse,
    name: string,
    kind: "output" | "input" | "resize",
    query: string,
  ): Promise<void> => {
    const core = opts.core!;
    const method = req.method ?? "";
    if (!core.has(name)) {
      sendJson(res, 404, { error: "未定義の session" });
      return;
    }
    if (kind === "output") {
      if (method !== "GET") {
        sendJson(res, 405, { error: "method not allowed" }, { allow: "GET" });
        return;
      }
      // 続きの位置: Last-Event-ID（再接続で自動付与）が先、無ければ ?after=
      const parseId = (v: string | null | undefined): number | undefined =>
        v !== null && v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined;
      const lei = req.headers["last-event-id"];
      const after = parseId(Array.isArray(lei) ? lei[0] : lei) ?? parseId(new URLSearchParams(query).get("after"));
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.flushHeaders();
      let ka: NodeJS.Timeout | null = null;
      const unsub = core.subscribe(name, after, (ev) => {
        if (res.writableEnded) return;
        if (ev.type === "reset") res.write("event: reset\ndata: {}\n\n");
        else if (ev.type === "chunk") res.write(`id: ${ev.id}\nevent: output\ndata: ${ev.data.toString("base64")}\n\n`);
        else {
          if (ka) clearInterval(ka);
          res.end();
        }
      });
      if (!unsub) {
        res.end();
        return;
      }
      ka = setInterval(() => {
        if (!res.writableEnded) res.write(": ka\n\n");
      }, opts.keepAliveMs ?? SSE_KEEPALIVE_MS);
      ka.unref();
      res.once("close", () => {
        unsub();
        if (ka) clearInterval(ka);
      });
      return;
    }
    if (method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" }, { allow: "POST" });
      return;
    }
    let body: unknown;
    try {
      body = await readJson(req);
    } catch (e) {
      sendJson(res, e instanceof HttpError ? e.status : 400, { error: (e as Error).message }, e instanceof HttpError ? { connection: "close" } : {});
      return;
    }
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    if (kind === "input") {
      if (typeof b.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(b.data)) {
        sendJson(res, 400, { error: "data は base64 文字列" });
        return;
      }
      if (!core.input(name, Buffer.from(b.data, "base64"))) {
        sendJson(res, 409, { error: "session が実行中でない" });
        return;
      }
    } else {
      const ok = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 1000;
      if (!ok(b.cols) || !ok(b.rows)) {
        sendJson(res, 400, { error: "cols / rows は 1〜1000 の整数" });
        return;
      }
      if (!core.resize(name, b.cols, b.rows)) {
        sendJson(res, 409, { error: "session が実行中でない" });
        return;
      }
    }
    res.writeHead(204);
    res.end();
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const [path, query = ""] = (req.url ?? "").split("?", 2);
    const coreMatch = opts.core ? CORE_PATH.exec(path) : null;
    let window: "external" | "session";
    let owner: string | undefined;
    if (path === MCP_PATH) {
      window = "external";
      if (!bearerMatches(req.headers.authorization, token)) {
        sendJson(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
        return;
      }
    } else if (path === SESSION_MCP_PATH && opts.createSessionServer && opts.sessionAuth) {
      window = "session";
      // token はその session 名に発行された現在のものだけ通す（外向け token・他 session の token は 401）
      const h = req.headers[OWNER_HEADER];
      const name = Array.isArray(h) ? h[0] : h;
      const auth = req.headers.authorization;
      if (!name || !SESSION_NAME.test(name) || !auth?.startsWith("Bearer ") || !opts.sessionAuth.verify(name, auth.slice("Bearer ".length))) {
        sendJson(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
        return;
      }
      owner = name;
    } else if (coreMatch) {
      if (!bearerMatches(req.headers.authorization, token)) {
        sendJson(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
        return;
      }
      if (allowed && !allowed.hosts.includes(req.headers.host ?? "")) {
        sendJson(res, 403, { error: "forbidden host" });
        return;
      }
      await handleCore(req, res, coreMatch[1], coreMatch[2] as "output" | "input" | "resize", query);
      return;
    } else {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const method = req.method ?? "";
    if (method !== "POST" && method !== "GET" && method !== "DELETE") {
      sendJson(res, 405, { error: "method not allowed" }, { allow: "GET, POST, DELETE" });
      return;
    }
    const header = req.headers["mcp-session-id"];
    const sid = Array.isArray(header) ? header[0] : header;

    if (sid) {
      const s = sessions.get(sid);
      if (!s || s.window !== window || s.owner !== owner) {
        rpcError(res, 404, "session が存在しない");
        return;
      }
      s.inflight++;
      s.lastActive = Date.now();
      res.once("close", () => {
        s.inflight--;
        s.lastActive = Date.now();
      });
      if (method === "POST") {
        const r = await readBody(req, res);
        if (!r) return;
        await s.transport.handleRequest(req, res, r.body);
      } else {
        await s.transport.handleRequest(req, res);
      }
      return;
    }

    // session 無し: initialize の POST のみ新規 session を作る
    if (method !== "POST") {
      rpcError(res, 400, "mcp-session-id ヘッダが必要");
      return;
    }
    const r = await readBody(req, res);
    if (!r) return;
    if (!isInitializeRequest(r.body)) {
      rpcError(res, 400, "session 無しで受け付けるのは initialize のみ");
      return;
    }
    if (sessions.size + pending >= maxSessions) {
      rpcError(res, 503, `session 数が上限 (${maxSessions}) に達している`, { "retry-after": "30" });
      return;
    }
    pending++;
    try {
      const server = window === "session" ? opts.createSessionServer!(owner!) : opts.createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        // DNS rebinding 対策: Host（ポート込み）と、Origin があればそれも自分宛のものだけ通す
        ...(allowed
          ? { enableDnsRebindingProtection: true, allowedHosts: allowed.hosts, allowedOrigins: allowed.origins }
          : {}),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server, window, ...(owner ? { owner } : {}), lastActive: Date.now(), inflight: 0 });
          log(`MCP session 開始: ${id} (計 ${sessions.size})`);
        },
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id && sessions.delete(id)) log(`MCP session 終了: ${id} (計 ${sessions.size})`);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, r.body);
    } finally {
      pending--;
    }
  };

  const http: Server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      log(`HTTP 処理エラー: ${e instanceof Error ? e.message : String(e)}`);
      rpcError(res, 500, "internal error");
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, opts.bind, () => {
      http.off("error", reject);
      resolve();
    });
  });
  const port = (http.address() as AddressInfo).port;
  allowed = allowedHostsFor(opts.bind, port);
  log(`MCP http 待受: http://${opts.bind.includes(":") ? `[${opts.bind}]` : opts.bind}:${port}${MCP_PATH} (Bearer 認証${allowed ? "" : "、Host 検査なし"})`);

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of [...sessions]) {
      if (s.inflight === 0 && now - s.lastActive >= idleTtlMs) {
        void closeSession(id, s, `${Math.round(idleTtlMs / 1000)} 秒リクエスト無し`);
      }
    }
  }, opts.sweepIntervalMs ?? SWEEP_INTERVAL_MS);
  sweep.unref();

  return {
    port,
    close: async () => {
      clearInterval(sweep);
      const closed = new Promise<void>((resolve) => http.close(() => resolve()));
      http.closeAllConnections();
      for (const s of [...sessions.values()]) {
        await s.server.close().catch(() => {});
      }
      sessions.clear();
      await closed;
    },
  };
}
