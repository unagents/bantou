import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CapResultReply, ErrorReply, TaskResultReply, WorkerReportNotice } from "@agent-hand/bantou-protocol";
import type { CliArgs } from "./args.js";
import { resolveClaude } from "./claude-path.js";
import { resolveSessionPath } from "./path-env.js";
import { createActivityStore } from "./activity.js";
import { loadCapId } from "./center-id.js";
import { loadConfig, MIN_TOKEN_LEN } from "./config.js";
import { centerHostOf, coordinatorEntry, ensureCoordinatorState, startCoordinatorChild, type CoordinatorChild, type CoordinatorMcpState } from "./coordinator-mcp.js";
import { SESSION_MCP_PATH, startHttpServer, type HttpHandle } from "./http.js";
import { createConnectionsStore } from "./mcp-connections.js";
import { createSecretsStore } from "./mcp-secrets.js";
import { existsSync, renameSync } from "node:fs";
import { createMcpSource } from "./mcp-source.js";
import { buildSessionMcp } from "./mcp-session.js";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { log, setLogFile } from "./log.js";
import { watchParent } from "./parent-watch.js";
import { createFollow } from "./follow.js";
import { resolvePair } from "./pair.js";
import { createRemoteManager } from "./remotes.js";
import { createRemoteControlSupervisor } from "./remote-control.js";
import { createContextUsageTracker } from "./context-usage.js";
import { createLoginFlow } from "./login.js";
import { createSessionManager } from "./sessions.js";
import { createMemoryFile } from "./memory-settings.js";
import { takeLauncherKey } from "./launcher.js";
import { backupFileOnce, createJsonListStore, createJsonObjectStore } from "./store.js";
import { applicableParts, buildSystemInstructions, partLabel } from "./system-instructions.js";
import { createCenterServer, createSessionMcpServer } from "./server.js";
import { createCore } from "./core.js";
import { createEventHub } from "./events.js";
import { createSessionTokens } from "./session-auth.js";
import { createSessionActivityTracker, publishLastMessage } from "./session-activity.js";
import { createServerLink } from "./server-link.js";
import { createProcessStandInClient } from "./stand-in.js";
import { createSleepGate } from "./sleep-gate.js";
import { createResessioner } from "./resession.js";
import { createCenterMemoryEvents } from "./memory-events.js";
import { capSessionName } from "./session-name.js";

/** 強制終了の猶予に足す余裕（stop は SIGTERM 待ち stopGraceMs の後、SIGKILL 待ちで最大 5 秒）。 */
const HARD_EXIT_MARGIN_MS = 5_000;

/**
 * 起動して常駐する。SIGTERM / SIGINT で後始末して exit 0。
 * stdio では stdin EOF / 切断でも終了する。http では stdin を見ず（親が /dev/null を渡しても落ちない）、親プロセスの死亡で終了する。
 */
