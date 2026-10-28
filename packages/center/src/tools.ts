import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AGENT_ID_PATTERN } from "@agent-hand/bantou-protocol";
import { z } from "zod";
import type { RemoteControlSupervisor } from "./remote-control.js";
import type { ServerLink } from "./server-link.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const json = (value: unknown, isError = false): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

/** 例外を `{ error }` の isError 結果にして返す。 */
async function guard(fn: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, true);
  }
}

/** server の返信が失敗（error 返信または ok:false）か。 */
const isFailure = (r: { type: string; ok?: boolean }): boolean => r.type === "error" || r.ok === false;

const agentId = z.string().regex(AGENT_ID_PATTERN, "英数字と _ - のみ");
const notDash = (s: string): boolean => !s.startsWith("-");
// server は NUL を含む指示を黙って無視する（返信が来ず待ち続ける）ので、ここで弾く
const noNul = (s: string): boolean => !s.includes("\0");
const noNulMsg = { message: "NUL 文字を含められない" };
const gitArg = z.string().min(1).refine(notDash, { message: "- で始められない" }).refine(noNul, noNulMsg);
const prompt = z.string().min(1).refine(noNul, noNulMsg);
const serverName = z.string().min(1).describe("config の servers[].name");
const projectName = z.string().min(1).describe("config の projects[].name");

export function registerTools(
  server: McpServer,
  deps: { supervisor: RemoteControlSupervisor; link: ServerLink },
): void {
  const { supervisor, link } = deps;

  server.registerTool(
    "rc_list",
    { title: "remote-control 一覧", description: "全 project の claude remote-control の状態を返す" },
    () => guard(() => json(supervisor.list())),
  );
  server.registerTool(
    "rc_start",
    {
      title: "remote-control 起動",
      description: "project の claude remote-control を起動する（起動済みなら現状を返す）",
      inputSchema: { project: projectName },
    },
    ({ project }) => guard(async () => json(await supervisor.start(project))),
  );
  server.registerTool(
    "rc_stop",
    {
      title: "remote-control 停止",
      description: "project の claude remote-control を停止する（再起動予約も取り消す）",
      inputSchema: { project: projectName },
    },
    ({ project }) => guard(async () => json(await supervisor.stop(project))),
  );
  server.registerTool(
    "rc_status",
    {
      title: "remote-control 状態",
      description: "project の claude remote-control の状態（state / URL / 再起動回数など）を返す",
      inputSchema: { project: projectName },
    },
    ({ project }) => guard(() => json(supervisor.status(project))),
  );
  server.registerTool(
    "server_list",
    {
      title: "server 一覧",
      description: "設定済みの bantou-server（broker URL）と、その接続・到達状況を返す。server の peer は bantou protocol で自動発見し（servers[].peer 指定があればその名前）、serverPeer に直近の送信先を返す",
    },
    () => guard(async () => json(await link.list())),
  );
  server.registerTool(
    "cap_kick",
    {
      title: "cap を kick",
      description:
        "bantou-server の remote cap を headless で起動（または resume）して prompt を実行させ、結果が返るまで待つ。返り値は bantou-server の cap_result / error 返信そのまま",
      inputSchema: {
        server: serverName,
        cap_id: agentId,
        prompt,
        repo: gitArg.optional().describe("初回に clone する Git URL"),
        branch: gitArg.optional(),
        reason: z.string().refine(noNul, noNulMsg).optional().describe("ログ用の自由記述"),
      },
    },
    ({ server: name, ...cmd }) =>
      guard(async () => {
        const r = await link.kickCap(name, cmd);
        return json(r, isFailure(r));
      }),
  );
  server.registerTool(
    "worker_resume",
    {
      title: "worker を resume",
      description:
        "bantou-server の worker を resume（無ければ新規）で起動して prompt を実行させ、結果が返るまで待つ。返り値は worker_result / error 返信そのまま",
      inputSchema: {
        server: serverName,
        worker_id: agentId,
        prompt,
        repo: gitArg.optional(),
        branch: gitArg.optional(),
      },
    },
    ({ server: name, ...cmd }) =>
      guard(async () => {
        const r = await link.resumeWorker(name, cmd);
        return json(r, isFailure(r));
      }),
  );
  server.registerTool(
    "server_status",
    {
      title: "server の cap / worker 状態",
      description: "bantou-server が持つ cap と worker の一覧と状態を返す（status_result 返信そのまま）",
      inputSchema: { server: serverName },
    },
    ({ server: name }) =>
      guard(async () => {
        const r = await link.status(name);
        return json(r, isFailure(r));
      }),
  );
}
