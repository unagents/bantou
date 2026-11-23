import { describeSystemInstructions } from "./system-instructions.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import type { Follow } from "./follow.js";
import type { Logger } from "./log.js";
import type { LoginFlow } from "./login.js";
import type { Resessioner } from "./resession.js";
import type { RemoteManager } from "./remotes.js";
import type { RemoteControlSupervisor } from "./remote-control.js";
import type { SessionManager } from "./sessions.js";
import type { ServerLink } from "./server-link.js";
import { packageVersion } from "./version.js";
import { registerSessionTools, registerTools } from "./tools.js";

/** 版は version.ts（compile した binary でも入る）。既存の import 先（server.js）のために再 export する。 */
export { packageVersion };

/** center の MCP server を組み立てる（transport は呼び出し側が繋ぐ）。 */
export function createCenterServer(deps: {
  config: Config;
  supervisor: RemoteControlSupervisor;
  link: ServerLink;
  sessions: SessionManager;
  remotes: RemoteManager;
  follow?: Follow;
  /** center_info に出すシステム埋め込み指示の一覧。省略時は center に組み込みの部品（system-instructions.ts）。 */
  systemInstructions?: { id: string; version: number; title: string }[];
  /** session の再ログイン（pty 入力が要るので wrapper 経由の起動がある時だけ）。 */
  login?: LoginFlow;
  /** server_retire のログ。 */
  log?: Logger;
  /** 呼び出し元が center を起動した所か（外部記憶・追加の MCP の server を読み書きできる。launcher.ts）。 */
  launcher?: boolean;
}): McpServer {
  const server = new McpServer({ name: "bantou-center", version: packageVersion() });
  registerTools(server, { systemInstructions: deps.systemInstructions ?? describeSystemInstructions(), supervisor: deps.supervisor, link: deps.link, sessions: deps.sessions, remotes: deps.remotes, follow: deps.follow, login: deps.login, workspace: deps.config.workspace, launcher: deps.launcher === true, ...(deps.log ? { log: deps.log } : {}) });
  return server;
}

/** session 向け窓口（/mcp/session）の MCP server。owner = 認証済みの呼び出し元 session 名。 */
export function createSessionMcpServer(deps: { remotes: RemoteManager; follow?: Follow; owner: string; resession?: Resessioner }): McpServer {
  const server = new McpServer({ name: "bantou-center-session", version: packageVersion() });
  registerSessionTools(server, { remotes: deps.remotes, owner: deps.owner, ...(deps.follow ? { follow: deps.follow } : {}), ...(deps.resession ? { resession: deps.resession } : {}) });
  return server;
}