export async function runDaemon(args: CliArgs): Promise<void> {
  // center を起動した所の鍵（desktop が sidecar に渡す。launcher.ts）。最初に読んで自分の env から消す
  // （login shell・claude の解決・session など、この後に起動するどの子 process にも渡さない。remote-control.ts でも消す）
  const launcherKey = takeLauncherKey();
  const configPath = args.config;
  log("起動");
  const config = await loadConfig(configPath, log);
  log(
    `設定読込: ${configPath} (projects=${config.projects.length} servers=${config.servers.length} logDir=${config.logDir})`,
  );
  if (config.projects.length === 0) {
    log(`remote-control は起動しない: projects が 0 件 (${configPath})`);
  } else if (!config.projects.some((p) => p.autostart)) {
    log(`remote-control は自動起動しない: autostart の project が 0 件 (projects=${config.projects.length}, ${configPath})`);
  }
  try {
    await mkdir(config.logDir, { recursive: true });
    setLogFile(join(config.logDir, "center.log"));
  } catch (e) {
    log(`center.log を開けない（stderr のみ）: ${e instanceof Error ? e.message : String(e)}`);
  }
  // GUI 起動（macOS の bantou.app の sidecar）は PATH が最小。center 自身と、子（session・MCP の npx 等）が継承する PATH をここで補う
  process.env.PATH = (await resolveSessionPath(log)).path;
  const claude = await resolveClaude(config.remoteControl.claude, log);
  const core = createCore();
  const sessionTokens = createSessionTokens();
  let httpPort: number | null = null;
  // 統括の道具を出す独立した MCP の server（coordinator-mcp.ts。http で待ち受ける時だけ center が子として起動する）の port と key
  let coordState: CoordinatorMcpState | null = null;
  let coordChild: CoordinatorChild | null = null;
  // session（master-cap）から center の MCP へ戻る URL。http で待ち受けていなければ null（--mcp-config を付けない）
  const sessionMcpUrl = (): string | null => {
    if (httpPort === null) return null;
    return `http://${centerHostOf(args.bind)}:${httpPort}${SESSION_MCP_PATH}`;
  };
  // session の増減・認証状態の変化を desktop へ知らせる（GET /events）
  const events = createEventHub();
  // 旧設定の外部記憶の file（memory-settings.json。起動時に普通の設定の memory へ移す）
  const memoryFile = createMemoryFile(dirname(resolve(configPath)), log);
  // 追加の MCP の server は普通の設定（center-settings.json と session の settings の mcpServers）に書く。書けるのは center を起動した所の画面と設定 file の直接の編集。
  // connections は旧設定 mcp-connections.json（M1 の CLI）の移行元。鍵は旧来の鍵の file（CLI が書く）
  const connections = createConnectionsStore(dirname(resolve(configPath)), log);
  const mcpSecrets = createSecretsStore(dirname(resolve(configPath)), log);
  const supervisor = createRemoteControlSupervisor({
    // 外部記憶は普通の設定（center-settings.json / sessions.json の memory）。sessions は supervisor の後に作るので、呼ばれる時に参照する
    memoryOf: (name) => sessions.memoryOf(name),
    mcpOf: (name, mcpUrl) => {
      const { data, problems } = sessions.mcpConnections();
      if (problems.length) log(`MCP の接続の設定に不正な項目がある（捨てた。名前だけ）: ${problems.join(", ")}`);
      return buildSessionMcp(data, mcpSecrets, name, coordState);
    },
    // sessions は supervisor の後に作るので、呼ばれる時に参照する
    serversOf: (name) => sessions.serversOf(name),
    systemInstructions: { build: (ctx) => buildSystemInstructions(ctx), labels: (ctx) => applicableParts(ctx).map(partLabel) },
    config,
    configPath,
    log,
    claude,
    wrapper: { core, tokens: sessionTokens, mcpUrl: sessionMcpUrl },
    onAuthChange: (name) => events.publish({ reason: "changed", name }),
  });
  const login = createLoginFlow({ supervisor, core, log });
  const activity = createActivityStore();
  // 通知は 5 秒ごとに来るので、状態の組が変わった時だけログに出す
  const lastStates = new Map<string, string>();
  // remotes は link の後に作るので、遅れて届く返信はここ経由で渡す
  let applyLateReply: (r: CapResultReply | TaskResultReply | ErrorReply, fromId?: string) => void = () => {};
  let onActivity: (capId: string, fromId?: string) => void = () => {};
  let onWorkerReport: (n: WorkerReportNotice, fromId?: string) => void = () => {};
  const link = createServerLink({
    config,
    log,
    onLateCapReply: (r, fromId) => applyLateReply(r, fromId),
    onNotice: (n, fromId) => {
      if (n.type === "worker_report") {
        onWorkerReport(n, fromId);
        return;
      }
      activity.apply(n, fromId ?? "");
      onActivity(n.cap_id, fromId);
      const states = n.agents.map((a) => `${a.id}=${a.state}`).join(" ");
      if (lastStates.get(n.cap_id) !== states) {
        lastStates.set(n.cap_id, states);
        log(`activity 受信: cap_id=${n.cap_id} ${states}`);
      }
    },
  });
  // desktop のビルドと組になる版。違う server には更新を指示し、版が揃うまで指示を送らない
  const pair = resolvePair({ warn: log });
  log(`組の版: server=${pair.server ?? "(不明、版合わせは無効)"} protocol=${pair.protocol}`);
  // 更新待ちの run の cap_id から session 名を引く（この center の cap_id 接頭は後で読む）
  let centerCapId: string | undefined;
  const follow = createFollow({
    link,
    pair,
    log,
    onReach: (peer, ok, message) => remotes.noteReach(peer, ok, message),
    sessionOfCap: (cid) => (centerCapId !== undefined && cid.startsWith(`${centerCapId}-`) ? cid.slice(centerCapId.length + 1) || undefined : undefined),
  });
  link.setGate((peer, command) => follow.gate(peer, command));
  link.setVersionNote((peer) => follow.noteOf(peer));
  // session / remote の保存先は config と同じ dir（config の projects には書かない）
  const stateDir = dirname(resolve(configPath));
  const contextUsage = createContextUsageTracker({
    targets: () =>
      sessions
        .list()
        .filter((s) => s.source === "session")
        .map((s) => ({ name: s.name, path: s.path, startedAt: s.startedAt, running: s.state === "starting" || s.state === "connected" })),
    onChange: (name) => events.publish({ reason: "context", name }),
    ...(config.remoteControl.model ? { model: config.remoteControl.model } : {}),
    log,
  });
  const activityTracker = createSessionActivityTracker();
  const sessions = createSessionManager({
    config,
    events,
    activity: (name, startedAt, running) => activityTracker.get(name, startedAt, running),
    remote: (name) => remotes.summary(name),
    contextUsage: (name) => contextUsage.get(name),
    supervisor,
    store: createJsonListStore(join(stateDir, "sessions.json"), log),
    centerStore: createJsonObjectStore(join(stateDir, "center-settings.json"), log),
    memoryFile,
    // 旧設定 mcp-connections.json（M1 の CLI が書いた物）は起動時に普通の設定へ移し、移せたら .migrated に退ける
    // 追加の MCP の接続は設定 file を直接読む（運用者の書き換えが再起動なしで効く。読めなければ割り当て無し）
    // 旧設定の接続（builtin・auth.env）を普通の書き方へ移す材料。統括の server が無い時（stdio）は統括の項目は移せない（log に出る）
    legacyMcp: { coordinatorEntry: () => (coordState ? { ...coordinatorEntry(coordState) } : null), env: () => process.env },
    mcpSource: createMcpSource(join(stateDir, "center-settings.json"), join(stateDir, "sessions.json"), log),
    legacyConnections: {
      load: () => ({ ...connections.file.load(), exists: existsSync(connections.file.path) }),
      retire: () => renameSync(connections.file.path, `${connections.file.path}.migrated`),
    },
    // remotes は sessions の後に作るので、呼ばれる時に参照する
    renameRemoteSession: (oldName, newName) => remotes.renameSession(oldName, newName),
    remoteNameConflict: (name, mode, oldName) => remotes.conflictsWith(name, mode, oldName),
    // 範囲の変更を master-cap へ知らせる（完了通知と同じ messenger の push）
    notifyServersChanged: (name, text) => link.notifyPeer(capSessionName(name), text),
    // スリープの出入りで messenger の身代わり peer を置く・外す（gate は sessions の後に作るので、呼ばれる時に参照する）
    onSleepChange: (name, sleeping) => sleepGate.sync(name, sleeping),
    log,
  });
  // スリープ中の session 宛の message で、その session を起こす（身代わり peer。link は messenger の broker 1 つに繋がる）
  const sleepGate = createSleepGate({
    clientFactory: (peerName) => createProcessStandInClient(peerName, log),
    wake: (name) => sessions.wake(name),
    deliver: (name, text, mark) => link.notifyPeer(capSessionName(name), text, { mark }),
    peerMark: (name) => link.peerMarkOf(capSessionName(name)),
    isSleeping: (name) => sessions.list().some((s) => s.name === name && s.sleeping),
    peerName: capSessionName,
    log,
  });
  // 外部記憶への書き込み（設定がある session だけ。非同期キュー。失敗しても session・hook・remote は止まらない）
  const memoryEvents = createCenterMemoryEvents({ memoryOf: (name) => sessions.memoryOf(name), log });
  // リセッション（引継ぎを残して新しい会話で起動し直す。設計は docs/design/resession.md）
  const resession = createResessioner({
    info: (name) => sessions.list().find((x) => x.name === name),
    restartFresh: (name) => sessions.restartFresh(name),
    saveToMemory: (name, h) => memoryEvents.handoff(name, h),
    core,
    dir: join(stateDir, "handoffs"),
    log,
  });
  const capId = await loadCapId(stateDir, log);
  centerCapId = capId;
  log(`remote-cap の cap_id 接頭: ${capId}（center ごとに固定。session の cap_id は ${capId}-<session 名>）`);
  const remotes = createRemoteManager({
    link,
    capId,
    servers: config.servers,
    pushProgress: config.remotes.pushProgress,
    configPath,
    store: createJsonListStore(join(stateDir, "remotes.json"), log),
    // 旧形式（server_id の無い記録）を読み替える前の退避。remotes.json.pre-server-id.bak（既にあれば上書きしない）
    backup: async () => {
      if (await backupFileOnce(join(stateDir, "remotes.json"), ".pre-server-id.bak")) log("remotes.json を退避: remotes.json.pre-server-id.bak");
    },
    log,
    activity,
    onSummaryChange: (name) => events.publish({ reason: "remote", name }),
    // session ごとの servers（無ければ center 共通）。sessions は先に作ってあるので直接引く
    serversOf: (owner) => sessions.serversOf(owner),
    memoryEvents,
    // 通知先の messenger peer 名は session に付けた名前（capSessionName(owner)）。旧名への fallback は入れない（運用で補う。report 参照）
    notify: (owner, text) => link.notifyPeer(capSessionName(owner), text),
  });
  applyLateReply = (r, fromId) => void remotes.applyLateReply(r, fromId);
  onActivity = (id, fromId) => remotes.onActivity(id, fromId);
  onWorkerReport = (n, fromId) => remotes.onWorkerReport(n, fromId);

  let closing = false;
  let http: HttpHandle | null = null;
  const shutdown = async (reason: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log(`終了開始: ${reason}`);
    const hard = setTimeout(() => {
      log("終了処理が間に合わず強制終了");
      supervisor.killAllSync("SIGKILL");
      process.exit(1);
    }, config.remoteControl.stopGraceMs + HARD_EXIT_MARGIN_MS);
    hard.unref();
    try {
      // 子の停止を最優先にする（http.close が長引いても子に signal が届くように）
      follow.stop();
      coordChild?.stop();
      contextUsage.stop();
      memoryEvents.close();
      const results = await Promise.allSettled([supervisor.shutdown(), http?.close(), link.close(), sleepGate.close()]);
      for (const r of results) {
        if (r.status === "rejected") throw r.reason;
      }
    } catch (e) {
      log(`終了処理エラー: ${e instanceof Error ? e.message : String(e)}`);
    }
    log("終了");
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGHUP", () => void shutdown("SIGHUP"));
  // 例外で落ちる場合も子を残さない
  process.on("uncaughtException", (e) => {
    log(`uncaughtException: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    void shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (e) => {
    log(`unhandledRejection: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    void shutdown("unhandledRejection");
  });
  // どの経路で exit しても、残っている子には SIGKILL を送る（最後の砦。SIGKILL された時は走らない）
  process.on("exit", () => supervisor.killAllSync("SIGKILL"));
  // 読み手の消えた pipe への書込（EPIPE）で落ちない
  process.stderr.on("error", () => {});
  process.stdout.on("error", () => {});

  const makeServer = (launcher: boolean) => createCenterServer({ config, supervisor, link, sessions, remotes, follow, login, log, launcher });
  if (args.transport === "http") {
    if (!config.token || config.token.length < MIN_TOKEN_LEN) {
      throw new Error(`http transport には config の token（${MIN_TOKEN_LEN} 文字以上）が必要: ${configPath}`);
    }
    http = await startHttpServer({
      createServer: (launcher) => makeServer(launcher === true),
      ...(launcherKey ? { launcherKey } : {}),
      createSessionServer: (owner) => createSessionMcpServer({ remotes, follow, owner, resession }),
      sessionAuth: sessionTokens,
      onStatusLine: (name, payload) => {
        const s = sessions.list().find((x) => x.name === name);
        if (s && (s.state === "starting" || s.state === "connected")) contextUsage.applyStatusLine(name, payload, s.startedAt);
      },
      onHook: (name, payload) => {
        const s = sessions.list().find((x) => x.name === name);
        if (s && (s.state === "starting" || s.state === "connected") && activityTracker.apply(name, payload, s.startedAt)) events.publish({ reason: "activity", name });
        // turn の終わりの最後の応答を desktop へ（GET /events の session-message）
        if (s && (s.state === "starting" || s.state === "connected")) publishLastMessage(events, name, payload);
        // 外部記憶へ（応答を待たない。キューに積むだけ）
        if (s && (s.state === "starting" || s.state === "connected")) memoryEvents.onHook(name, payload);
        // リセッション待ちの session の Stop で再起動、起動し直した SessionStart で最初の入力（Stop の応答は先に返る。実行は次の tick）
        if (s && (s.state === "starting" || s.state === "connected")) resession.onHook(name, payload);
      },
      core,
      events,
      ...(config.workspace ? { workspace: config.workspace } : {}),
      port: args.port,
      bind: args.bind,
      token: config.token,
      log,
    });
    httpPort = http.port;
    // 統括の MCP の server（独立した process）。port・key は state dir の coordinator-mcp.json（初回に作る。以後は変わらない）
    try {
      coordState = await ensureCoordinatorState(stateDir, log);
      coordChild = startCoordinatorChild({ stateDir, centerUrl: `http://${centerHostOf(args.bind)}:${http.port}/mcp`, token: config.token, log });
    } catch (e) {
      coordState = null;
      log(`統括の MCP の server を起動しない: ${e instanceof Error ? e.message : String(e)}`);
    }
    watchParent({ onOrphan: (reason) => void shutdown(reason) });
  } else {
    // stdio は起動元（stdin / stdout の相手）だけが呼べる
    const server = makeServer(true);
    const transport = new StdioServerTransport();
    transport.onclose = () => void shutdown("MCP stdio 切断");
    // SDK の stdio transport は stdin の EOF を検知しないので自前で見る
    process.stdin.once("end", () => void shutdown("stdin EOF"));
    await server.connect(transport);
    log("MCP stdio 接続");
  }

  // transport を先に繋いでから、接続と autostart をバックグラウンドで進める
  void link.connectAll().finally(() => follow.start());
  // 古い記録の整理（同じ server_id の重複・長く確認できない到達先）。記録だけを消し、server には何も送らない
  const pruneTimer = setInterval(() => void remotes.prune().catch((e: unknown) => log(`remote 記録の整理失敗: ${e instanceof Error ? e.message : String(e)}`)), 10 * 60_000);
  pruneTimer.unref();
  void remotes.restore().catch((e: unknown) => log(`remote 記録の復元失敗: ${e instanceof Error ? e.message : String(e)}`));
  contextUsage.start();
  void sessions.restore().catch((e: unknown) => log(`session の復帰失敗: ${e instanceof Error ? e.message : String(e)}`));
  for (const p of config.projects) {
    if (!p.autostart) continue;
    supervisor.start(p.name).catch((e: unknown) => {
      log(`autostart 失敗: project=${p.name} ${e instanceof Error ? e.message : String(e)}`);
    });
  }
}
