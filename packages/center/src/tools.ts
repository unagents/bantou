import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AGENT_ID_PATTERN } from "@agent-hand/bantou-protocol";
import { z } from "zod";
import { OWNER_HEADER, OWNER_PATTERN, OWNER_QUERY, remoteSendSchema, remoteWaitSchema, workerReplySchema, WAIT_DEFAULT_SEC, type RemoteManager, type RemoteSendInput } from "./remotes.js";
import type { RemoteControlSupervisor } from "./remote-control.js";
import { projectSettingsPatchSchema } from "./project-settings.js";
import { sessionCreateSchema, SESSION_NAME, type SessionManager } from "./sessions.js";
import type { Follow } from "./follow.js";
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

/** worker_reply の handler（/mcp と /mcp/session で共通。owner は見ない）。 */
const workerReplyHandler =
  (remotes: RemoteManager) =>
  (args: { remote_id?: string; server?: string; worker_id: string; text: string }): Promise<ToolResult> =>
    guard(async () =>
      json(await remotes.workerReply({ worker_id: args.worker_id, text: args.text, ...(args.remote_id ? { remote_id: args.remote_id } : {}), ...(args.server ? { server: args.server } : {}) })));

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
  deps: { supervisor: RemoteControlSupervisor; link: ServerLink; sessions: SessionManager; remotes: RemoteManager; follow?: Follow; workspace?: string },
): void {
  const { supervisor, link, sessions, remotes, follow, workspace } = deps;

  // -- A. center 上の session（番頭が使う） --
  server.registerTool(
    "session_create",
    {
      title: "session 作成",
      description:
        "center 上に master-cap の session を作る。path（省略時は <workspace>/<name>、無ければ作る）で pty wrapper 経由の対話型 `claude --remote-control <name>` を起動して監視対象に加える。center 再起動後も復帰する（--continue）",
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
    "session_settings_get",
    {
      title: "session の設定を取得",
      description:
        "session のプロジェクト設定 { name, settings } を返す。settings は { instructions?: string（--append-system-prompt に渡す追加指示）, …将来の項目 }。未設定は {}。config 由来の project も {}",
      inputSchema: { name: z.string().regex(SESSION_NAME, "英数字と _ - のみ") },
    },
    ({ name }) => guard(async () => json(sessions.getSettings(name))),
  );
  server.registerTool(
    "session_settings_update",
    {
      title: "session の設定を更新",
      description:
        "session のプロジェクト設定を項目ごとにマージ更新し、更新後の { name, settings } を返す。settings に書いた項目だけ変わる（省略した項目はそのまま）。null はその項目を削除。instructions は 16000 文字以内で、空文字は削除と同じ。未知の項目は保持する。session_create で作った session のみ。動いている session には効かず、次の起動（再起動・--continue 含む）から効く",
      inputSchema: { name: z.string().regex(SESSION_NAME, "英数字と _ - のみ"), settings: projectSettingsPatchSchema },
    },
    ({ name, settings }) => guard(async () => json(await sessions.updateSettings(name, settings))),
  );
  server.registerTool(
    "session_list",
    {
      title: "session 一覧",
      description: "center が監視する全 session（config の project と session_create で作ったもの）の状態を返す。source で区別できる",
    },
    () => guard(() => json(sessions.list())),
  );

  server.registerTool(
    "center_info",
    {
      title: "center の情報",
      description:
        "center の情報 { workspace: string | null } を返す。workspace は config の workspace（session_create で path を省いた時の置き場所の親。<workspace>/<name>）。未設定は null。将来の項目はこの object に足す",
    },
    () => guard(() => json({ workspace: workspace ?? null })),
  );

  // -- B. remote の読み取り（外向けは一覧だけ。作成・削除は session 向けの窓口 /mcp/session） --
  server.registerTool(
    "remote_list",
    {
      title: "remote 一覧",
      description:
        "center が保持する remote（server の cap 単位。remote_id = cap_id, server, state, owners, 時刻, 最新の結果, 未完了の指示 pending）の一覧。owner が分かれば（header / query / 引数）その owner が指示を送った cap だけ、分からなければ全件。" +
        "最新の task_result（task_result 本体）と直近の worker_reports（WorkerReportNotice の配列、最大 20 件、到着順）も含む。server から通知を受けた remote には activity が付く: agents（cap → worker。state は running / stalled / idle / done / failed / lost、task、last_activity、last_output_at、silent_ms = 最後の出力からの経過 ms）、received_ms_ago（最後の通知から）、stale（running の agent がいるのに通知が途絶えた）",
      inputSchema: { owner: ownerArg },
    },
    ({ owner }, extra) =>
      guard(() => {
        const who = resolveOwner(extra as OwnerRequestInfo, owner);
        return json(remotes.list(who ? { owner: who } : {}));
      }),
  );

  server.registerTool(
    "worker_reply",
    {
      title: "worker へ返答",
      description:
        "server の worker に返答を送る（worker_report の ask / approve への回答など。desktop の center_call から使う）。server が同じ worker_id で worker を起動し直して text を渡す。remote_id 省略時は記録が 1 件ならその cap（複数あれば server で絞る）。{remote_id, server, worker_id, accepted:true} を返す。protocol の版が合わない server へは送らず error",
      inputSchema: workerReplySchema,
    },
    workerReplyHandler(remotes),
  );

  server.registerTool(
    "remote_wait",
    {
      title: "remote 完了待ち",
      description: "server の cap が終わる（state が done / failed = cap が idle で、配下の worker が running / stalled でない）まで待って、その cap の記録（state, result, error, pending など）を返す。remote_id 省略時は owner の未完了の指示がある cap のどれかが終わるまで。timeout_sec（既定 "+WAIT_DEFAULT_SEC+"、上限 1800）を超えたら state=running のまま返す。完了通知を受けられない session でもこれで待てる",
      inputSchema: { ...remoteWaitSchema, owner: ownerArg },
    },
    ({ remote_id, server, timeout_sec, owner }, extra) =>
      guard(async () => {
        const who = resolveOwner(extra as OwnerRequestInfo, owner);
        return json(await remotes.wait({ ...(remote_id ? { remote_id } : {}), ...(server ? { server } : {}), ...(who ? { owner: who } : {}), ...(timeout_sec !== undefined ? { timeoutSec: timeout_sec } : {}) }));
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
    "server_peers",
    {
      title: "server の版の状態",
      description:
        "protocol bantou で発見した server ごとの版の状態。pair = この center と組になる版（server = npm bantou の版、protocol）。peers[].state は ok（一致）/ updating（更新中。update.running = 待っている cap/worker の件数）/ mismatch・unsupported（版違い）/ failed（更新失敗。detail に理由）/ lost / unknown。版が違う server へは center が自動で更新を指示する。refresh: true で今すぐ確認してから返す",
      inputSchema: { refresh: z.boolean().optional() },
    },
    ({ refresh }) =>
      guard(async () => {
        if (!follow) throw new Error("版の確認が無効");
        if (refresh) await follow.check();
        return json(follow.snapshot());
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

/**
 * session 向けの窓口（/mcp/session）の tool。owner は呼び出し元 session（認証済みの header X-Bantou-Session）で、
 * 引数では受けない（自己申告させない）。
 */
export function registerSessionTools(server: McpServer, deps: { remotes: RemoteManager; owner: string }): void {
  const { remotes, owner } = deps;

  const sendHandler = (args: Omit<RemoteSendInput, "owner">): Promise<ToolResult> =>
    guard(async () =>
      json(
        await remotes.send({
          owner,
          goal: args.goal,
          ...(args.server ? { server: args.server } : {}),
          ...(args.repo ? { repo: args.repo } : {}),
          ...(args.branch ? { branch: args.branch } : {}),
          ...(args.deliverables ? { deliverables: args.deliverables } : {}),
          ...(args.verify ? { verify: args.verify } : {}),
          ...(args.constraints ? { constraints: args.constraints } : {}),
          ...(args.workers ? { workers: args.workers } : {}),
          ...(args.worker_model ? { worker_model: args.worker_model } : {}),
        }),
      ));
  server.registerTool(
    "remote_send",
    {
      title: "remote-cap へ指示",
      description:
        "server の remote-cap に task を送る（cap は server ごとに 1 つ。無ければ server が作る）。goal（必須）だけでも動く（deliverables / verify / constraints / workers は省略時 {} / {} / [] / {}。workers.items 無し = implement + review の最低 2 体）。task_id は center が採番して返す。どの session からでも同じ cap に行く。cap が実行中なら server 側で順番に待たされる。完了を待たず {remote_id, state:\"running\", created, task_id} を返す。完了は通知（push）か remote_wait / remote_list（task_result）で確認する。worker の report（progress / ask / approve / done）は push で届く（progress は同じ worker から 60 秒に 1 回まで）。ask / approve への返答は worker_reply。server は protocol bantou で発見した先頭、server 引数で peer id か名前を指定できる。worker_model の既定は center の設定 servers[]（新規の cap のみ）。state は running / done / failed / unknown（server に届かない・status も取れず不明。取れたら戻る）。protocol の版が合わない server へは送らず error",
      inputSchema: remoteSendSchema,
    },
    sendHandler,
  );
  server.registerTool(
    "worker_reply",
    {
      title: "worker へ返答",
      description:
        "server の worker に返答を送る（worker_report の ask / approve への回答など）。server が同じ worker_id で worker を起動し直して text を渡す。remote_id 省略時は記録が 1 件ならその cap（複数あれば server で絞る）。{remote_id, server, worker_id, accepted:true} を返す。protocol の版が合わない server へは送らず error",
      inputSchema: workerReplySchema,
    },
    workerReplyHandler(remotes),
  );
  server.registerTool(
    "remote_create",
    {
      title: "remote 作成（remote_send の別名）",
      description: "remote_send の互換の別名（同じ処理）。server の remote-cap に次の指示を送る（cap が無ければ作る）",
      inputSchema: remoteSendSchema,
    },
    sendHandler,
  );
  server.registerTool(
    "remote_delete",
    {
      title: "remote 削除",
      description:
        "server の remote-cap の実行を止め（server へ stop_cap）、center の記録から外す。止められない時は error（force: true で記録だけ消す）。cap は共有なので、他の session の指示も止まる。remote_id 省略時は記録が 1 件ならその cap（複数あれば server で絞る）。複数の server に同じ remote_id がある時は server で指定する",
      inputSchema: { remote_id: agentId.optional(), server: z.string().min(1).optional(), force: z.boolean().optional() },
    },
    ({ remote_id, server: srv, force }) =>
      guard(async () => json(await remotes.delete({ ...(remote_id ? { remote_id } : {}), ...(srv ? { server: srv } : {}), ...(force !== undefined ? { force } : {}) }))),
  );
  server.registerTool(
    "remote_list",
    {
      title: "remote 一覧",
      description: "この session が指示を送った remote-cap（remote_id, server, state, 時刻, 最新の結果, 最新の task_result, 直近の worker_reports（最大 20 件、到着順）, 未完了の指示 pending、通知を受けたものは activity 付き）の一覧",
    },
    () => guard(() => json(remotes.list({ owner }))),
  );
  server.registerTool(
    "remote_wait",
    {
      title: "remote 完了待ち",
      description: "server の cap が終わる（state が done / failed = cap が idle で、配下の worker が running / stalled でない）まで待って、その cap の記録（state, result, error, pending など）を返す。remote_id 省略時は owner の未完了の指示がある cap のどれかが終わるまで。timeout_sec（既定 "+WAIT_DEFAULT_SEC+"、上限 1800）を超えたら state=running のまま返す。完了通知を受けられない session でもこれで待てる",
      inputSchema: remoteWaitSchema,
    },
    ({ remote_id, server: srv, timeout_sec }) =>
      guard(async () => json(await remotes.wait({ owner, ...(remote_id ? { remote_id } : {}), ...(srv ? { server: srv } : {}), ...(timeout_sec !== undefined ? { timeoutSec: timeout_sec } : {}) }))),
  );
}
