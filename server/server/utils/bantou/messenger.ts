import { join } from "node:path";
import { SERVER_NAME, type AgentKind } from "@agent-hand/bantou-protocol";
import type { RunMode } from "./claude";
import type { MessengerMcpConfig } from "./config";

/** 注入先の MCP server 名。plugin 由来の `agent-messenger` と衝突させない。 */
export const MCP_SERVER_NAME = "bantou-messenger";
/** cap / worker に許可する唯一の tool。 */
export const SEND_MESSAGE_TOOL = `mcp__${MCP_SERVER_NAME}__send_message`;
/** MCP の AGENT_MESSENGER_CLIENT_SPEC の既定（args を差し替えた時は messenger.env で上書き）。 */
const CLIENT_SPEC = "0.9.0";

/** 内蔵 broker の接続情報。起動後に daemon が渡す。 */
export interface BrokerInfo {
  host: string;
  port: number;
  token: string;
}

/** 子の claude に引き継がせない、messenger 系の env（本番 broker へ繋がる経路になる）。 */
const INHERITED_ENV = /^(AGENT_MESSENGER_|CLAUDE_CODE_MESSAGING_)/;

/** 継承 env から messenger 系を除き、session.env を上に重ねる。 */
export function childEnv(
  base: NodeJS.ProcessEnv,
  sessionEnv: Record<string, string>,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!INHERITED_ENV.test(k)) out[k] = v;
  return { ...out, ...sessionEnv };
}

/** `--mcp-config` に渡す JSON 文字列。 */
export function buildMcpConfig(
  kind: AgentKind,
  id: string,
  broker: BrokerInfo,
  mcp: MessengerMcpConfig,
  workspace: string,
): string {
  const env: Record<string, string> = {
    AGENT_MESSENGER_HOST: broker.host,
    AGENT_MESSENGER_PORT: String(broker.port),
    AGENT_MESSENGER_DISCOVERY: "off",
    AGENT_MESSENGER_NAME: `bantou-${kind}-${id}`,
    AGENT_MESSENGER_CLIENT_SPEC: CLIENT_SPEC,
    // broker に届かなくても detached な broker を勝手に起動させない
    AGENT_MESSENGER_BROKER_CMD: "false",
    // 親の claude の messaging session を打ち消す
    CLAUDE_CODE_MESSAGING_SOCKET: "",
    CLAUDE_CODE_MESSAGING_TOKEN: "",
    // 書き込めるキャッシュ先。npx の cache と、loader が platform client を入れる先
    npm_config_cache: join(workspace, ".npm-cache"),
    AGENT_MESSENGER_PKGS_DIR: join(workspace, ".messenger-pkgs"),
  };
  if (broker.token !== "") env.AGENT_MESSENGER_TOKEN = broker.token;
  Object.assign(env, mcp.env);
  return JSON.stringify({
    mcpServers: {
      [MCP_SERVER_NAME]: { type: "stdio", command: mcp.command, args: mcp.args, env },
    },
  });
}

/**
 * `--append-system-prompt` の本文。id ごとに固定（claude の system prompt snapshot が resume で再利用される）。
 * argv 内の ` -- ` を含めない（孤児回収の matchesSession が最初の ` -- ` で切る）。
 */
export function buildSystemPrompt(kind: AgentKind, id: string): string {
  const send =
    `You talk to bantou-server only through the MCP tool send_message (server ${MCP_SERVER_NAME}). ` +
    `Call it with to="${SERVER_NAME}" and message set to one JSON object as a string. ` +
    "Send it and move on, do not wait for a reply.";
  if (kind === "cap") {
    return [
      `You are the bantou remote cap "${id}", running headlessly under bantou-server.`,
      send,
      "Types you may send:",
      `1. spawn_worker starts a worker: {"bantou":1,"type":"spawn_worker","worker_id":"<new-id>","cap_id":"${id}","prompt":"<task for the worker>"}`,
      `2. resume_worker answers a worker that asked: {"bantou":1,"type":"resume_worker","worker_id":"<id>","prompt":"<your decision>"}`,
      'The worker reports back with worker_report (kind "done" or "ask"). bantou-server then resumes you with that report in your prompt. After sending spawn_worker or resume_worker, end your turn.',
      "worker_id must match [A-Za-z0-9_-]+.",
    ].join("\n");
  }
  return [
    `You are the bantou worker "${id}", running headlessly under bantou-server and owned by a cap.`,
    send,
    "When you finish the task, or when you need a decision, send worker_report as your last action:",
    `{"bantou":1,"type":"worker_report","worker_id":"${id}","kind":"done","text":"<what you did and the result>"}`,
    `{"bantou":1,"type":"worker_report","worker_id":"${id}","kind":"ask","text":"<your question>"}`,
    "After sending kind=ask, end your turn. You are resumed with the answer.",
  ].join("\n");
}

/**
 * claude へ注入する引数。`--session-id` / `--resume` より後ろ、プロンプト区切りの前に置く。
 * system prompt は new の時だけ渡す（resume は snapshot が使われる）。
 */
export function buildInjectArgs(
  kind: AgentKind,
  id: string,
  mode: RunMode,
  broker: BrokerInfo,
  mcp: MessengerMcpConfig,
  workspace: string,
): string[] {
  return [
    "--mcp-config",
    buildMcpConfig(kind, id, broker, mcp, workspace),
    "--strict-mcp-config",
    ...(mode === "new" ? ["--append-system-prompt", buildSystemPrompt(kind, id)] : []),
  ];
}
