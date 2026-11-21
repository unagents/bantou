/**
 * 統括の道具（session_brief・coordinator_session_create）を出す、独立した MCP の server（http だけ。stdio は無い）。
 *
 * - center の daemon が子 process として起動する（`bantou-center coordinator-mcp`）。center の終了で止まり、落ちたら再起動する。
 * - 待ち受けは 127.0.0.1 の port（state dir の coordinator-mcp.json。初回に空き port を選んで作り、以後変わらない）。
 * - 呼び手の確認は、設定の headers の `Authorization: Bearer <key>` を、coordinator-mcp.json の key と定時間で比べる。
 * - center への経路は、center の外向けの窓口 /mcp（center の token で MCP client として繋ぐ）の session_list と session_create だけ。
 * - 使える session は、設定の mcpServers にこの server の 1 項目（type: http・url・headers）を書いた session だけ（key は他の session に渡らない）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerCoordinatorTools, type CoordinatorDeps } from "./coordinator.js";
import { selfCommand } from "./status-line.js";
import type { SessionInfo } from "./sessions.js";

export const COORDINATOR_MCP_FILE = "coordinator-mcp.json";
export const COORDINATOR_MCP_PATH = "/mcp";
export const COORDINATOR_MCP_HOST = "127.0.0.1";
/** 子 process が center の token を受け取る env。 */
export const CENTER_TOKEN_ENV = "BANTOU_CENTER_TOKEN";
const KEY_MIN = 32;

export interface CoordinatorMcpState {
  port: number;
  key: string;
}

const isPort = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535;

/** 127.0.0.1 の空き port を 1 つ選ぶ（OS に割り当てさせて閉じる）。 */
export const pickFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once("error", reject);
    srv.listen(0, COORDINATOR_MCP_HOST, () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close((e) => (e ? reject(e) : resolve(port)));
    });
  });

/** 同じ host の子 process が center へ繋ぐ時の host（center の --bind から。全部受ける bind・localhost は 127.0.0.1、IPv6 は [ ] で囲む）。 */
export const centerHostOf = (bind: string): string =>
  bind === "" || bind === "0.0.0.0" || bind === "::" || bind === "localhost" ? "127.0.0.1" : bind.includes(":") && !bind.startsWith("[") ? `[${bind}]` : bind;

