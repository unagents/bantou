import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { MAX_REPORT_TEXT, REPORT_KINDS, getReportHandler } from "./reports";

export const CAP_ID_HEADER = "x-bantou-cap-id";
export const WORKER_ID_HEADER = "x-bantou-worker-id";

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError } : {}) });

/**
 * /mcp の 1 リクエストを処理する（stateless、JSON 応答）。tool は `report` のみ。
 * 送信元は header の cap_id / worker_id で判定し、すぐ "accepted" を返す。
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
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
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
