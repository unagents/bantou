import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { MAX_BASH_PATHS, MAX_BASH_PATH_LENGTH, getBashWorkspace, runBash, type BashCaller } from "./bash";
import { MODEL_PATTERN } from "./model";
import { MAX_REPORT_TEXT, REPORT_KINDS, getReportHandler } from "./reports";
import { getWorkerHandler } from "./workers";

export const CAP_ID_HEADER = "x-bantou-cap-id";
export const WORKER_ID_HEADER = "x-bantou-worker-id";
/** cap の task の指揮（lane）の run に付く。worker_start で起動した worker はその task のものになる。 */
export const TASK_ID_HEADER = "x-bantou-task-id";

/** worker_id の形式（worker_start / worker_status / worker_stop で共通）。 */
const WORKER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError } : {}) });

const json = (v: unknown, isError = false) => text(JSON.stringify(v), isError);
const fail = (e: unknown) => json({ error: e instanceof Error ? e.message : String(e) }, true);

/** NUL を含まない文字列。 */
const noNul = (s: string): boolean => !s.includes("\0");

/**
 * /mcp の 1 リクエストを処理する（stateless、JSON 応答）。
 * `report` は常に登録する。送信元は header の cap_id / worker_id で判定し、すぐ "accepted" を返す。
 * `bash` は cap と worker の両方に載せる（header で呼び出し元を判定。header 無しには載せない）。
 * cap（x-bantou-cap-id があり x-bantou-worker-id が無い）にだけ worker_start / worker_status / worker_stop も登録する。
 */
export async function handleMcpRequest(req: Request): Promise<Response> {
  const capId = req.headers.get(CAP_ID_HEADER) ?? "";
  const workerId = req.headers.get(WORKER_ID_HEADER) ?? "";
  const taskId = req.headers.get(TASK_ID_HEADER) ?? "";
  const server = new McpServer({ name: "bantou", version: "0.1.1" });
  server.registerTool(
    "report",
    {
      description:
        "Report to the cap that started you. kind: progress | ask (question) | approve (approval request) | done. " +
        "Returns 'accepted' immediately; end your turn after calling it.",
      inputSchema: {
        kind: z.enum(REPORT_KINDS),
        text: z.string().min(1).max(MAX_REPORT_TEXT),
      },
    },
    async ({ kind, text: body }) => {
      const handler = getReportHandler();
      if (!handler) return text("server が起動中のため受け付けられない", true);
      if (!capId || !workerId) return text(`${CAP_ID_HEADER} / ${WORKER_ID_HEADER} header が必要`, true);
      try {
        await handler(capId, workerId, kind, body);
        return text("accepted");
      } catch (e) {
        return text(e instanceof Error ? e.message : String(e), true);
      }
    },
  );
  if (capId) registerBashTool(server, workerId ? { kind: "worker", capId, workerId } : { kind: "cap", capId });
  if (capId && !workerId) registerWorkerTools(server, capId, taskId || undefined);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}

function registerBashTool(server: McpServer, caller: BashCaller): void {
  server.registerTool(
    "bash",
    {
      description:
        "Server-guaranteed file operations inside your own path (no shell string). Use it instead of Bash rm to delete temporary things. " +
        "action: 'rm' (only). rm deletes paths relative to your own path (a worker: <workspace>/workers/<worker_id>/; a cap: <workspace>/caps/<cap_id>/, and a worker of yours as 'worker:<worker_id>/<path>'). " +
        "Absolute paths, '..', anything resolving (realpath) outside, your path itself, state.json and logs/ are refused (listed in skipped, not an error). " +
        "Symlinks are never followed: the link itself is removed. A directory needs recursive: true. $TMPDIR is <your path>/tmp, so 'tmp' (recursive: true) clears it. " +
        "Returns {removed: string[], skipped: [{path, reason}]}.",
      inputSchema: {
        action: z.string().min(1).max(32),
        paths: z.array(z.string().max(MAX_BASH_PATH_LENGTH)).min(1).max(MAX_BASH_PATHS),
        recursive: z.boolean().optional(),
      },
    },
    async (args) => {
      const ws = getBashWorkspace();
      if (!ws) return json({ error: "server が起動中のため受け付けられない" }, true);
      try {
        return json(await runBash(ws, caller, args));
      } catch (e) {
        return fail(e);
      }
    },
  );
}

