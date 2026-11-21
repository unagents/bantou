import { mkdir, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { projectSchema, PERMISSION_MODES, type Config, type ProjectConfig } from "./config.js";
import { assertCenterOnly, CENTER_SERVERS_ERROR, composeAddDirs, composeInstructions, composeOutputStyle, composeServers, mergeSettings, projectSettingsPatchSchema, readCenterSettings, readCoordinator, readSettings, type CenterSettingsPatch, type MemorySetting, type ProjectSettings, type ProjectSettingsPatch } from "./project-settings.js";
import { connectionsFromSettings, emptyConnections, type ConnectionsData } from "./mcp-connections.js";
import type { McpSource } from "./mcp-source.js";
import { parseMemoryFile, type MemoryFile, type MemoryFileData } from "./memory-settings.js";
import type { Logger } from "./log.js";
import type { RcStatus, RemoteControlSupervisor } from "./remote-control.js";
import type { EventHub } from "./events.js";
import type { JsonListStore, JsonObjectStore } from "./store.js";
import type { ContextUsage } from "./context-usage.js";
import type { SessionActivityView } from "./session-activity.js";
import type { RemoteSummary } from "./remotes.js";

export const SESSION_NAME = /^[A-Za-z0-9_-]+$/;

/** center が自前で保存する session（config の projects には書かない）。 */
export interface SavedSession {
  name: string;
  path: string;
  permissionMode: ProjectConfig["permissionMode"];
  /** プロジェクトごとの設定（instructions など。未知の項目も保持）。無ければ未設定。 */
  settings?: ProjectSettings;
  createdAt: string;
}

export interface SessionInfo {
  name: string;
  path: string;
  state: RcStatus["state"];
  pid: number | null;
  sessionUrl: string | null;
  startedAt: string | null;
  /** config = config の projects、session = session_create で作ったもの。 */
  source: "config" | "session";
  lastError?: string;
  /** claude のコンテキスト使用状況。まだ分からない（transcript が無い等）時は null。 */
  contextUsage: ContextUsage | null;
  /**
   * 作業状態。working = turn 実行中 / needs-input = 利用者の入力待ち（permission・AskUserQuestion・plan 承認）/ idle = turn が終わり次の指示待ち / unknown = 不明（停止中・起動し直し直後・center 再起動直後）。
   * unknown の時、desktop は何も表示しない。thread の ask（waiting）は center の知らない desktop 側の情報なので、ここには含まない。
   */
  activity: SessionActivityView["activity"];
  /** activity が最後に変わった時刻（ISO）。unknown の時は null。 */
  activityAt: string | null;
  /** その session の cap（remote）の集計。running = 未完了の指示がある server の数、waitingReply = worker_reply が未返答の ask / approve の数。cap が無ければ 0 / 0。 */
  remote: RemoteSummary;
  /** 起動時に追加指示（instructions）を付けたか。本文は出さない。 */
  instructions: boolean;
  /** claude の認証状態（RcStatus と同じ）。 */
  auth: RcStatus["auth"];
  loginUrl: string | null;
  loginError: string | null;
}

export const sessionCreateSchema = {
  name: z.string().regex(SESSION_NAME, "英数字と _ - のみ"),
  path: z.string().min(1).optional().describe("絶対パス。省略時は <workspace>/<name>（無ければ作る）"),
  permissionMode: z.enum(PERMISSION_MODES).optional().describe("省略時 auto"),
  settings: projectSettingsPatchSchema.optional().describe("プロジェクトごとの設定（{ instructions?: string, addDirs?: string[], outputStyle?: string, servers?: string[], … }）。instructions は --append-system-prompt、addDirs（絶対パス）は 1 つずつ --add-dir で渡す、outputStyle（claude の output style の markdown 本文）は session のフォルダの .claude/output-styles/bantou.md に書いて --settings で選ぶ（再起動・--continue でも付く）。servers（host 名か server_id）はこの session が使う server の範囲（未設定 = 全部、空配列 = 使わない）。外部記憶（memory）は MCP からは設定できない（含めると error。center の `bantou-center memory` で設定する）"),
};

export const sessionUpdateSchema = {
  name: z.string().regex(SESSION_NAME, "英数字と _ - のみ"),
  newName: z.string().regex(SESSION_NAME, "英数字と _ - のみ").optional().describe("新しい名前。省略時は名前を変えない"),
  path: z.string().min(1).optional().describe("新しい path（絶対パス）。省略時は path を変えない"),
  move: z.boolean().optional().describe("path 指定時のみ有効。true = 今のフォルダを新しい path へ移動（rename。失敗したら何も変えない。コピーはしない）。省略・false = 新しい path を作るだけで今のフォルダは残す"),
};

export interface SessionUpdateInput {
  name: string;
  newName?: string;
  path?: string;
  move?: boolean;
}

export interface SessionManager {
  /** 保存済みの session を supervisor に載せて --continue で復帰させる（失敗時は素の起動へ fallback）。 */
  restore(): Promise<void>;
  /** 今の接続の設定（center 共通 + 各 session の mcpServers から呼ぶたびに作る。割り当ての判定と --mcp-config が使う。書く経路は無い）。 */
  mcpConnections(): { data: ConnectionsData; problems: string[] };
  create(input: { name: string; path?: string; permissionMode?: ProjectConfig["permissionMode"]; settings?: ProjectSettingsPatch; /** false = 作って保存するだけで起動しない。省略 = 起動する。 */ start?: boolean }): Promise<SessionInfo>;
  /** session の settings を返す（未設定・config 由来の project は `{}`。未定義の name は例外）。 */
  getSettings(name: string): { name: string; settings: ProjectSettings };
  /**
   * settings を項目ごとにマージして保存し、更新後の全体を返す（null = 項目を削除、未知の項目は保持）。
   * session_create で作った session のみ。動いている session には効かず、次の起動から効く。
   */
  updateSettings(name: string, patch: ProjectSettingsPatch): Promise<{ name: string; settings: ProjectSettings }>;
  /** center 共通の設定（全 session に効く。instructions は各 session の追加指示の前に付く）。未設定は `{}`。 */
  getCenterSettings(): { settings: ProjectSettings };
  /** session が使ってよい server の指定（session の servers だけ。center 共通の設定には無い）。undefined = 全部。 */
  serversOf(name: string): string[] | undefined;
  /** その session の外部記憶（共通 + session の合成後）。無ければ undefined。 */
  memoryOf(name: string): MemorySetting | undefined;
  /** center 共通の設定を項目ごとにマージして保存し、全 session の次の起動に反映する。更新後の全体を返す。servers（null 以外）は error。 */
  updateCenterSettings(patch: CenterSettingsPatch): Promise<{ settings: ProjectSettings }>;
  /**
   * session の名前（newName）と path を変える（session_create で作ったものだけ）。停止 → フォルダの移動 / 作成 → 記録の更新 → 新しい名前で起動し直す（resume）。
   * path を変えた時は --continue が「会話が無い」で落ち、素の起動へ fallback する。cap_id は変えない。失敗時は記録と名前を元に戻して起動し直す（best effort）。
   */
  update(input: SessionUpdateInput): Promise<SessionInfo>;
  delete(name: string): Promise<{ name: string; deleted: true }>;
  list(): SessionInfo[];
}

/**
 * session（center 上の master-cap）の起動・削除・一覧。実体は pty wrapper 経由の対話型 `claude --remote-control <name>` を path で動かす supervisor の entry。
 * 保存先は center 自前の状態ファイル（config とは別）。
 */
export function createSessionManager(opts: {
  config: Config;
  supervisor: RemoteControlSupervisor;
  store: JsonListStore<SavedSession>;
  /** center 共通の設定の保存先（center-settings.json）。省略時は共通の設定なし（更新は保存されない）。 */
  centerStore?: JsonObjectStore<ProjectSettings>;
  /** 外部記憶の設定（memory-settings.json。CLI だけが書く）。省略時は外部記憶なし。 */
  memoryFile?: MemoryFile;
  /**
   * 旧設定 mcp-connections.json（M1 の CLI が書いていた接続の file）。あれば起動時に普通の設定（mcpServers）へ移し、移せたら retire() で退ける。
   * 省略時は mcp-connections.json の移行をしない。
   */
  legacyConnections?: { load(): { data: ConnectionsData; exists: boolean; problem?: string }; retire(): void };
  /**
   * 追加の MCP の接続（mcpServers）を設定 file から今の値で読む元（mcp-source.ts）。mcpConnections() はこれを呼ぶたびに読む（運用者が file を直接書き換えた内容が、
   * 再起動なしで次の判定・起動から効く）。保存の前にも、この値を設定の記録へ写す（center の保存が運用者の書き換えを巻き戻さない）。省略時は memory の値。
   */
  mcpSource?: () => McpSource | undefined;
  log: Logger;
  /** create 後、接続（URL 取得）か失敗を待つ上限。0 で待たない。既定 15 秒。 */
  waitMs?: number;
  /** session の増減を通知する先（GET /events）。省略時は通知しない。 */
  events?: EventHub;
  /** session ごとのコンテキスト使用状況の取得元。省略時は常に null。 */
  contextUsage?: (name: string) => ContextUsage | null;
  /** session ごとの作業状態の取得元（startedAt = 今回の起動時刻、running = 起動中か）。省略時は常に unknown。 */
  activity?: (name: string, startedAt: string | null, running: boolean) => SessionActivityView;
  /** session ごとの remote 集計の取得元。省略時は常に 0 / 0。 */
  remote?: (name: string) => RemoteSummary;
  /** update で名前を変えた時に remotes の記録（session / pending の owner）を付け替える先。省略時は何もしない。 */
  renameRemoteSession?: (oldName: string, newName: string) => Promise<unknown> | unknown;
  /** name が remote の記録と衝突する理由（無ければ null）。create / update の newName の検証に使う。省略時は検査しない。 */
  remoteNameConflict?: (name: string, mode: "create" | "rename", oldName?: string) => string | null;
  /** session の使う server の範囲（settings.servers）が変わった時に、その session の master-cap へ知らせる先（messenger の push）。省略時は知らせない。失敗しても更新は成功にする。 */
  notifyServersChanged?: (name: string, text: string) => Promise<{ ok: boolean; reason?: string }>;
}): SessionManager {
  const { config, supervisor, store, log } = opts;
  const waitMs = opts.waitMs ?? 15_000;
  const saved = new Map<string, SavedSession>();
  /** center 共通の設定（restore で読む）。 */
  let common: ProjectSettings = {};
  /** 同時の create / delete を直列にする（重複判定と保存を競合させない）。 */
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  /**
   * memory-settings.json に移せなかった旧形式の memory（元の値のまま）。次の起動で移し直せるよう、保存のたびに書き戻す
   * （書き戻さないと他項目の更新の保存で旧形式が disk から消える）。移行できた起動では空。
   */
  const legacyKeep: { common?: unknown; sessions: Map<string, unknown> } = { sessions: new Map() };
  const withLegacy = (rec: SavedSession): SavedSession => {
    if (!legacyKeep.sessions.has(rec.name)) return rec;
    return { ...rec, settings: { ...(rec.settings ?? {}), memory: legacyKeep.sessions.get(rec.name) } as ProjectSettings };
  };
  /** 割り当てへ移せなかった旧設定の coordinator（元の値のまま）。次の起動で移し直せるよう、保存のたびに書き戻す。 */
  let pendingCoordinator: unknown;
  const withLegacyCommon = (s: ProjectSettings): ProjectSettings => {
    const o: ProjectSettings = "common" in legacyKeep ? ({ ...s, memory: legacyKeep.common } as ProjectSettings) : s;
    return pendingCoordinator !== undefined ? { ...o, coordinator: pendingCoordinator } : o;
  };

  /** 改名の保存の間だけ持つ「記録の名前 → disk 上の名前」。adoptMcpFromDisk が disk の mcpServers を引くのに使う。 */
  const diskAlias = new Map<string, string>();

  /** 設定 file の mcpServers（運用者が直接書いた物）を記録へ写す。保存が運用者の書き換えを巻き戻さないように、保存の前に呼ぶ。読めなければ何もしない。 */
  const adoptMcpFromDisk = (): void => {
    const src = opts.mcpSource?.();
    if (!src) return;
    for (const rec of saved.values()) {
      // 改名の保存中は disk がまだ旧い名前（巻き戻しの保存中は新しい名前）なので、diskAlias の名前でも引く（引けないと割り当てが消える）
      const alias = diskAlias.get(rec.name);
      const m = src.sessions.get(rec.name) ?? (alias !== undefined ? src.sessions.get(alias) : undefined);
      const st: Record<string, unknown> = { ...(rec.settings ?? {}) };
      if (m === undefined) delete st.mcpServers;
      else st.mcpServers = m;
      if (Object.keys(st).length) rec.settings = st as ProjectSettings;
      else delete rec.settings;
    }
    if (src.common === undefined) delete common.mcpServers;
    else common.mcpServers = src.common as Record<string, unknown>;
  };

  const persist = (): Promise<void> => {
    adoptMcpFromDisk();
    return store.save([...saved.values()].map(withLegacy));
  };

  const info = (s: RcStatus): SessionInfo => ({
    name: s.project,
    path: s.path,
    state: s.state,
    pid: s.pid,
    sessionUrl: s.sessionUrl,
    startedAt: s.startedAt,
    source: saved.has(s.project) ? "session" : "config",
    ...(s.lastError ? { lastError: s.lastError } : {}),
    contextUsage: opts.contextUsage?.(s.project) ?? null,
    ...(opts.activity?.(s.project, s.startedAt, s.state === "starting" || s.state === "connected") ?? { activity: "unknown" as const, activityAt: null }),
    remote: opts.remote?.(s.project) ?? { running: 0, waitingReply: 0 },
    instructions: s.instructions,
    auth: s.auth,
    loginUrl: s.loginUrl,
    loginError: s.loginError,
  });

  const toProject = (s: SavedSession): ProjectConfig =>
    projectSchema.parse({ name: s.name, path: s.path, permissionMode: s.permissionMode });

  /** 共通 + session の settings から supervisor に渡す instructions / addDirs / outputStyle（あれば）。 */
  const instrOpt = (s: ProjectSettings | undefined): { instructions?: string; addDirs?: string[]; outputStyle?: string } => {
    const i = composeInstructions(common, s);
    const d = composeAddDirs(common, s);
    const o = composeOutputStyle(common, s);
    return { ...(i ? { instructions: i } : {}), ...(d.length ? { addDirs: d } : {}), ...(o ? { outputStyle: o } : {}) };
  };

  /** 接続（URL 取得）か失敗までを少し待つ。待ちきれなければ starting のまま返す。 */
  const settle = async (name: string, first: RcStatus): Promise<RcStatus> => {
    let st = first;
    const deadline = Date.now() + waitMs;
    // 一度でも終了したら（trust 未承認などの即死）待たずに、原因（lastError）付きで返す
    while (Date.now() < deadline && (st.state === "starting" || st.state === "connected") && !st.sessionUrl && !st.lastExit) {
      await sleep(200);
      st = supervisor.status(name);
    }
    return st;
  };

  /** saved の順を保ったまま name の記録を差し替える（改名で並びを変えない）。 */
  const replaceSaved = (oldName: string, rec: SavedSession): void => {
    const next = [...saved.entries()].map(([k, v]): [string, SavedSession] => (k === oldName ? [rec.name, rec] : [k, v]));
    saved.clear();
    for (const [k, v] of next) saved.set(k, v);
  };

  /** session の外部記憶の設定を別の名前へ付け替える（from の分は消える。無ければ何もしない）。 */
  const moveMemory = (from: string, to: string | undefined): void => {
    const f = opts.memoryFile;
    if (!f) return;
    const d = f.read();
    const m = d.sessions[from];
    if (!m) return;
    delete d.sessions[from];
    if (to !== undefined) d.sessions[to] = m;
    f.write(d);
  };

  /**
   * 旧形式（sessions.json / center-settings.json の settings.memory）を memory-settings.json へ移し、元から消す。
   * memory-settings.json に同じ範囲の値があればそちらを残す。値は log に出さない。
   */
  const migrateLegacyMemory = async (rawCommon: unknown, list: SavedSession[]): Promise<boolean> => {
    const f = opts.memoryFile;
    if (!f) return false;
    const legacyOf = (settings: unknown): MemorySetting | undefined => {
      if (typeof settings !== "object" || settings === null || !("memory" in settings)) return undefined;
      return parseMemoryFile({ common: (settings as { memory: unknown }).memory }).common;
    };
    const hasKey = (settings: unknown): boolean => typeof settings === "object" && settings !== null && "memory" in settings;
    const commonHas = hasKey(rawCommon);
    const withKey = list.filter((s) => hasKey(s.settings));
    if (!commonHas && withKey.length === 0) return false;
    const d = f.read();
    const lc = legacyOf(rawCommon);
    if (lc && !d.common) d.common = lc;
    for (const s of withKey) {
      const m = legacyOf(s.settings);
      if (m && !(s.name in d.sessions)) d.sessions[s.name] = m;
    }
    try {
      f.write(d);
    } catch (e) {
      // 旧形式は消さず、この起動の間は旧い値で動く（次の起動で移し直す）。fs のエラー文は path だけで、値は出さない
      const legacy: MemoryFileData = { sessions: {} };
      if (lc) legacy.common = lc;
      for (const s of withKey) {
        const m = legacyOf(s.settings);
        if (m) legacy.sessions[s.name] = m;
      }
      f.useFallback(legacy);
      if (commonHas) legacyKeep.common = (rawCommon as { memory: unknown }).memory;
      for (const s of withKey) legacyKeep.sessions.set(s.name, (s.settings as { memory: unknown }).memory);
      log(`外部記憶の設定を memory-settings.json へ移せない（旧形式のまま残し、この起動は旧い値で動く）: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    if (commonHas && opts.centerStore) await opts.centerStore.save(readCenterSettings(rawCommon));
    for (const s of withKey) {
      const next = readSettings(s.settings);
      if (Object.keys(next).length) s.settings = next;
      else delete s.settings;
    }
    log(`外部記憶の設定を memory-settings.json へ移した（共通 ${lc ? 1 : 0} 件、session ${withKey.length} 件。値は出さない）`);
    return withKey.length > 0;
  };

  /**
   * 旧設定の統括の指定（center-settings.json の coordinator.session）を割り当てへ移す。冪等。
   * 割り当てを保存できた時だけ旧設定を消す（保存できなければ残して log。その間は統括の口は割り当て無し = 道具は出ない）。
   */
  const migrateLegacyMcp = async (rawCommon: unknown, list: SavedSession[]): Promise<unknown> => {
    const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
    const hasCoord = opts.centerStore !== undefined && isRec(rawCommon) && Object.hasOwn(rawCommon, "coordinator");
    const legacyFile = opts.legacyConnections?.load();
    if (legacyFile?.exists && legacyFile.problem)
      log(`移行失敗: mcp-connections.json を読めないので移さずに残す（${legacyFile.problem}）。直すか、中身を center-settings.json / sessions.json の mcpServers へ手で移す`);
    const fileData = legacyFile?.exists && !legacyFile.problem ? legacyFile.data : undefined;
    if (!hasCoord && fileData === undefined) return rawCommon;
    const raw: Record<string, unknown> = isRec(rawCommon) ? { ...rawCommon } : {};
    /** target.mcpServers に name が無ければ足す（設定にある物が勝つ = 冪等）。足したら true。 */
    const addTo = (target: Record<string, unknown>, name: string, v: unknown): boolean => {
      const cur = isRec(target.mcpServers) ? { ...target.mcpServers } : {};
      if (Object.hasOwn(cur, name)) return false;
      Object.defineProperty(cur, name, { value: v, enumerable: true, writable: true, configurable: true });
      target.mcpServers = cur;
      return true;
    };
    let sessionsChanged = false;
    let commonChanged = false;
    let ok = true;
    const touched = new Set<string>();
    /** session_create で作った session の設定へ足す。その session が無ければ false。 */
    const addSession = (name: string, conn: string, v: unknown): boolean => {
      const rec = list.find((r) => r.name === name);
      if (!rec) return false;
      const st: Record<string, unknown> = { ...(rec.settings ?? {}) };
      if (addTo(st, conn, v)) {
        rec.settings = st as ProjectSettings;
        sessionsChanged = true;
        touched.add(name);
      }
      return true;
    };
    let coordinatorRaw: unknown;
    if (hasCoord) {
      coordinatorRaw = raw.coordinator;
      const legacy = readCoordinator(coordinatorRaw);
      if (legacy === null) {
        log("旧設定の統括の指定（center-settings.json の coordinator）が壊れているので捨てた");
        delete raw.coordinator;
        commonChanged = true;
        coordinatorRaw = undefined;
      } else if (addSession(legacy, "bantou-coordinator", { transport: "builtin", builtin: "coordinator" })) {
        delete raw.coordinator;
        commonChanged = true;
        log(`旧設定の統括の指定を session の設定（mcpServers の bantou-coordinator）へ移した: session=${legacy}`);
      } else {
        ok = false;
        log(`移行失敗: 旧設定の統括の指定の session が session_create で作った物の中に無い（${legacy}）。center-settings.json の coordinator は残す（統括の口は割り当て無しで動く）。その session の設定の mcpServers に bantou-coordinator を書く`);
      }
    }
    if (fileData !== undefined) {
      for (const [name, c] of Object.entries(fileData.common)) if (addTo(raw, name, c)) commonChanged = true;
      for (const [session, per] of Object.entries(fileData.sessions)) {
        for (const [name, ov] of Object.entries(per)) {
          if (!addSession(session, name, ov)) {
            ok = false;
            log(`移行失敗: mcp-connections.json の session が session_create で作った物の中に無い（${session}）。file は残す`);
            break;
          }
        }
      }
    }
    let saveOk = true;
    if (sessionsChanged) {
      try {
        await store.save(list);
      } catch (e) {
        saveOk = false;
        log(`移行失敗: session の設定を保存できない（次の起動でやり直す）: ${(e as Error).message}`);
      }
    }
    if (commonChanged && opts.centerStore) {
      try {
        await opts.centerStore.save(raw as ProjectSettings);
      } catch (e) {
        saveOk = false;
        log(`移行失敗: center 共通の設定を保存できない（次の起動でやり直す）: ${(e as Error).message}`);
      }
    }
    // 旧設定の coordinator が disk に残る時は、以後の保存で消えないよう書き戻す（移せた起動でも保存に失敗した時、移せなかった時）
    if (coordinatorRaw !== undefined && (!ok || !saveOk)) pendingCoordinator = coordinatorRaw;
    if (fileData !== undefined) {
      if (ok && saveOk) {
        try {
          opts.legacyConnections?.retire();
          log("mcp-connections.json の内容を普通の設定（mcpServers）へ移した（file は .migrated に退けた）");
        } catch (e) {
          log(`移行失敗: mcp-connections.json を退けられない（次の起動でも移すが、設定にある物が勝つので重複しない）: ${(e as Error).message}`);
        }
      } else log("mcp-connections.json は移し切れなかったので残す");
    }
    if (touched.size) log(`旧設定から mcpServers を設定へ移した session: ${[...touched].join(",")}`);
    return raw;
  };

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  return {
    async restore() {
      let rawCommon: unknown = opts.centerStore ? await opts.centerStore.load() : undefined;
      const list = await store.load();
      rawCommon = await migrateLegacyMcp(rawCommon, list);
      const migrated = await migrateLegacyMemory(rawCommon, list);
      if (opts.centerStore) {
        common = readCenterSettings(rawCommon);
        if (Object.keys(common).length) log(`center 共通の設定を読んだ (項目: ${Object.keys(common).join(",")})`);
      }
      for (const s of list) {
        try {
          if (!SESSION_NAME.test(s.name) || !isAbsolute(s.path)) throw new Error("保存内容が不正");
          supervisor.add(toProject(s), { wrapper: true, ...instrOpt(s.settings) });
          saved.set(s.name, s);
          opts.events?.publish({ reason: "restored", name: s.name });
          await mkdir(s.path, { recursive: true });
          await supervisor.start(s.name, { resume: true });
          log(`session 復帰: ${s.name} (${s.path})`);
        } catch (e) {
          log(`session 復帰失敗: ${s.name} ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (migrated) await persist();
    },

    create: (input) =>
      serial(async () => {
        const { name } = input;
        if (!SESSION_NAME.test(name)) throw new Error("name は英数字と _ - のみ");
        const existing = supervisor.list();
        if (existing.some((s) => s.project === name)) throw new Error(`name が既に使われている: ${name}`);
        let path = input.path;
        if (path === undefined) {
          if (!config.workspace) throw new Error("path を省略できない: config に workspace が無い（path を指定する）");
          path = join(config.workspace, name);
        }
        if (!isAbsolute(path)) throw new Error("path は絶対パスで指定する");
        path = resolve(path);
        const clash = existing.find((s) => resolve(s.path) === path);
        if (clash) throw new Error(`path が既に使われている: ${path}（${clash.project}）`);
        const rc = opts.remoteNameConflict?.(name, "create");
        if (rc) throw new Error(rc);
        await mkdir(path, { recursive: true });
        assertCenterOnly(input.settings);
        const settings = input.settings ? mergeSettings(undefined, input.settings) : undefined;
        const rec: SavedSession = {
          name,
          path,
          permissionMode: input.permissionMode ?? "auto",
          ...(settings && Object.keys(settings).length ? { settings } : {}),
          createdAt: new Date().toISOString(),
        };
        supervisor.add(toProject(rec), { wrapper: true, ...instrOpt(rec.settings) });
        saved.set(name, rec);
        try {
          await persist();
        } catch (e) {
          saved.delete(name);
          await supervisor.remove(name);
          throw new Error(`状態ファイルに保存できない: ${(e as Error).message}`);
        }
        opts.events?.publish({ reason: "created", name });
        if (input.start === false) {
          log(`session 作成（起動しない）: ${name} (${path})`);
          return info(supervisor.status(name));
        }
        const st = await supervisor.start(name);
        log(`session 作成: ${name} (${path})`);
        return info(await settle(name, st));
      }),

    getSettings: (name) => {
      const known = supervisor.list().some((p) => p.project === name);
      if (!known) throw new Error(`未定義の session: ${name}`);
      return { name, settings: readSettings(saved.get(name)?.settings) };
    },

    updateSettings: (name, patch) =>
      serial(async () => {
        assertCenterOnly(patch);
        const rec = saved.get(name);
        if (!rec) {
          const known = supervisor.list().some((p) => p.project === name);
          throw new Error(known ? `session_create で作ったものではない（config 由来）: ${name}` : `未定義の session: ${name}`);
        }
        const prev = rec.settings;
        const next = mergeSettings(readSettings(prev), patch);
        if (Object.keys(next).length) rec.settings = next;
        else delete rec.settings;
        try {
          await persist();
        } catch (e) {
          if (prev === undefined) delete rec.settings;
          else rec.settings = prev;
          throw new Error(`状態ファイルに保存できない: ${(e as Error).message}`);
        }
        supervisor.setInstructions(name, composeInstructions(common, next));
        supervisor.setAddDirs(name, composeAddDirs(common, next));
        supervisor.setOutputStyle(name, composeOutputStyle(common, next));
        log(`session の設定を更新: ${name} (項目: ${Object.keys(next).join(",") || "なし"})`);
        const before = composeServers(prev);
        const after = composeServers(next);
        if (JSON.stringify(before) !== JSON.stringify(after) && opts.notifyServersChanged) {
          const fmt = (s: string[] | undefined): string => (s === undefined ? "指定なし（全部）" : s.length === 0 ? "なし（どの server も使わない）" : s.join(", "));
          const text = `[使う server の範囲が変わった] ${fmt(before)} → ${fmt(after)}。remote_send の server 省略・remote_list の既定はこの範囲に従う。範囲外になった自分の古い cap は remote_id を指して remote_delete で片付けられる。（session の設定 settings.servers。起動時の指示文には次の起動で反映される）`;
          void Promise.resolve(opts.notifyServersChanged(name, text)).then(
            (r) => { if (!r.ok) log(`範囲の変更を知らせられない: ${name} ${r.reason ?? ""}`); },
            (e: unknown) => log(`範囲の変更を知らせられない: ${name} ${e instanceof Error ? e.message : String(e)}`),
          );
        }
        return { name, settings: next };
      }),

    getCenterSettings: () => ({ settings: { ...common } }),

    serversOf: (name) => composeServers(saved.get(name)?.settings),

    memoryOf: (name) => opts.memoryFile?.resolve(name),

    mcpConnections: () => {
      if (opts.mcpSource) {
        const src = opts.mcpSource();
        // 設定 file を読めない時は割り当て無し（fail closed）
        if (!src) return { data: emptyConnections(), problems: ["設定 file を読めない"] };
        return connectionsFromSettings({ mcpServers: src.common }, [...src.sessions].map(([n, m]): [string, { mcpServers: unknown }] => [n, { mcpServers: m }]));
      }
      return connectionsFromSettings(common, [...saved.values()].map((r): [string, ProjectSettings | undefined] => [r.name, r.settings]));
    },

    updateCenterSettings: (patch) =>
      serial(async () => {
        assertCenterOnly(patch);
        // servers は session の設定だけ。null（削除）は無害なので通し、それ以外は黙って捨てずに error にする
        if (patch.servers !== undefined && patch.servers !== null) throw new Error(CENTER_SERVERS_ERROR);
        adoptMcpFromDisk();
        const prev = common;
        const next = readCenterSettings(mergeSettings(prev, patch as ProjectSettingsPatch));
        if (opts.centerStore) {
          try {
            await opts.centerStore.save(withLegacyCommon(next));
          } catch (e) {
            throw new Error(`設定ファイルに保存できない: ${(e as Error).message}`);
          }
        }
        common = next;
        // 全 session の次の起動から効く（動いている session は起動し直さない）
        for (const rec of saved.values()) {
          supervisor.setInstructions(rec.name, composeInstructions(common, rec.settings));
          supervisor.setAddDirs(rec.name, composeAddDirs(common, rec.settings));
          supervisor.setOutputStyle(rec.name, composeOutputStyle(common, rec.settings));
        }
        log(`center 共通の設定を更新 (項目: ${Object.keys(next).join(",") || "なし"})`);
        return { settings: next };
      }),

    update: (input) =>
      serial(async () => {
        const { name } = input;
        const rec = saved.get(name);
        if (!rec) {
          const known = supervisor.list().some((s) => s.project === name);
          throw new Error(known ? `session_create で作ったものではない（config 由来）: ${name}` : `未定義の session: ${name}`);
        }
        const existing = supervisor.list();
        const newName = input.newName ?? name;
        if (!SESSION_NAME.test(newName)) throw new Error("name は英数字と _ - のみ");
        const renaming = newName !== name;
        if (renaming && existing.some((s) => s.project === newName)) throw new Error(`name が既に使われている: ${newName}`);
        if (renaming) {
          const rc = opts.remoteNameConflict?.(newName, "rename", name);
          if (rc) throw new Error(rc);
        }
        let newPath = rec.path;
        if (input.path !== undefined) {
          if (!isAbsolute(input.path)) throw new Error("path は絶対パスで指定する");
          newPath = resolve(input.path);
        }
        const moving = resolve(newPath) !== resolve(rec.path);
        if (moving) {
          const clash = existing.find((s) => s.project !== name && resolve(s.path) === newPath);
          if (clash) throw new Error(`path が既に使われている: ${newPath}（${clash.project}）`);
          // 移動は今のフォルダの中へはできない（親 dir を作ってから rename が失敗し、空 dir が残る）
          const rel = relative(resolve(rec.path), newPath);
          if (input.move === true && rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) throw new Error(`今のフォルダの配下へは移動できない: ${newPath}（${rec.path}）`);
        }
        if (!renaming && !moving) throw new Error("変更が無い: newName か今と違う path を指定する");

        const oldRec = rec;
        const newRec: SavedSession = { ...rec, name: newName, path: newPath };
        const doMove = moving && input.move === true;
        let renamedRemotes = false;
        let moved = false;
        let swapped = false;
        let added = false;
        let movedMemory = false;
        await supervisor.remove(name);
        try {
          if (moving) {
            if (doMove) {
              await mkdir(dirname(newPath), { recursive: true });
              await rename(oldRec.path, newPath);
              moved = true;
            } else {
              await mkdir(newPath, { recursive: true });
            }
          }
          replaceSaved(name, newRec);
          swapped = true;
          try {
            if (renaming) diskAlias.set(newName, name);
            await persist();
          } catch (e) {
            throw new Error(`状態ファイルに保存できない: ${(e as Error).message}`);
          } finally {
            diskAlias.delete(newName);
          }
          if (renaming) {
            moveMemory(name, newName);
            movedMemory = true;
          }
          if (renaming && opts.renameRemoteSession) {
            // 呼び出し中に例外（persist 失敗など）でも remotes のメモリは付け替わりうるので、先に印を立てて戻す
            renamedRemotes = true;
            await opts.renameRemoteSession(name, newName);
          }
          supervisor.add(toProject(newRec), { wrapper: true, ...instrOpt(newRec.settings) });
          added = true;
          const st = await supervisor.start(newName, { resume: true });
          opts.events?.publish({ reason: "updated", name: newName });
          log(`session 更新: ${name} -> ${newName} (${oldRec.path} -> ${newPath}${doMove ? ", フォルダ移動" : ""})`);
          return info(await settle(newName, st));
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e);
          log(`session 更新失敗、元に戻す: ${name} ${why}`);
          const undo = async (what: string, fn: () => Promise<unknown> | unknown): Promise<void> => {
            try {
              await fn();
            } catch (e2) {
              log(`session 更新の巻き戻し失敗 (${what}): ${name} ${e2 instanceof Error ? e2.message : String(e2)}`);
            }
          };
          if (movedMemory) await undo("外部記憶の設定の付け替え", () => moveMemory(newName, name));
          if (added) await undo("新しい名前の停止", () => supervisor.remove(newName));
          if (renamedRemotes) await undo("remotes の付け替え", () => opts.renameRemoteSession?.(newName, name));
          if (swapped) {
            replaceSaved(newName, oldRec);
            // 保存が済んでいれば disk は新しい名前。旧い名前の mcpServers を新しい名前から引く
            diskAlias.set(name, newName);
            await undo("状態ファイルの復元", persist);
            diskAlias.delete(name);
          }
          if (moved) await undo("フォルダの移動を戻す", () => rename(newPath, oldRec.path));
          await undo("元の名前で起動", async () => {
            supervisor.add(toProject(oldRec), { wrapper: true, ...instrOpt(oldRec.settings) });
            await supervisor.start(name, { resume: true });
          });
          throw new Error(`session を更新できない（元に戻した）: ${why}`);
        }
      }),

    delete: (name) =>
      serial(async () => {
        if (!saved.has(name)) {
          const known = supervisor.list().some((s) => s.project === name);
          throw new Error(known ? `session_create で作ったものではない（config 由来）: ${name}` : `未定義の session: ${name}`);
        }
        await supervisor.remove(name);
        saved.delete(name);
        await persist();
        try {
          moveMemory(name, undefined);
        } catch (e) {
          log(`外部記憶の設定を消せない: ${name} ${e instanceof Error ? e.message : String(e)}`);
        }
        opts.events?.publish({ reason: "deleted", name });
        log(`session 削除: ${name}`);
        return { name, deleted: true as const };
      }),

    list: () => supervisor.list().map(info),
  };
}