/** state dir の coordinator-mcp.json を読む。無ければ作る（key は乱数、port は空き port。書いた後は変えない）。 */
export async function ensureCoordinatorState(stateDir: string, log: (m: string) => void = () => {}, pickPort: () => Promise<number> = pickFreePort): Promise<CoordinatorMcpState> {
  const path = join(stateDir, COORDINATOR_MCP_FILE);
  if (existsSync(path)) {
    try {
      const v = JSON.parse(readFileSync(path, "utf8")) as Partial<CoordinatorMcpState>;
      if (isPort(v.port) && typeof v.key === "string" && v.key.length >= KEY_MIN) return { port: v.port, key: v.key };
      log(`${COORDINATOR_MCP_FILE} の中身が不正なので作り直さず止める（port は 1〜65535、key は ${KEY_MIN} 文字以上）`);
    } catch (e) {
      log(`${COORDINATOR_MCP_FILE} を読めない: ${(e as Error).message}`);
    }
    throw new Error(`${path} が不正（直すか、消すと作り直す）`);
  }
  const state: CoordinatorMcpState = { port: await pickPort(), key: randomBytes(32).toString("hex") };
  mkdirSync(stateDir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  log(`${COORDINATOR_MCP_FILE} を作った（port ${state.port}。key は出さない）`);
  return state;
}

export const coordinatorUrl = (state: Pick<CoordinatorMcpState, "port">): string => `http://${COORDINATOR_MCP_HOST}:${state.port}${COORDINATOR_MCP_PATH}`;

/** 設定の mcpServers に書く 1 項目（普通の Claude Code の mcp.json の形）。 */
export const coordinatorEntry = (state: CoordinatorMcpState): { type: "http"; url: string; headers: { Authorization: string } } => ({
  type: "http",
  url: coordinatorUrl(state),
  headers: { Authorization: `Bearer ${state.key}` },
});

/** 設定の 1 項目が、この統括の server を指す物か（url で見る）。 */
export const isCoordinatorEntry = (def: unknown, state: Pick<CoordinatorMcpState, "port">): boolean => {
  if (typeof def !== "object" || def === null) return false;
  const d = def as { type?: unknown; url?: unknown };
  if ((d.type !== "http" && d.type !== undefined) || typeof d.url !== "string") return false;
  try {
    const u = new URL(d.url);
    return u.protocol === "http:" && (u.hostname === COORDINATOR_MCP_HOST || u.hostname === "localhost") && Number(u.port) === state.port && u.pathname === COORDINATOR_MCP_PATH;
  } catch {
    return false;
  }
};

// ---- center への経路 ----

/** center の外向けの窓口 /mcp を、token で MCP client として呼ぶ（呼ぶたびに繋いで閉じる）。 */
export function centerBackend(opts: { url: string; token: string }): Pick<CoordinatorDeps, "sessions" | "createSession"> {
  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const client = new Client({ name: "bantou-coordinator-mcp", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(opts.url), { requestInit: { headers: { Authorization: `Bearer ${opts.token}` } } });
    try {
      await client.connect(transport);
      const r = (await client.callTool({ name, arguments: args })) as { content?: { type: string; text?: string }[]; isError?: boolean };
      const text = r.content?.find((c) => c.type === "text")?.text ?? "";
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* 文のまま */
      }
      if (r.isError) {
        const msg = typeof parsed === "object" && parsed !== null && typeof (parsed as { error?: unknown }).error === "string" ? (parsed as { error: string }).error : text;
        throw new Error(msg);
      }
      return parsed;
    } finally {
      // center の MCP session は DELETE で閉じる（閉じないと TTL まで残り、上限を越えると initialize が 503 になる）。失敗は無視
      await transport.terminateSession().catch(() => {});
      await client.close().catch(() => {});
    }
  };
  return {
    sessions: async () => {
      const v = await call("session_list", {});
      if (!Array.isArray(v)) throw new Error("session_list の返り値が配列でない");
      return v as SessionInfo[];
    },
    createSession: async (input) => {
      // path は渡さない（center の workspace の下だけ）
      const v = (await call("session_create", { name: input.name, start: input.start, ...(input.instructions ? { settings: { instructions: input.instructions } } : {}) })) as { name?: string; state?: string };
      return { name: String(v.name ?? input.name), state: String(v.state ?? "") };
    },
  };
}

// ---- server ----

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();
/** header の Bearer が key と一致するか（定時間）。 */
export function bearerIs(header: string | undefined, key: string): boolean {
  if (!header?.startsWith("Bearer ") || key.length < KEY_MIN) return false;
  return timingSafeEqual(digest(header.slice("Bearer ".length)), digest(key));
}

export interface CoordinatorHttpHandle {
  port: number;
  close(): Promise<void>;
}

const sendJson = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

const readBody = (req: IncomingMessage, max = 1024 * 1024): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });

