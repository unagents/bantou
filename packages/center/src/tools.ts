import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AGENT_ID_PATTERN } from "@agent-hand/bantou-protocol";
import { z } from "zod";
import { OWNER_HEADER, OWNER_PATTERN, OWNER_QUERY, remoteSendSchema, remoteWaitSchema, workerReplySchema, WAIT_DEFAULT_SEC, type RemoteManager, type RemoteSendInput } from "./remotes.js";
import type { RemoteControlSupervisor } from "./remote-control.js";
import { projectSettingsPatchSchema } from "./project-settings.js";
import { LOGIN_CODE, type LoginFlow } from "./login.js";
import { sessionCreateSchema, sessionUpdateSchema, SESSION_NAME, type SessionManager } from "./sessions.js";
import type { Follow } from "./follow.js";
import type { ServerLink } from "./server-link.js";
import { retireServer } from "./retire.js";
import type { Logger } from "./log.js";

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

/** worker_reply の handler（/mcp と /mcp/session で共通）。owner（/mcp/session の呼び出し元 session）を渡すと、その session の cap だけが対象。 */
const workerReplyHandler =
  (remotes: RemoteManager, owner?: string) =>
  (args: { remote_id?: string; server?: string; worker_id: string; text: string }): Promise<ToolResult> =>
    guard(async () =>
      json(await remotes.workerReply({ worker_id: args.worker_id, text: args.text, ...(owner ? { owner } : {}), ...(args.remote_id ? { remote_id: args.remote_id } : {}), ...(args.server ? { server: args.server } : {}) })));

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
  deps: {
    supervisor: RemoteControlSupervisor;
    link: ServerLink;
    sessions: SessionManager;
    remotes: RemoteManager;
    follow?: Follow;
    workspace?: string;
    /** server_retire のログ。省略時は出さない。 */
    log?: Logger;
    /** session の再ログイン（pty 入力が要るので wrapper 経由の起動がある時だけ）。 */
    login?: LoginFlow;
    /** master-cap の起動時に付けるシステム埋め込み指示の一覧（center_info 用）。省略時は []。 */
    systemInstructions?: { id: string; version: number; title: string }[];
  },
): void {
  const { supervisor, link, sessions, remotes, follow, workspace, login } = deps;
  const log: Logger = deps.log ?? (() => {});
  const systemInstructions = deps.systemInstructions ?? [];

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
    "session_update",
    {
      title: "session の名前・path を変更",
      description:
        "session_create で作った session の名前（newName）と path を変える。session を止め、path 指定時はフォルダを作る（move: true なら今のフォルダを新しい path へ rename で移動。EXDEV などで失敗したら error で何も変えない。コピーはしない）、記録を更新して新しい名前で起動し直す。settings（instructions / addDirs）は引き継ぐ。remote の cap_id は変わらず、記録は新しい名前へ付け替わる。path を変えた時は --continue が効かず（会話が無い）素の起動になる。config 由来の project は不可。newName は既存の session / project と重複不可、path は他の session と重複不可。{ SessionInfo } を返す",
      inputSchema: sessionUpdateSchema,
    },
    (args) => guard(async () => json(await sessions.update(args))),
  );
  server.registerTool(
    "session_settings_get",
    {
      title: "session の設定を取得",
      description:
        "session のプロジェクト設定 { name, settings } を返す。settings は { instructions?: string（--append-system-prompt に渡す追加指示）, addDirs?: string[]（--add-dir で渡す参照フォルダ。絶対パス）, servers?: string[]（この session が remote_send / remote_delete / worker_reply で使える server＝host 名か server_id。未設定は center 共通の値、それも無ければ全部。空配列は使わない）, …将来の項目 }。未設定は {}。config 由来の project も {}",
      inputSchema: { name: z.string().regex(SESSION_NAME, "英数字と _ - のみ") },
    },
    ({ name }) => guard(async () => json(sessions.getSettings(name))),
  );
  server.registerTool(
    "session_settings_update",
    {
      title: "session の設定を更新",
      description:
        "session のプロジェクト設定を項目ごとにマージ更新し、更新後の { name, settings } を返す。settings に書いた項目だけ変わる（省略した項目はそのまま）。null はその項目を削除。instructions は 16000 文字以内で、空文字は削除と同じ。addDirs は絶対パスの配列（20 個以内。空配列は削除と同じ。center 共通の addDirs と合わせて --add-dir に 1 つずつ付く）。servers は host 名か server_id の配列（50 個以内。重複は除く。空配列は「どの server も使わない」として保存し、未設定＝全部と区別する。null で削除＝center 共通の値に戻る。session の servers があれば center 共通の servers は見ない＝置き換え）。servers は次の呼び出しからすぐ効く（起動し直し不要）。未知の項目は保持する。session_create で作った session のみ。動いている session には効かず、次の起動（再起動・--continue 含む）から効く",
      inputSchema: { name: z.string().regex(SESSION_NAME, "英数字と _ - のみ"), settings: projectSettingsPatchSchema },
    },
    ({ name, settings }) => guard(async () => json(await sessions.updateSettings(name, settings))),
  );
  server.registerTool(
    "center_settings_get",
    {
      title: "center 共通の設定を取得",
      description:
        "center 共通の設定 { settings } を返す。settings は { instructions?: string（全 session の --append-system-prompt の先頭に付く共通の追加指示。session の追加指示は空行を挟んでその後ろ）, addDirs?: string[]（全 session に --add-dir で付く参照フォルダ。絶対パス。session の addDirs はその後ろ）, servers?: string[]（host 名か server_id。session に servers が無い時に使う、session が使える server の範囲。未設定＝全部）, …将来の項目 }。未設定は {}",
    },
    () => guard(async () => json(sessions.getCenterSettings())),
  );
  server.registerTool(
    "center_settings_update",
    {
      title: "center 共通の設定を更新",
      description:
        "center 共通の設定を項目ごとにマージ更新し、更新後の { settings } を返す。settings に書いた項目だけ変わる。null はその項目を削除。instructions は 16000 文字以内で、空文字は削除と同じ。addDirs は絶対パスの配列（20 個以内。空配列は削除と同じ）。servers は host 名か server_id の配列（50 個以内。空配列は「どの server も使わない」。null で削除＝全部。session 側に servers があればそちらが優先）で、次の呼び出しからすぐ効く。全 session の次の起動（再起動・--continue 含む）から効く。動いている session には効かない",
      inputSchema: { settings: projectSettingsPatchSchema },
    },
    ({ settings }) => guard(async () => json(await sessions.updateCenterSettings(settings))),
  );
  server.registerTool(
    "session_list",
    {
      title: "session 一覧",
      description: "center が監視する全 session（config の project と session_create で作ったもの）の状態を返す。source で区別できる。activity（working / needs-input / idle / unknown）と activityAt は claude の作業状態（unknown = 不明・停止中）",
    },
    () => guard(() => json(sessions.list())),
  );
  const sessionName = z.string().regex(SESSION_NAME, "英数字と _ - のみ");
  server.registerTool(
    "session_login",
    {
      title: "session 再ログイン開始",
      description:
        "session の claude に `/login` を打ち込み（Claude account with subscription）、認証 URL が出るまで待って返す。session_list の auth が login_required / keychain_locked の時に使う。URL をブラウザで開いて得たコードを session_login_code に渡す",
      inputSchema: { name: sessionName },
    },
    ({ name }) =>
      guard(async () => {
        if (!login) throw new Error("再ログインは使えない（pty 入力が無い）");
        return json(await login.start(name));
      }),
  );
  server.registerTool(
    "session_login_code",
    {
      title: "session 再ログインのコード投入",
      description:
        "session_login の後、ブラウザで得た認証コードを claude に投入して結果を待つ。ok: false の error は `Invalid code`（コード不正）か `Couldn't save your login`（ホストの keychain がロック。解錠して session_login からやり直す）",
      inputSchema: { name: sessionName, code: z.string().regex(LOGIN_CODE, "英数字と # _ - のみ（512 文字まで）") },
    },
    ({ name, code }) =>
      guard(async () => {
        if (!login) throw new Error("再ログインは使えない（pty 入力が無い）");
        const r = await login.code(name, code);
        return json(r, !r.ok);
      }),
  );

  server.registerTool(
    "center_info",
    {
      title: "center の情報",
      description:
        "center の情報 { workspace: string | null, systemInstructions: [{ id, version, title }] } を返す。workspace は config の workspace（session_create で path を省いた時の置き場所の親。<workspace>/<name>）。未設定は null。systemInstructions は master-cap の起動時に --append-system-prompt の先頭に付けるシステム埋め込み指示の部品（利用者の追加指示とは別。center の版で決まる）。将来の項目はこの object に足す",
    },
    () => guard(() => json({ workspace: workspace ?? null, systemInstructions })),
  );

  // -- B. remote の読み取り（外向けは一覧だけ。作成・削除は session 向けの窓口 /mcp/session） --
  server.registerTool(
    "remote_list",
    {
      title: "remote 一覧",
      description:
        "center が保持する remote（session × server の cap 単位。remote_id = cap_id = c-<center-id>-<session>, session, server（server_id。旧形式で server_id 不明なら peer id）, server_id, peer（今の到達先）, serverHost / serverUser / serverWorkspace, server_label（host 名を主に server_id を添えた表示。同じ host 名が複数なら user と workspace 付き）, state, owners, 時刻, 最新の結果, 未完了の指示 pending）の一覧。owner が分かれば（header / query / 引数）その session の cap だけ、分からなければ全件（session の無い記録 = 旧共有 cap を含む）。" +
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
      description: "project の claude remote-control を起動する（起動済みなら現状を返す）。resume: true で前回の会話に復帰（--continue。復帰できなければ素の起動）",
      inputSchema: { project: projectName, resume: z.boolean().optional() },
    },
    ({ project, resume }) => guard(async () => json(await supervisor.start(project, resume ? { resume: true } : {}))),
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
      description: "設定済みの bantou-server と、その接続・到達状況を返す。server の peer は bantou protocol で自動発見し（servers[].peer 指定があればその名前）、serverPeer に直近の送信先を返す。serverPeer の peer から識別を学習済みなら server_id / host / user / workspace も返す（未学習・旧 server は無い。server_peers との突き合わせに使う）",
    },
    () => guard(async () => json(await link.list())),
  );
  server.registerTool(
    "server_peers",
    {
      title: "server の版の状態",
      description:
        "protocol bantou で発見した server ごとの版の状態。pair = この center と組になる版（server = npm bantou の版、protocol）。peers[] は server が名乗った server_id / host / user / workspace も持つ（旧 server は無い）。peers[].state は ok（一致）/ updating（更新中。update.running = 待っている cap/worker の件数）/ mismatch・unsupported（版違い）/ failed（更新失敗。detail に理由）/ lost / unknown。版が違う server へは center が自動で更新を指示する。refresh: true で今すぐ確認してから返す",
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
    "server_retire",
    {
      title: "server を退役させる",
      description:
        "server を退役させる（取り消せない）。server は新しい作業を断り、実行中の cap / worker を全部止め、messenger から外れて終了する（exit 76。systemd / launchd は戻さない）。server 引数は server_id / host 名 / peer id（host 名が複数の server に一致する時は error。候補を user と workspace 付きで返すので server_id で指し直す）。送る前に hello で protocol の版を確かめ、退役に未対応（protocol 1.8.0 未満・版不明）なら送らず error（host で手動で止める）。retire_result を受けたら、その server の cap の記録（session × server）を center から消し、発見からも外す（server には何も送らない）。返り値 { ok, state: retiring | already_retiring, server_id, host, user, workspace, peer, stopped: {caps, workers}, exit_at, exit_code, host_steps（host で root が行う unit 削除 → user 削除 → workspace 削除。server 自身は権限が無く行えない）, service, records_removed, sessions, message }。返信が無い・timeout（60 秒）は退役したとは見なさず error（記録も消さない）。既に退役中なら state=already_retiring",
      inputSchema: {
        server: z.string().min(1).describe("退役させる server の server_id、host 名、peer id（server_peers / server_list で確認）。省略不可（先頭を退役させない）"),
        reason: z.string().max(500).refine(noNul, noNulMsg).optional().describe("退役の理由（server の log と server.retired に残る）"),
      },
    },
    ({ server: sel, reason }) =>
      guard(async () => json(await retireServer({ link, remotes, log }, { server: sel, ...(reason ? { reason } : {}) }))),
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
        "server の remote-cap に task を送る（cap は session × server に 1 つ。cap_id = c-<center-id>-<session 名>。無ければ server が作る。他の session の cap には届かない）。goal（必須）だけでも動く（deliverables / verify / constraints / workers は省略時 {} / {} / [] / {}。workers.items 無し = implement + review の最低 2 体）。task_id は center が採番して返す。cap が実行中なら server 側で順番に待たされる。完了を待たず {remote_id, state:\"running\", created, task_id} を返す。完了は通知（push）か remote_wait / remote_list（task_result）で確認する。worker の report（progress / ask / approve / done）は push で届く（progress は同じ worker から 60 秒に 1 回まで）。ask / approve への返答は worker_reply。server は protocol bantou で発見した先頭。server 引数は server_id（server が再起動・再登録しても変わらない）、host 名、peer id のどれでも指せる（host 名が複数の server に一致する時は error。候補を user と workspace 付きで返すので server_id で指し直す）。返り値の server は server_id（旧 server は peer id）、peer は今の到達先、host は host 名。worker_model の既定は center の設定 servers[]（新規の cap のみ）。state は running / done / failed / unknown（server に届かない・status も取れず不明。取れたら戻る）。protocol の版が合わない server へは送らず error",
      inputSchema: remoteSendSchema,
    },
    sendHandler,
  );
  server.registerTool(
    "worker_reply",
    {
      title: "worker へ返答",
      description:
        "server の worker に返答を送る（worker_report の ask / approve への回答など）。server が同じ worker_id で worker を起動し直して text を渡す。remote_id 省略時はこの session の cap（server が複数あれば server で絞る）。他の session の cap には送れない。{remote_id, server, worker_id, accepted:true} を返す。protocol の版が合わない server へは送らず error",
      inputSchema: workerReplySchema,
    },
    workerReplyHandler(remotes, owner),
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
        "この session の remote-cap の実行を止め（server へ stop_cap）、center の記録から外す。止められない時は error（force: true で記録だけ消す）。他の session の cap は対象外。remote_id 省略時はこの session の cap（server が複数あれば server で絞る）。旧共有 cap（session 無し。remote_list の include_shared: true で見える。remote_id = c-<center-id>）は remote_id で明示して消す。複数の server に同じ remote_id がある時は server（server_id / host 名 / peer id）で指定する",
      inputSchema: {
        remote_id: agentId.optional(),
        server: z.string().min(1).optional().describe("server_id、host 名、peer id のどれでも指せる。host 名が複数の server に一致する時は error（候補を user と workspace 付きで返す）"),
        force: z.boolean().optional(),
      },
    },
    ({ remote_id, server: srv, force }) =>
      guard(async () => json(await remotes.delete({ owner, ...(remote_id ? { remote_id } : {}), ...(srv ? { server: srv } : {}), ...(force !== undefined ? { force } : {}) }))),
  );
  server.registerTool(
    "remote_list",
    {
      title: "remote 一覧",
      description: "この session の remote-cap（server ごとに 1 つ。remote_id = cap_id, session, server（server_id。旧形式の記録で server_id が分からないものは peer id）, server_id, peer（今の到達先。長く確認できないと消える）, serverHost / serverUser / serverWorkspace, server_label（host 名を主に server_id を添えた表示。同じ host 名の server が複数ある時は user と workspace 付き）, state, 時刻, 最新の結果, 最新の task_result, 直近の worker_reports（最大 20 件、到着順）, 未完了の指示 pending、通知を受けたものは activity 付き）の一覧。include_shared: true で旧共有 cap（session 無し。新しい指示は送らない。remote_delete で消せる）も含める",
      inputSchema: { include_shared: z.boolean().optional() },
    },
    ({ include_shared }) => guard(() => json(remotes.list({ owner, ...(include_shared ? { includeShared: true } : {}) }))),
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