function registerWorkerTools(server: McpServer, capId: string, taskId: string | undefined): void {
  const hub = () => getWorkerHandler();
  const unavailable = () => json({ error: "server が起動中のため受け付けられない" }, true);
  server.registerTool(
    "worker_start",
    {
      description:
        "Start a worker (headless claude -p run by the server) with a prompt, or give an existing worker (same worker_id) its next instruction. " +
        "Use it to start a review worker too (separate clone, reads the diff, runs the tests, reports problems), and to send its findings back to the implementing worker with the same worker_id until fixed. " +
        "Start independent parts as separate workers in parallel. Always state in the prompt the deliverable (branch, commit, report location) and how to verify (which tests). " +
        "Optional model (e.g. sonnet, opus, haiku, or a full model id) is passed to claude --model; without it the worker keeps its earlier model, else uses your default worker model, else claude's own default. " +
        "Returns {worker_id, accepted} immediately without waiting for the work; the worker reports back with its own report tool, which resumes you. " +
        "The server never limits how many workers run and never judges whether the host has room: look at peer_status (host load / memory / disk, worker counts, other caps) and decide yourself. " +
        "If you judge the host has no room, set reserve: true: the server queues the worker in arrival order and starts it when a worker of this server ends (at once when no worker is running). " +
        "A queued worker is returned as {worker_id, accepted, reserved: true}; its worker_status state is 'reserved'. End your turn; its own report resumes you. worker_stop cancels a reservation.",
      inputSchema: {
        prompt: z.string().min(1).refine(noNul, { message: "NUL 文字を含められない" }),
        worker_id: z.string().regex(WORKER_ID_PATTERN).optional(),
        repo: z.string().min(1).refine((s) => !s.startsWith("-") && noNul(s), { message: "- で始められない / NUL 不可" }).optional(),
        branch: z.string().min(1).refine((s) => !s.startsWith("-") && noNul(s), { message: "- で始められない / NUL 不可" }).optional(),
        model: z.string().regex(MODEL_PATTERN).optional(),
        reserve: z.boolean().optional(),
      },
    },
    async (args) => {
      const h = hub();
      if (!h) return unavailable();
      try {
        return json(await h.start(capId, args, taskId));
      } catch (e) {
        return fail(e);
      }
    },
  );
  server.registerTool(
    "worker_status",
    {
      description:
        "State of your workers: {workers:[{id, state (reserved|running|stalled|idle|done|failed|lost), task, last_activity, last_output_at, silent_ms, ...}]}. " +
        "Without worker_id it lists the workers of your task. Give worker_id to see one.",
      inputSchema: { worker_id: z.string().regex(WORKER_ID_PATTERN).optional() },
    },
    async ({ worker_id }) => {
      const h = hub();
      if (!h) return unavailable();
      try {
        return json(await h.status(capId, worker_id, taskId));
      } catch (e) {
        return fail(e);
      }
    },
  );
  server.registerTool(
    "peer_status",
    {
      description:
        "Read-only board of this server (the host your workers run on): {self, peers, host}. " +
        "host = {workers (running now), reserved (queued worker reservations), max_parallel_tasks (user-set limit or null = none), " +
        "resources: {at, load1, load5, load15, cpus, mem_total, mem_free, disk_total, disk_free (bytes), workers} measured just now}. " +
        "self / peers[] = {cap_ref (opaque), running_workers, waiting_tasks, reserved_workers, no_followers}; peers are the other caps of this server (counts only, never their content). " +
        "The server has no threshold and does not judge whether there is room: you decide how many workers to start from these numbers (and use worker_start reserve: true when you judge there is no room). " +
        "Your task's same_branch notice (tasks that push to the same branch) is in your first instruction.",
      inputSchema: {},
    },
    async () => {
      const f = getPeerStatusHandler();
      if (!f) return unavailable();
      try {
        return json(await f(capId));
      } catch (e) {
        return fail(e);
      }
    },
  );
  server.registerTool(
    "worker_stop",
    {
      description: "Stop a running worker of yours (kills its claude process group). Returns {worker_id, stopped}.",
      inputSchema: { worker_id: z.string().regex(WORKER_ID_PATTERN) },
    },
    async ({ worker_id }) => {
      const h = hub();
      if (!h) return unavailable();
      try {
        return json(await h.stop(capId, worker_id, taskId));
      } catch (e) {
        return fail(e);
      }
    },
  );
}

/** peer_status の中身を作る（daemon が設定する。未設定の間は拒否）。 */
let peerStatusHandler: ((capId: string) => unknown | Promise<unknown>) | undefined;

export function setPeerStatusHandler(f: ((capId: string) => unknown | Promise<unknown>) | undefined): void {
  peerStatusHandler = f;
}

export function getPeerStatusHandler(): ((capId: string) => unknown | Promise<unknown>) | undefined {
  return peerStatusHandler;
}

export interface McpListener {
  /** 実際に bind した port（port 0 の時に実値）。 */
  port: number;
  close(): Promise<void>;
}

/** /mcp 用の HTTP listener。Nitro の h3App を載せる request listener を受ける。 */
export function startMcpListener(
  listener: RequestListener,
  opts: { port: number; bind: string },
): Promise<McpListener> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer(listener);
    server.once("error", reject);
    server.listen({ host: opts.bind, port: opts.port }, () => {
      server.off("error", reject);
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
            server.closeAllConnections();
          }),
      });
    });
  });
}
