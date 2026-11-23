import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OWNER_HEADER, OWNER_PATTERN, OWNER_QUERY, remoteCreateSchema, remoteSendSchema, remoteStopSchema, remoteWaitSchema, workerReplySchema, WAIT_DEFAULT_SEC, type RemoteManager, type RemoteSendInput } from "./remotes.js";
import type { RemoteControlSupervisor } from "./remote-control.js";
import { assertCenterOnly, centerSettingsPatchSchema, projectSettingsPatchSchema, withoutLauncherKeys } from "./project-settings.js";
import { LOGIN_CODE, type LoginFlow } from "./login.js";
import { sessionCreateSchema, sessionUpdateSchema, SESSION_NAME, type SessionManager } from "./sessions.js";
import type { ServerLink } from "./server-link.js";
import type { Logger } from "./log.js";
import type { Resessioner } from "./resession.js";
import { buildTaskStatus } from "./task-status.js";

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

/** worker_reply の handler（/mcp と /mcp/session で共通）。owner（/mcp/session の呼び出し元 session）を渡すと、その session の使う server の範囲が効く。 */
const workerReplyHandler =
  (remotes: RemoteManager, owner?: string) =>
  (args: { server: string; session_id: string; order: "answer" | "approve" | "reject"; content?: string }): Promise<ToolResult> =>
    guard(async () => json(await remotes.reply({ server: args.server, session_id: args.session_id, order: args.order, ...(args.content !== undefined ? { content: args.content } : {}), ...(owner ? { owner } : {}) })));

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
    link?: ServerLink;
    sessions: SessionManager;
    /** session_sleep の入口（引継ぎを書かせてから眠らせる。resession.requestSleep）。省略時は sessions.sleep を直接呼ぶ。 */
    requestSleep?: (name: string) => Promise<unknown>;
    remotes: RemoteManager;
    workspace?: string;
    log?: Logger;
    /** session の再ログイン（pty 入力が要るので wrapper 経由の起動がある時だけ）。 */
    login?: LoginFlow;
    /** master-cap の起動時に付けるシステム埋め込み指示の一覧（center_info 用）。省略時は []。 */
    systemInstructions?: { id: string; version: number; title: string }[];
    /**
     * 呼び出し元が center を起動した所か（launcher.ts）。true なら外部記憶（memory）と追加の MCP の server（mcpServers）を読み書きできる。
     * false（別 host の center に繋いでいる desktop・web・他の呼び出し元）は、含めた更新を断り、読みの応答から除く。
     */
    launcher?: boolean;
  },
): void {
  const { supervisor, sessions, remotes, workspace, login } = deps;
  const launcher = deps.launcher === true;
  /** 読みの応答の settings（起動元以外には memory・mcpServers を出さない）。 */
  const shown = <T extends { settings: object }>(r: T): T => (launcher ? r : { ...r, settings: withoutLauncherKeys(r.settings) });
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
    (args) =>
      guard(async () => {
        assertCenterOnly(args.settings, { launcher });
        return json(await sessions.create(args));
      }),
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
    "session_sleep",
    {
      title: "session をスリープさせる",
      description:
        "session_create で作った session をスリープさせる（起動しないリセッション）。その session の agent に引継ぎを書かせ（center が頼む 1 行を入力に貼り、agent が session_resession で渡す。保存は外部記憶・届かなければ center の file）、turn が終わった後に claude の process を止めてメモリなどを空ける。新しい会話はすぐには起動しない。設定・remote の記録は残る。受理して即返す: { name, state, accepted: true, sleeping: false, pending: true }（眠るのは引継ぎが渡って turn が終わった後。眠った事は session_list の sleeping（true・state は stopped）と events の sleep で分かる）。作業中（turn・subagent・background が動いている）・利用者の入力待ち（needs-input）・未完了の remote の指示・未返答の worker_reply がある時・動いていない session は、Stop を待たず、眠らせず理由つきで断る。desktop でその session を開いた時と、messenger でその session が宛先になった時に、新しい会話で自動で起き直し、最初の入力で引継ぎが渡る（session_wake でも起こせる。起こした時の状況確認の入力は無い）。眠っている session には何もしない（{ name, state, accepted, sleeping: true, pending: false }）",
      inputSchema: { name: z.string().regex(SESSION_NAME, "英数字と _ - のみ") },
    },
    ({ name }) => guard(async () => json(await (deps.requestSleep ? deps.requestSleep(name) : sessions.sleep(name)))),
  );
  server.registerTool(
    "session_wake",
    {
      title: "スリープ中の session を起こす",
      description: "スリープ中の session を起こす。新しい会話（--continue 無し）で claude を起動し、最初の入力で center が眠る前に渡された引継ぎ（取り出せなかった時はその事と置き場）を渡す。状況確認の別の入力は送らない。この仕組みの前に眠った session（引継ぎが無い）は今までどおり --continue で元の会話を起こす。眠っていない session には何もしない。{ SessionInfo } を返す",
      inputSchema: { name: z.string().regex(SESSION_NAME, "英数字と _ - のみ") },
    },
    ({ name }) => guard(async () => json(await sessions.wake(name))),
  );
  server.registerTool(
    "session_update",
    {
      title: "session の名前・path を変更",
      description:
        "session_create で作った session の名前（newName）と path を変える。session を止め、path 指定時はフォルダを作る（move: true なら今のフォルダを新しい path へ rename で移動。EXDEV などで失敗したら error で何も変えない。コピーはしない）、記録を更新して新しい名前で起動し直す。settings（instructions / addDirs / outputStyle）は引き継ぐ。remote の cap_id は変わらず、記録は新しい名前へ付け替わる。path を変えた時は --continue が効かず（会話が無い）素の起動になる。config 由来の project は不可。newName は既存の session / project と重複不可、path は他の session と重複不可。{ SessionInfo } を返す",
      inputSchema: sessionUpdateSchema,
    },
    (args) => guard(async () => json(await sessions.update(args))),
  );
  server.registerTool(
    "session_settings_get",
    {
      title: "session の設定を取得",
      description:
        "session のプロジェクト設定 { name, settings } を返す。settings は { instructions?: string（--append-system-prompt に渡す追加指示）, addDirs?: string[]（--add-dir で渡す参照フォルダ。絶対パス）, outputStyle?: string（claude の output style の markdown 本文。session のフォルダの .claude/output-styles/bantou.md に書いて --settings {\"outputStyle\":\"bantou\"} で選ぶ）, servers?: string[]（この session が remote_send / remote_delete / worker_reply で使える server＝host 名か server_id。置き場は center の状態 dir の sessions.json の settings.servers（session ごと）。center 共通の設定 center-settings.json には無く、config の servers[]（server の接続・model の設定）とは別物。未設定は全部、空配列は使わない。master-cap には起動時の指示文・remote_list の先頭・変更時の push で知らされる）, …将来の項目 }。未設定は {}。config 由来の project も {}",
      inputSchema: { name: z.string().regex(SESSION_NAME, "英数字と _ - のみ") },
    },
    ({ name }) => guard(async () => json(shown(sessions.getSettings(name)))),
  );
  server.registerTool(
    "session_settings_update",
    {
      title: "session の設定を更新",
      description:
        "session のプロジェクト設定を項目ごとにマージ更新し、更新後の { name, settings } を返す。settings に書いた項目だけ変わる（省略した項目はそのまま）。null はその項目を削除。instructions は 16000 文字以内で、空文字は削除と同じ。addDirs は絶対パスの配列（20 個以内。空配列は削除と同じ。center 共通の addDirs と合わせて --add-dir に 1 つずつ付く）。outputStyle は 32000 文字以内で、空文字は削除と同じ（session の値があれば center 共通の outputStyle は使わない）。servers は host 名か server_id の配列（50 個以内。重複は除く。空配列は「どの server も使わない」として保存し、未設定＝全部と区別する。null で削除＝未設定（全部）に戻る。servers は session ごとの設定だけで、center 共通の設定は無い）。servers は次の呼び出しからすぐ効く（起動し直し不要）。置き場は sessions.json の settings.servers（config の servers[] とは別物）。範囲が変わると、その session の master-cap へ messenger で知らせる（指示文への反映は次の起動）。mcpServers（追加の MCP の server。名前 → Claude Code の mcp.json の mcpServers の値と同じ形: stdio は { command, args?, env? }、http / sse は { type, url, headers? }。headers に Authorization: Bearer <値> もそのまま書ける。session の設定では同じ名前で共通を置き換え、null で共通の server をその session では外す）と memory（外部記憶の MCP の server。同じ形の 1 件。例 { type: \"http\", url, headers: { Authorization: \"Bearer …\" } }。session の値があれば共通は使わない）は center を起動した所（launcher）からだけ書ける（他からは error）。未知の項目は保持する。session_create で作った session のみ。動いている session には効かず、次の起動（再起動・--continue 含む）から効く",
      inputSchema: { name: z.string().regex(SESSION_NAME, "英数字と _ - のみ"), settings: projectSettingsPatchSchema },
    },
    ({ name, settings }) =>
      guard(async () => {
        assertCenterOnly(settings, { launcher });
        return json(shown(await sessions.updateSettings(name, settings)));
      }),
  );
  server.registerTool(
    "center_settings_get",
    {
      title: "center 共通の設定を取得",
      description:
        "center 共通の設定 { settings } を返す。settings は { instructions?: string（全 session の --append-system-prompt の先頭に付く共通の追加指示。session の追加指示は空行を挟んでその後ろ）, addDirs?: string[]（全 session に --add-dir で付く参照フォルダ。絶対パス。session の addDirs はその後ろ）, outputStyle?: string（全 session の claude の output style の markdown 本文。session に outputStyle があればそちらを使う）, guardrailSchemas?: Record<名前, { schema: string（schema.yaml の文字列）, templates: Record<templates/ からの相対 path, 中身の文字列> }>（guardrail の設定: openspec 向けの schema 定義）, …将来の項目 }。servers（使う server）は共通の設定には無い。session の設定（session_settings_get / session_settings_update）で指定する。未設定は {}。保存済みの共通設定に servers が残っていても読み捨てる。mcpServers・memory は center を起動した所（応答の launcher が true）にだけ返す",
    },
    () => guard(async () => json({ ...shown(sessions.getCenterSettings()), launcher })),
  );
  server.registerTool(
    "center_settings_update",
    {
      title: "center 共通の設定を更新",
      description:
        "center 共通の設定を項目ごとにマージ更新し、更新後の { settings } を返す。settings に書いた項目だけ変わる。null はその項目を削除。instructions は 16000 文字以内で、空文字は削除と同じ。addDirs は絶対パスの配列（20 個以内。空配列は削除と同じ）。outputStyle は 32000 文字以内で、空文字は削除と同じ。guardrailSchemas（guardrail の設定: openspec 向けの schema 定義。名前 → { schema（schema.yaml の文字列）, templates?（templates/ からの相対 path → 中身の文字列。省略は空）}。名前は英数字で始まり英数字と . _ - のみ（大文字小文字を区別）。bantou は YAML も中身も解釈せずそのまま保存して返し、schema の MCP server（/mcp/schemas）が返す。名前ごとにマージし（定義は丸ごと置き換え）、名前の値が null でその schema を削除、guardrailSchemas 自体が null で全部削除。起動元以外からも書ける。session の設定には置けない）。servers は共通の設定では持てない（null 以外を渡すと error。session の設定 session_settings_update の settings.servers で指定する）。mcpServers（全 session に載る追加の MCP の server。Claude Code の mcp.json の mcpServers と同じ形）と memory（外部記憶の MCP の server）は center を起動した所（launcher）からだけ書ける（他からは error）。応答の launcher は呼び出し元が起動元か。全 session の次の起動（再起動・--continue 含む）から効く。動いている session には効かない",
      inputSchema: { settings: centerSettingsPatchSchema },
    },
    ({ settings }) =>
      guard(async () => {
        assertCenterOnly(settings, { launcher });
        return json({ ...shown(await sessions.updateCenterSettings(settings)), launcher });
      }),
  );
  server.registerTool(
    "session_list",
    {
      title: "session 一覧",
      description: "center が監視する全 session（config の project と session_create で作ったもの）の状態を返す。source で区別できる。activity（working = cap 本体が実行中で入力に反応できない / needs-input = 返答待ち / idle = 待機 / unknown = 不明・停止中）と activityAt は cap（claude 本体）の状態、background { subagents, tasks } は session の中で続く subagent・background の実行の数（idle でも 0 でなければ作業は進行中）",
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
        "center の情報 { workspace: string | null, systemInstructions: [{ id, version, title }], launcher: boolean } を返す。launcher は呼び出し元が center を起動した所か（外部記憶・追加の MCP の server を設定できる）。workspace は config の workspace（session_create で path を省いた時の置き場所の親。<workspace>/<name>）。未設定は null。systemInstructions は master-cap の起動時に --append-system-prompt の先頭に付けるシステム埋め込み指示の部品（利用者の追加指示とは別。center の版で決まる）。将来の項目はこの object に足す",
    },
    () => guard(() => json({ workspace: workspace ?? null, systemInstructions, launcher })),
  );

  // -- B. remote の読み取り（外向けは一覧だけ。作成・削除は session 向けの窓口 /mcp/session） --
  server.registerTool(
    "remote_list",
    {
      title: "remote 一覧",
      description:
        "center が保持する remote の控え（session × server の cap 単位）の一覧。各要素は remote_id（= launch の parent-id = cap の名前）, session, server（server の agent-messenger の名前）, serverName, server_label, state（running = worker の ws の最後の書き込みから 60 秒以内 / done = 止まっている = 60 秒無音）, finishedAt（止まっている時だけ。ws の最後の書き込みの時刻）, model, createdAt, owners。owner が分かれば（header / query / 引数）その session の cap だけ、分からなければ全件。結果・report・質問は server から cap の名前に直接届くので、center の一覧には載らない。",
      inputSchema: { owner: ownerArg },
    },
    ({ owner }, extra) =>
      guard(() => {
        const who = resolveOwner(extra as OwnerRequestInfo, owner);
        return json(remotes.list(who ? { owner: who, includeOutOfScope: true } : {}));
      }),
  );

  server.registerTool(
    "worker_reply",
    {
      title: "worker へ返答",
      description:
        "server へ reply（answer / approve / reject）を送る。server の名前と worker の session-id を指す（session-id は server から cap に届いた質問に付いている）。answer は content が回答の本文。送った事だけを { server, session_id, order, sent: true } で返す",
      inputSchema: workerReplySchema,
    },
    workerReplyHandler(remotes),
  );

  server.registerTool(
    "remote_wait",
    {
      title: "remote 完了待ち",
      description: "cap の worker が止まる（ws の最後の書き込みから 60 秒無音）まで待って、その cap の控え（state など）を返す。report は center が受けないので、書き込みが止まってから 60 秒で返る。remote_id 省略時は owner の cap のどれかが止まるまで。timeout_sec（既定 "+WAIT_DEFAULT_SEC+"、上限 1800）を超えたら state=running のまま返す",
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
    ({ project, resume }) =>
      guard(async () => {
        // スリープ中の session は、起動の前にスリープを解く（身代わり peer を外し、元の会話で起こす）
        if (sessions.list().some((s) => s.name === project && s.sleeping)) return json(await sessions.wake(project));
        return json(await supervisor.start(project, resume ? { resume: true } : {}));
      }),
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
}

/**
 * session 向けの窓口（/mcp/session）の tool。owner は呼び出し元 session（認証済みの header X-Bantou-Session）で、
 * 引数では受けない（自己申告させない）。
 */
export function registerSessionTools(server: McpServer, deps: { remotes: RemoteManager; owner: string; link?: Pick<ServerLink, "serverVersionOf">; resession?: Pick<Resessioner, "request"> }): void {
  const { remotes, owner, link, resession } = deps;
  if (resession) {
    server.registerTool(
      "session_resession",
      {
        title: "リセッション（引継ぎを残して新しい会話で起動し直す）",
        description:
          "自分（呼び出し元 session）のリセッションを申告する（center がスリープの引継ぎを頼んできた時は、この道具で引継ぎを渡す。受理の後に turn を終えると center が session を止めて眠らせる）。引継ぎ（handoff）を center が保存して受理を返し、この turn が終わったあと center が claude を新しい会話（--continue 無し）で起動し直す。起動し直した最初の入力で、center が引継ぎの本文（取り出せなかった時はその事と置き場）を渡す。新しい会話が自分で引きに行く必要は無い。他の session は指せない。利用者の入力待ち・動いている worker（remote の cap の ws が 60 秒以内に書いている）がある間は断られる。返り値 { accepted, handoff_id, stored（memory = 外部記憶に保存 / file = 外部記憶に届かず center の file に保存。どちらも center が保存先から取り出して渡す）, restart }。受理されたら短く再起動すると言って turn を終える",
        inputSchema: { handoff: z.string().min(1).max(65536).describe("引継ぎの本文。仕掛かり・止まっている事・次の一手 / 決定と番号つきの未決 / 今の窓口") },
      },
      ({ handoff }) => guard(async () => json(await resession.request(owner, handoff))),
    );
  }
  const sendHandler = (args: Omit<RemoteSendInput, "owner">): Promise<ToolResult> =>
    guard(async () => {
      const r = await remotes.send({ owner, server: args.server, prompt: args.prompt, ...(args.model ? { model: args.model } : {}) });
      return json(r);
    });
  server.registerTool(
    "remote_send",
    {
      title: "remote-cap へ指示",
      description:
        "server に worker の起動（launch）を送る。server は agent-messenger の名前（そのまま宛先）。parent-id にはこの session の cap の名前（<session 名>-cap）が入り、本文に server・worker の指定は入らない。model を省くと sonnet。center の ws の宛先も一緒に送り、worker の tracker がそこへ書く。返り値は送った事だけ { remote_id, server, model, sent: true }。worker の結果・report・質問は server から cap の名前（この session）に直接届く（center は転送しない）。worker の動きは remote_list / remote_wait（ws の最後の書き込みから running / 止まっている = 60 秒無音）。この session に使う server の範囲（settings.servers）の外の server には送れない。center の ws の宛先が決まらない（bind が loopback で config の publicHost が無い）時は送らず error",
      inputSchema: remoteSendSchema,
    },
    sendHandler,
  );
  server.registerTool(
    "worker_reply",
    {
      title: "worker へ返答",
      description:
        "server へ reply（answer / approve / reject）を送る。server の名前と worker の session-id を指す（session-id は server から cap に届いた質問に付いている）。answer は content が回答の本文。使う server の範囲（settings.servers）の外の server には送れない。送った事だけを { server, session_id, order, sent: true } で返す",
      inputSchema: workerReplySchema,
    },
    workerReplyHandler(remotes, owner),
  );
  server.registerTool(
    "remote_create",
    {
      title: "remote 作成（remote_send の別名）",
      description: "remote_send の互換の別名（同じ処理・同じ入力）",
      inputSchema: remoteCreateSchema,
    },
    sendHandler,
  );
  server.registerTool(
    "remote_stop",
    {
      title: "remote を止める",
      description:
        "server に stop（この session の cap の名前 = parent-id の worker を止める）を送り、center の控え（その cap の記録）も消す。返り値は送った事だけ { remote_id, server, sent: true, forgotten }。server が止めた結果は cap の名前に直接届く",
      inputSchema: remoteStopSchema,
    },
    ({ server: srv }) => guard(async () => json(await remotes.stop({ owner, server: srv }))),
  );
  server.registerTool(
    "remote_list",
    {
      title: "remote 一覧",
      description: "この session の remote-cap の控え。使う server の範囲（session の設定 settings.servers）が決まっている時は、先頭の要素 { scope: { servers, out_of_scope_caps, note } } に範囲を出し、範囲外の server の cap は既定では出さない（include_out_of_scope: true で出す。範囲の指定が無ければ scope は付かない）。cap は server ごとに 1 つ: remote_id（= parent-id = cap の名前）, session, server（server の agent-messenger の名前）, serverName, server_label, state（running = worker の ws の最後の書き込みから 60 秒以内 / done = 止まっている = 60 秒無音）, finishedAt（止まっている時だけ。ws の最後の書き込みの時刻）, model, createdAt, owners。結果・report・質問は server から cap の名前（この session）に直接届くので、この一覧には載らない",
      inputSchema: {
        include_out_of_scope: z.boolean().optional().describe("true で、この session の使う server の範囲（settings.servers）の外の server の cap も出す（既定は出さない）"),
      },
    },
    ({ include_out_of_scope }) =>
      guard(() => {
        const items = remotes.list({ owner, ...(include_out_of_scope ? { includeOutOfScope: true } : {}) });
        const sc = remotes.scopeOf(owner);
        // 範囲の指定がある時だけ、配列の先頭に範囲を 1 件足す（指定が無ければ従来どおり cap だけ）
        if (sc.servers === undefined) return json(items);
        const note = `この session が使える server は [${sc.servers.join(", ")}]${sc.servers.length === 0 ? "（空 = どの server も使わない）" : ""}（session の設定 settings.servers）。` +
          (sc.out_of_scope > 0 ? `範囲外の自分の cap が ${sc.out_of_scope} 件${include_out_of_scope ? "ある（この一覧に含めた）" : "あり、この一覧には出していない（include_out_of_scope: true で出す）"}。server を指した remote_stop で片付けられる。` : "");
        return json([{ scope: { servers: sc.servers, out_of_scope_caps: sc.out_of_scope, note } }, ...items]);
      }),
  );
  server.registerTool(
    "task_status",
    {
      title: "cap の状態確認",
      description:
        "この session の cap ごとに 1 行の状態確認（本文は入らない）。返り値 { at, caps: [{ remote_id, server, line }], servers（この session の cap のある server ごとの版。server-info の答えを控えた物。未取得は不明）, truncated, omitted }。line は `<remote_id> | <server> | <実行中 / 止まっている> [| 最後の書き込み <分> 分前]`（状態は ws の最後の書き込みから。60 秒無音で止まっている）。1 回 40 行まで。他の session の cap は見えない。remote_id で 1 つの cap に絞れる",
      inputSchema: { remote_id: z.string().min(1).optional() },
    },
    ({ remote_id }) => guard(() => json(buildTaskStatus(remotes.list({ owner, includeOutOfScope: true }), owner, Date.now(), remote_id ? { remote_id } : undefined, link ? (s) => link.serverVersionOf(s) : undefined))),
  );
  server.registerTool(
    "remote_wait",
    {
      title: "remote 完了待ち",
      description: "cap の worker が止まる（ws の最後の書き込みから 60 秒無音）まで待って、その cap の控え（state など）を返す。report は center が受けないので、書き込みが止まってから 60 秒で返る。remote_id・server 省略時はこの session の cap のどれかが止まるまで。timeout_sec（既定 "+WAIT_DEFAULT_SEC+"、上限 1800）を超えたら state=running のまま返す",
      inputSchema: remoteWaitSchema,
    },
    ({ remote_id, server: srv, timeout_sec }) =>
      guard(async () => json(await remotes.wait({ owner, ...(remote_id ? { remote_id } : {}), ...(srv ? { server: srv } : {}), ...(timeout_sec !== undefined ? { timeoutSec: timeout_sec } : {}) }))),
  );
}
