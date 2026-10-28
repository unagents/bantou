import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { MIN_TOKEN_LEN } from "./config.js";
import type { Logger } from "./log.js";

export const MCP_PATH = "/mcp";
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

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== MCP_PATH) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    if (!bearerMatches(req.headers.authorization, token)) {
      sendJson(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
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
      if (!s) {
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
      const server = opts.createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        // DNS rebinding 対策: Host（ポート込み）と、Origin があればそれも自分宛のものだけ通す
        ...(allowed
          ? { enableDnsRebindingProtection: true, allowedHosts: allowed.hosts, allowedOrigins: allowed.origins }
          : {}),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server, lastActive: Date.now(), inflight: 0 });
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
