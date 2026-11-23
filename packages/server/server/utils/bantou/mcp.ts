import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { MAX_BASH_PATHS, MAX_BASH_PATH_LENGTH, getBashWorkspace, runBash } from "./bash";

export const WORKER_ID_HEADER = "x-bantou-worker-id";

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError } : {}) });

const json = (v: unknown, isError = false) => text(JSON.stringify(v), isError);
const fail = (e: unknown) => json({ error: e instanceof Error ? e.message : String(e) }, true);

/**
 * /mcp の 1 リクエストを処理する（stateless、JSON 応答）。
 * 道具は `bash` だけ。呼び出し元の worker は header の worker_id で判定する（header 無しには載せない）。
 */
export async function handleMcpRequest(req: Request): Promise<Response> {
  const workerId = req.headers.get(WORKER_ID_HEADER) ?? "";
  const server = new McpServer({ name: "bantou", version: "0.2.0" });
  if (workerId) registerBashTool(server, workerId);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}

function registerBashTool(server: McpServer, workerId: string): void {
  server.registerTool(
    "bash",
    {
      description:
        "Server-guaranteed file operations inside your own path (no shell string). Use it instead of Bash rm to delete temporary things. " +
        "action: 'rm' (only). rm deletes paths relative to your own path (<workspace>/workers/<worker_id>/). " +
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
        return json(await runBash(ws, { workerId }, args));
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
