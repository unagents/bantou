import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { MAX_REPORT_TEXT, REPORT_KINDS, getReportHandler } from "./reports";
import { getWorkerHandler } from "./workers";

export const CAP_ID_HEADER = "x-bantou-cap-id";
export const WORKER_ID_HEADER = "x-bantou-worker-id";

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError } : {}) });

const json = (v: unknown, isError = false) => text(JSON.stringify(v), isError);
const fail = (e: unknown) => json({ error: e instanceof Error ? e.message : String(e) }, true);

/** NUL を含まない文字列。 */
const noNul = (s: string): boolean => !s.includes("\0");

/**
 * /mcp の 1 リクエストを処理する（stateless、JSON 応答）。
 * `report` は常に登録する。送信元は header の cap_id / worker_id で判定し、すぐ "accepted" を返す。
 * cap（x-bantou-cap-id があり x-bantou-worker-id が無い）にだけ worker_start / worker_status / worker_stop も登録する。
 */
export async function handleMcpRequest(req: Request): Promise<Response> {
  const capId = req.headers.get(CAP_ID_HEADER) ?? "";
  const workerId = req.headers.get(WORKER_ID_HEADER) ?? "";
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
  if (capId && !workerId) registerWorkerTools(server, capId);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}

function registerWorkerTools(server: McpServer, capId: string): void {
  const hub = () => getWorkerHandler();
  const unavailable = () => json({ error: "server が起動中のため受け付けられない" }, true);
  server.registerTool(
    "worker_start",
    {
      description:
        "Start a worker (headless claude -p run by the server) with a prompt, or give an existing worker (same worker_id) its next instruction. " +
        "Returns {worker_id, accepted} immediately without waiting for the work; the worker reports back with its own report tool, which resumes you.",
      inputSchema: {
        prompt: z.string().min(1).refine(noNul, { message: "NUL 文字を含められない" }),
        worker_id: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
        repo: z.string().min(1).refine((s) => !s.startsWith("-") && noNul(s), { message: "- で始められない / NUL 不可" }).optional(),
        branch: z.string().min(1).refine((s) => !s.startsWith("-") && noNul(s), { message: "- で始められない / NUL 不可" }).optional(),
      },
    },
    async (args) => {
      const h = hub();
      if (!h) return unavailable();
      try {
        return json(await h.start(capId, args));
      } catch (e) {
        return fail(e);
      }
    },
  );
  server.registerTool(
    "worker_status",
    {
      description:
        "State of your workers: {workers:[{id, state (running|stalled|idle|done|failed|lost), task, last_activity, last_output_at, silent_ms, ...}]}. " +
        "Give worker_id to see one.",
      inputSchema: { worker_id: z.string().regex(/^[A-Za-z0-9_-]+$/).optional() },
    },
    async ({ worker_id }) => {
      const h = hub();
      if (!h) return unavailable();
      try {
        return json(await h.status(capId, worker_id));
      } catch (e) {
        return fail(e);
      }
    },
  );
  server.registerTool(
    "worker_stop",
    {
      description: "Stop a running worker of yours (kills its claude process group). Returns {worker_id, stopped}.",
      inputSchema: { worker_id: z.string().regex(/^[A-Za-z0-9_-]+$/) },
    },
    async ({ worker_id }) => {
      const h = hub();
      if (!h) return unavailable();
      try {
        return json(await h.stop(capId, worker_id));
      } catch (e) {
        return fail(e);
      }
    },
  );
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