/** 統括の MCP の server を http で待ち受ける（stateless: 呼び出しごとに server を作る）。 */
export async function startCoordinatorHttp(opts: {
  port: number;
  key: string;
  backend: Pick<CoordinatorDeps, "sessions" | "createSession">;
  log?: (m: string) => void;
  now?: () => number;
}): Promise<CoordinatorHttpHandle> {
  const log = opts.log ?? (() => {});
  let allowedHosts: string[] = [];
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? "").split("?", 1)[0];
    if (path !== COORDINATOR_MCP_PATH) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    // 呼び手の確認が先（key の無い・違う呼び手は何も知れない）
    const auth = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization;
    if (!bearerIs(auth, opts.key)) {
      sendJson(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
      return;
    }
    // DNS rebinding 対策: Host は自分宛だけ
    if (!allowedHosts.includes(req.headers.host ?? "")) {
      sendJson(res, 403, { error: "forbidden host" });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" }, { allow: "POST" });
      return;
    }
    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "bad request body" }, id: null });
      return;
    }
    const server = new McpServer({ name: "bantou-coordinator", version: "0.1.0" });
    registerCoordinatorTools(server, { ...opts.backend, log, ...(opts.now ? { now: opts.now } : {}) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.once("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
  const http: Server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      log(`HTTP 処理エラー: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, COORDINATOR_MCP_HOST, () => {
      http.off("error", reject);
      resolve();
    });
  });
  const port = (http.address() as AddressInfo).port;
  allowedHosts = [`${COORDINATOR_MCP_HOST}:${port}`, `localhost:${port}`];
  log(`統括の MCP server 待受: http://${COORDINATOR_MCP_HOST}:${port}${COORDINATOR_MCP_PATH}`);
  return {
    port,
    close: async () => {
      const closed = new Promise<void>((resolve) => http.close(() => resolve()));
      http.closeAllConnections();
      await closed;
    },
  };
}

// ---- サブコマンド `bantou-center coordinator-mcp` ----

export const COORDINATOR_MCP_USAGE = `usage: bantou-center coordinator-mcp serve --state-dir <dir> --center-url <http://host:port/mcp>   （center が子として起動する。env ${CENTER_TOKEN_ENV} に center の token）
       bantou-center coordinator-mcp show [--state-dir <dir>]   （設定の mcpServers に書く 1 項目を出す）`;

const argOf = (argv: string[], key: string): string | undefined => {
  const i = argv.indexOf(key);
  return i >= 0 ? argv[i + 1] : undefined;
};

export async function runCoordinatorMcp(
  argv: string[],
  defaultStateDir: string,
  io: { out: (l: string) => void; err: (l: string) => void; env?: NodeJS.ProcessEnv },
): Promise<number | "serving"> {
  const env = io.env ?? process.env;
  const sub = argv[0];
  const stateDir = argOf(argv, "--state-dir") ?? defaultStateDir;
  if (sub === "show") {
    if (!existsSync(join(stateDir, COORDINATOR_MCP_FILE))) {
      io.err(`${join(stateDir, COORDINATOR_MCP_FILE)} が無い（center を http で一度起動すると作られる）`);
      return 1;
    }
    const state = await ensureCoordinatorState(stateDir);
    io.out(JSON.stringify({ "bantou-coordinator": coordinatorEntry(state) }, null, 2));
    return 0;
  }
  if (sub === "serve") {
    const centerUrl = argOf(argv, "--center-url");
    const token = env[CENTER_TOKEN_ENV];
    if (!centerUrl || !token) {
      io.err(`--center-url と env ${CENTER_TOKEN_ENV} が要る`);
      return 2;
    }
    delete env[CENTER_TOKEN_ENV];
    const state = await ensureCoordinatorState(stateDir, (m) => io.err(m));
    await startCoordinatorHttp({ port: state.port, key: state.key, backend: centerBackend({ url: centerUrl, token }), log: (m) => io.err(`[coordinator-mcp] ${m}`) });
    return "serving";
  }
  io.err(COORDINATOR_MCP_USAGE);
  return 2;
}

// ---- center による起動 ----

export interface CoordinatorChild {
  stop(): void;
}

/** center が統括の server を子 process として起動し、落ちたら間を置いて再起動する。stop() で止める。 */
export function startCoordinatorChild(opts: {
  stateDir: string;
  centerUrl: string;
  token: string;
  log: (m: string) => void;
  /** テスト用: 起動する argv（既定は center 自身の coordinator-mcp serve）。 */
  command?: string[];
  env?: NodeJS.ProcessEnv;
}): CoordinatorChild {
  let child: ChildProcess | null = null;
  let stopped = false;
  let failures = 0;
  let timer: NodeJS.Timeout | null = null;
  const launch = (): void => {
    const [cmd, ...rest] = opts.command ?? [...selfCommand(), "coordinator-mcp", "serve", "--state-dir", opts.stateDir, "--center-url", opts.centerUrl];
    const startedAt = Date.now();
    const c = spawn(cmd, rest, { env: { ...(opts.env ?? process.env), [CENTER_TOKEN_ENV]: opts.token }, stdio: ["ignore", "ignore", "pipe"] });
    child = c;
    c.stderr?.on("data", (d: Buffer) => {
      for (const l of d.toString("utf8").split("\n")) if (l.trim()) opts.log(`coordinator-mcp: ${l.trim()}`);
    });
    c.once("error", (e) => opts.log(`統括の MCP server を起動できない: ${e.message}`));
    c.once("exit", (code, signal) => {
      child = null;
      if (stopped) return;
      failures = Date.now() - startedAt > 60_000 ? 0 : failures + 1;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));
      opts.log(`統括の MCP server が終了（code=${code ?? "-"} signal=${signal ?? "-"}）。${Math.round(delay / 1000)} 秒後に再起動`);
      timer = setTimeout(launch, delay);
      timer.unref();
    });
  };
  launch();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      child?.kill("SIGTERM");
    },
  };
}
