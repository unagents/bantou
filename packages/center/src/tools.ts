import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AGENT_ID_PATTERN } from "@agent-hand/bantou-protocol";
import { z } from "zod";
import { OWNER_HEADER, OWNER_PATTERN, OWNER_QUERY, remoteCreateSchema, type RemoteManager } from "./remotes.js";
import type { RemoteControlSupervisor } from "./remote-control.js";
import { sessionCreateSchema, SESSION_NAME, type SessionManager } from "./sessions.js";
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

/** MCP リクエストの付帯情報のうち owner の解決に使う部分（http のみ。stdio では無い）。 */
export interface OwnerRequestInfo {
  requestInfo?: { headers?: Record<string, string | string[] | undefined>; url?: URL };
}

/**
 * 呼び出し元 master-cap（owner）の解決。http の header `X-Bantou-Session`、無ければ URL query `session`、無ければ tool 引数 `owner`。
 * 先に見つかったものが勝つ。どれも無ければ undefined。形式が不正なら投げる。
 */
export function resolveOwner(extra: OwnerRequestInfo | undefined, arg?: string): string | undefined {
  const h = extra?.requestInfo?.headers?.[OWNER_HEADER];
  const fromHeader = Array.isArray(h) ? h[0] : h;
  const owner = fromHeader || extra?.requestInfo?.url?.searchParams.get(OWNER_QUERY) || arg || undefined;
  if (owner !== undefined && !OWNER_PATTERN.test(owner)) throw new Error("owner は英数字と _ - のみ");
  return owner;
}

const ownerArg = z.string().optional().describe(
  "呼び出し元 master-cap の session 名。http で header X-Bantou-Session（または URL query session）が付いていればそちらが優先。どちらも無い接続では必須",
);

export function registerTools(
  server: McpServer,
  deps: { supervisor: RemoteControlSupervisor; link: ServerLink; sessions: SessionManager; remotes: RemoteManager },
): void {
  const { supervisor, link, sessions, remotes } = deps;

  // -- A. center 上の session（番頭が使う） --
  server.registerTool(
    "session_create",
    {
      title: "session 作成",
      description:
        "center 上に master-cap の session を作る。path（省略時は <workspace>/<name>、無ければ作る）で `claude remote-control --name <name>` を起動して監視対象に加える。center 再起動後も復帰する（--continue）",
      inputSchema: sessionCreateSchema,
    },
    (args) => guard(async () => json(await sessions.create(args))),
  );
  server.registerTool(
    "session_delete",
    {
      title: "session 削除",
      description: "session_create で作った session の remote-control を停止し、監視対象から外す。path は消さない",
      inputSchema: { name: z.string().regex(SESSION_NAME, "英数字と _ - のみ") },
    },
    ({ name }) => guard(async () => json(await sessions.delete(name))),
  );
  server.registerTool(
    "session_list",
    {
      title: "session 一覧",
      description: "center が監視する全 session（config の project と session_create で作ったもの）の状態を返す。source で区別できる",
    },
    () => guard(() => json(sessions.list())),
  );

  // -- B. remote session（center が master-cap に持たせる道具） --
  server.registerTool(
    "remote_create",
    {
      title: "remote 作成",
      description:
        "server に remote-cap を作らせ、prompt を最初の指示として起動する。完了を待たず {remote_id, state:\"running\"} を返す。完了は remote_list で確認する（state が done / failed になる）。server は protocol bantou で発見した先頭、server 引数で peer id か名前を指定できる",
      inputSchema: { ...remoteCreateSchema, owner: ownerArg },
    },
    ({ owner, ...args }, extra) =>
      guard(async () => {
        const who = resolveOwner(extra as OwnerRequestInfo, owner);
        if (!who) throw new Error("owner が分からない: http の header X-Bantou-Session か引数 owner が必要");
        const r = await remotes.create({ owner: who, ...args });
        return json({ remote_id: r.remote_id, server: r.server, serverName: r.serverName, state: r.state });
      }),
  );
  server.registerTool(
    "remote_delete",
    {
      title: "remote 削除",
      description:
        "remote-cap の実行を止め（server へ stop_cap）、center の記録から外す。止められない時は error（force: true で記録だけ消す）。別の owner の remote は消せない",
      inputSchema: { remote_id: agentId, owner: ownerArg, force: z.boolean().optional() },
    },
    ({ remote_id, owner, force }, extra) =>
      guard(async () => {
        const who = resolveOwner(extra as OwnerRequestInfo, owner);
        return json(await remotes.delete({ remote_id, ...(who ? { owner: who } : {}), ...(force !== undefined ? { force } : {}) }));
      }),
  );
  server.registerTool(
    "remote_list",
    {
      title: "remote 一覧",
      description: "center が保持する remote（remote_id, server, state, owner, 時刻, 結果）の一覧。owner が分かれば（header / query / 引数）その owner のものだけ、分からなければ全件",
      inputSchema: { owner: ownerArg },
    },
    ({ owner }, extra) =>
      guard(() => {
        const who = resolveOwner(extra as OwnerRequestInfo, owner);
        return json(remotes.list(who ? { owner: who } : {}));
      }),
  );

  // -- 既存 tool（A・B と重複するものも残す。整理はユーザー判断） --

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
      description: "設定済みの bantou-server と、その接続・到達状況を返す。server の peer は bantou protocol で自動発見し（servers[].peer 指定があればその名前）、serverPeer に直近の送信先を返す",
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
