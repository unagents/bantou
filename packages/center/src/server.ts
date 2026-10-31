import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import type { Follow } from "./follow.js";
import type { RemoteManager } from "./remotes.js";
import type { RemoteControlSupervisor } from "./remote-control.js";
import type { SessionManager } from "./sessions.js";
import type { ServerLink } from "./server-link.js";
import { registerSessionTools, registerTools } from "./tools.js";

/** package.json の version（src/ と dist/ のどちらからでも ../package.json）。 */
function packageVersion(): string {
  try {
    const p = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return p.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** center の MCP server を組み立てる（transport は呼び出し側が繋ぐ）。 */
export function createCenterServer(deps: {
  config: Config;
  supervisor: RemoteControlSupervisor;
  link: ServerLink;
  sessions: SessionManager;
  remotes: RemoteManager;
  follow?: Follow;
}): McpServer {
  const server = new McpServer({ name: "bantou-center", version: packageVersion() });
  registerTools(server, { supervisor: deps.supervisor, link: deps.link, sessions: deps.sessions, remotes: deps.remotes, follow: deps.follow });
  return server;
}

/** session 向け窓口（/mcp/session）の MCP server。owner = 認証済みの呼び出し元 session 名。 */
export function createSessionMcpServer(deps: { remotes: RemoteManager; owner: string }): McpServer {
  const server = new McpServer({ name: "bantou-center-session", version: packageVersion() });
  registerSessionTools(server, deps);
  return server;
}
