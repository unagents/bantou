import { mkdir, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { projectSchema, PERMISSION_MODES, type Config, type ProjectConfig } from "./config.js";
import { isLegacyEntry, migrateEntry, type LegacyCtx } from "./mcp-legacy.js";
import { assertCenterOnly, CENTER_SERVERS_ERROR, composeAddDirs, composeInstructions, composeOutputStyle, composeServers, mergeSettings, projectSettingsPatchSchema, readCenterSettings, readCoordinator, readSettings, settingsIssues, type CenterSettingsPatch, type ProjectSettings, type ProjectSettingsPatch } from "./project-settings.js";
import { connectionsFromSettings, emptyConnections, serverEntryIssues, type ConnectionsData } from "./mcp-connections.js";
import type { McpSource } from "./mcp-source.js";
import { memoryDefOf, validMemoryDef, type McpServerDef } from "./mcp-server-def.js";
import type { MemoryFile, MemoryFileData, MemorySetting } from "./memory-settings.js";
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
  /** スリープ中（claude の process を止めてある。会話・設定は残る）。起こすのは wake()。center 再起動でも眠ったまま。 */
  sleeping?: boolean;
}

export interface SessionInfo {
  name: string;
  path: string;
  state: RcStatus["state"];
  /** スリープ中か（claude の process は止まっていて state は stopped。会話は残り、開く・messenger の宛先になる・wake で元の会話のまま起き直す）。 */
  sleeping: boolean;
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
  start: z.boolean().optional().describe("false = 作って保存するだけで起動しない。省略時は起動する"),
  settings: projectSettingsPatchSchema.optional().describe("プロジェクトごとの設定（{ instructions?: string, addDirs?: string[], outputStyle?: string, servers?: string[], … }）。instructions は --append-system-prompt、addDirs（絶対パス）は 1 つずつ --add-dir で渡す、outputStyle（claude の output style の markdown 本文）は session のフォルダの .claude/output-styles/bantou.md に書いて --settings で選ぶ（再起動・--continue でも付く）。servers（host 名か server_id）はこの session が使う server の範囲（未設定 = 全部、空配列 = 使わない）。mcpServers（追加の MCP の server。Claude Code の mcp.json の mcpServers と同じ形）と memory（外部記憶の MCP の server）は center を起動した所からだけ書ける（他からは error）"),
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
  /** その session の外部記憶（session の値、無ければ共通の値。普通の MCP の設定の形）。無ければ undefined。 */
  memoryOf(name: string): McpServerDef | undefined;
  /** center 共通の設定を項目ごとにマージして保存し、全 session の次の起動に反映する。更新後の全体を返す。servers（null 以外）は error。 */
  updateCenterSettings(patch: CenterSettingsPatch): Promise<{ settings: ProjectSettings }>;
  /**
   * session の名前（newName）と path を変える（session_create で作ったものだけ）。停止 → フォルダの移動 / 作成 → 記録の更新 → 新しい名前で起動し直す（resume）。
   * path を変えた時は --continue が「会話が無い」で落ち、素の起動へ fallback する。cap_id は変えない。失敗時は記録と名前を元に戻して起動し直す（best effort）。
   */
  update(input: SessionUpdateInput): Promise<SessionInfo>;
  delete(name: string): Promise<{ name: string; deleted: true }>;
  /**
   * session をスリープさせる（claude の process を止める。会話・設定・remote の記録は残す）。session_create で作った session のみ。眠っている session には何もしない。
   * 起こすのは wake()（--continue で元の会話に復帰）。center の再起動後も眠ったまま。
   */
  sleep(name: string): Promise<SessionInfo>;
  /** スリープ中の session を元の会話のまま起こす（resume）。眠っていなければ何もしない（今の状態を返す）。 */
  wake(name: string): Promise<SessionInfo>;
  /**
   * リセッションの再起動: claude を止め、`--continue` 無し（新しい会話）で起動し直す。session_create で作った session のみ。眠っている session は不可。
   * 止めてから新しい claude が接続するまでの間は、スリープと同じ messenger の身代わりを置く（取りこぼしを防ぐ。設計 U6 の A）。
   * 起動に失敗したら投げる（身代わりは外す。元の会話は残っているので、次の起動（restore・wake）は `--continue` で元の会話に戻る）。
   */
  restartFresh(name: string): Promise<SessionInfo>;
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
  /**
   * 旧設定の外部記憶の file（memory-settings.json。0.1.56 までの CLI が書いた物）。あれば起動時に普通の設定（memory）へ移し、移せたら retire() で退ける。
   * 省略時は移行しない。
   */
  memoryFile?: MemoryFile & { exists(): boolean; retire(): void };
  /**
   * 旧設定 mcp-connections.json（M1 の CLI が書いていた接続の file）。あれば起動時に普通の設定（mcpServers）へ移し、移せたら retire() で退ける。
   * 省略時は mcp-connections.json の移行をしない。
   */
  legacyConnections?: { load(): { data: ConnectionsData; exists: boolean; problem?: string }; retire(): void };
  /**
   * 追加の MCP の server（mcpServers）と外部記憶（memory）を設定 file から今の値で読む元（mcp-source.ts）。mcpConnections() / memoryOf() はこれを呼ぶたびに読む
   * （運用者が file を直接書き換えた内容が、再起動なしで次の判定・起動から効く）。保存の前にも、この値を設定の記録へ写す（center の保存が運用者の書き換えを巻き戻さない）。
   * 省略時はメモリ上の値。
   */
  mcpSource?: () => McpSource | undefined;
  /** 旧設定の接続（builtin・auth.env）を普通の書き方へ移す時の材料（mcp-legacy.ts）。省略時は旧設定の接続を移さない。 */
  legacyMcp?: LegacyCtx;
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
  /** スリープ状態が変わった時（sleeping = 今眠っているか。restore で眠ったままの session にも呼ぶ）。messenger の身代わり peer の登録・解除に使う。失敗しても本体は成功にする。 */
  onSleepChange?: (name: string, sleeping: boolean) => void;
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

  /** memory-settings.json を退けなかった（移し切れなかった）起動の間だけ使う旧い値（file は残し、次の起動で移し直す）。設定の値が優先。 */
  let memoryFallback: { common?: MemorySetting; sessions: Record<string, MemorySetting> } | undefined;
  /** config の projects 由来の session の名前（sessions.json に記録が無い。外部記憶は center 共通の設定の projectMemory に持つ）。 */
  const configProjects = new Set(config.projects.map((p) => p.name));
  /** 割り当てへ移せなかった旧設定の coordinator（元の値のまま）。次の起動で移し直せるよう、保存のたびに書き戻す。 */
  let pendingCoordinator: unknown;
  const withLegacyCommon = (s: ProjectSettings): ProjectSettings => (pendingCoordinator !== undefined ? { ...s, coordinator: pendingCoordinator } : s);

  /** 改名の保存の間だけ持つ「記録の名前 → disk 上の名前」。adoptMcpFromDisk が disk の mcpServers を引くのに使う。 */
  const diskAlias = new Map<string, string>();

  /**
   * 設定 file の mcpServers と memory（運用者が直接書いた物を含む）を記録へ写す。保存が運用者の書き換えを巻き戻さないように、保存・読みの前に呼ぶ。
   * 読めなければ何もしない。
   */
  const adoptMcpFromDisk = (): void => {
    const src = opts.mcpSource?.();
    if (!src) return;
    const put = (st: Record<string, unknown>, key: string, v: unknown): void => {
      if (v === undefined) delete st[key];
      else st[key] = v;
    };
    for (const rec of saved.values()) {
      // 改名の保存中は disk がまだ旧い名前（巻き戻しの保存中は新しい名前）なので、diskAlias の名前でも引く（引けないと割り当てが消える）
      const alias = diskAlias.get(rec.name);
      const pick = (m: Map<string, unknown>): unknown => (m.has(rec.name) ? m.get(rec.name) : alias !== undefined ? m.get(alias) : undefined);
      const st: Record<string, unknown> = { ...(rec.settings ?? {}) };
      put(st, "mcpServers", pick(src.sessions));
      put(st, "memory", pick(src.sessionMemory));
      if (Object.keys(st).length) rec.settings = st as ProjectSettings;
      else delete rec.settings;
    }
    put(common, "mcpServers", src.common);
    put(common, "memory", src.memory);
    put(common, "projectMemory", src.projectMemory);
  };

  /** 記録を保存する。adopt = 先に設定 file の mcpServers / memory を写す（更新の保存では、更新の前に写してから false で呼ぶ）。 */
  const persist = (adopt = true): Promise<void> => {
    if (adopt) adoptMcpFromDisk();
    return store.save([...saved.values()]);
  };

  /** 設定の更新の memory・mcpServers の検査（誤りなら投げる。値は出さない）。 */
  const checkSettings = (patch: object | undefined, scope: "common" | "session"): void => {
    assertCenterOnly(patch, { launcher: true });
    const issues = settingsIssues(patch, scope, serverEntryIssues);
    if (issues.length) throw new Error(`設定が不正: ${issues.join(" / ")}`);
  };

  const info = (s: RcStatus): SessionInfo => ({
    name: s.project,
    path: s.path,
    state: s.state,
    sleeping: s.state === "stopped" && saved.get(s.project)?.sleeping === true,
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

  /**
   * 旧設定の外部記憶を普通の設定（center 共通の設定 / session の設定の memory）へ移す。冪等。値は log に出さない。
   * - 設定の memory の旧形式 `{ url, token?, agentId? }` は普通の MCP の設定の形 `{ type: "http", url, headers }` に書き換える。
   * - memory-settings.json（0.1.56 までの CLI が書いた物）は、設定に memory が無い範囲へ移し（設定にある物が勝つ）、保存できたら .migrated に退ける。
   *   config の projects 由来の session（sessions.json に記録が無い）の値は center 共通の設定の `projectMemory` へ移す。
   *   どちらでもない session の値は移さず、file にはその session の分だけを残す（値を失わない。移せた分は file から除くので、
   *   画面などで消した値が次の起動で戻らない）。名前を log に出し、その session にだけ file の値を使う。全部移せたら .migrated に退ける。
   * 保存できなければ file を残し、この起動の間は file の値も使う（次の起動で移し直す）。rawCommon（書き換えた後）と、session の設定を変えたかを返す。
   */
  const migrateLegacyMemory = async (rawCommon: unknown, list: SavedSession[]): Promise<{ raw: unknown; changed: boolean }> => {
    const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
    const isOld = (m: unknown): boolean => isRec(m) && m.type === undefined && m.command === undefined && typeof m.url === "string";
    let raw: unknown = rawCommon;
    let commonChanged = false;
    let sessionsChanged = false;
    if (isRec(raw) && isOld(raw.memory)) {
      raw = { ...raw, memory: memoryDefOf(raw.memory) };
      commonChanged = true;
    }
    for (const s of list) {
      if (isRec(s.settings) && isOld(s.settings.memory)) {
        s.settings = { ...s.settings, memory: memoryDefOf(s.settings.memory) };
        sessionsChanged = true;
      }
    }
    const f = opts.memoryFile;
    const fromFile = f?.exists() ? f.read() : undefined;
    const orphans: string[] = [];
    if (fromFile) {
      if (fromFile.common && !(isRec(raw) && raw.memory !== undefined)) {
        raw = { ...(isRec(raw) ? raw : {}), memory: memoryDefOf(fromFile.common) };
        commonChanged = true;
      }
      for (const [name, m] of Object.entries(fromFile.sessions)) {
        const rec = list.find((r) => r.name === name);
        if (!rec) {
          if (!configProjects.has(name)) {
            orphans.push(name);
            continue;
          }
          // config の projects 由来: 共通の設定の projectMemory へ（そこにあれば設定が勝つ）
          const base: Record<string, unknown> = isRec(raw) ? raw : {};
          const pm: Record<string, unknown> = isRec(base.projectMemory) ? { ...base.projectMemory } : {};
          if (Object.hasOwn(pm, name)) continue;
          pm[name] = memoryDefOf(m);
          raw = { ...base, projectMemory: pm };
          commonChanged = true;
          continue;
        }
        if (isRec(rec.settings) && rec.settings.memory !== undefined) continue;
        rec.settings = { ...(rec.settings ?? {}), memory: memoryDefOf(m) } as ProjectSettings;
        sessionsChanged = true;
      }
    }
    let ok = true;
    if (sessionsChanged) {
      try {
        await store.save(list);
      } catch (e) {
        ok = false;
        log(`移行失敗: 外部記憶の設定を session の設定へ保存できない（次の起動でやり直す）: ${(e as Error).message}`);
      }
    }
    if (commonChanged && opts.centerStore) {
      try {
        await opts.centerStore.save(raw as ProjectSettings);
      } catch (e) {
        ok = false;
        log(`移行失敗: 外部記憶の設定を center 共通の設定へ保存できない（次の起動でやり直す）: ${(e as Error).message}`);
      }
    }
    if (fromFile && f) {
      /** 移す先の無い session の分（file に残す・その session にだけ使う）。 */
      const rest: MemoryFileData = { sessions: Object.fromEntries(orphans.map((n) => [n, fromFile.sessions[n]])) };
      /** 移せた分を file から除く（残りだけを書く）。書けなければ false。 */
      const shrink = (): boolean => {
        try {
          f.write(rest);
          return true;
        } catch (e) {
          log(`移行失敗: memory-settings.json から移せた分を除けない（次の起動で設定に無い範囲へまた移す）: ${(e as Error).message}`);
          return false;
        }
      };
      if (!ok) {
        // 設定へ保存できなかった: file はそのまま残し、この起動の間は file の値も使う（設定の値が優先。次の起動で移し直す）
        memoryFallback = fromFile;
      } else if (orphans.length === 0) {
        try {
          f.retire();
          log(`memory-settings.json の外部記憶の設定を普通の設定（memory）へ移した（共通 ${fromFile.common ? 1 : 0} 件、session ${Object.keys(fromFile.sessions).length} 件。値は出さない。file は .migrated に退けた）`);
        } catch (e) {
          log(`移行失敗: memory-settings.json を退けられない: ${(e as Error).message}`);
          shrink();
        }
      } else {
        log(`移行失敗: 外部記憶の設定の移す先が無い session（session_create で作った物にも config の projects にも無い）。memory-settings.json にはその分だけを残す: ${orphans.join(",")}`);
        shrink();
        memoryFallback = rest;
      }
    } else if (commonChanged || sessionsChanged) log("外部記憶の設定の旧形式（url・token・agentId）を普通の MCP の設定の形へ書き換えた（値は出さない）");
    return { raw, changed: sessionsChanged && ok };
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
    const legacyCtx = opts.legacyMcp;
    const entriesOf = (st: unknown): [string, unknown][] => (isRec(st) && isRec(st.mcpServers) ? Object.entries(st.mcpServers) : []);
    const hasLegacyEntries =
      legacyCtx !== undefined && (entriesOf(rawCommon).some(([, v]) => isLegacyEntry(v)) || list.some((r) => entriesOf(r.settings).some(([, v]) => isLegacyEntry(v))));
    if (!hasCoord && fileData === undefined && !hasLegacyEntries) return rawCommon;
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
    /** 旧設定の 1 項目を普通の書き方へ。移せない物は元のまま返し、名前と理由だけを log に出す（値は出さない）。 */
    const conv = (where: string, name: string, v: unknown, session?: string): unknown => {
      if (!legacyCtx || !isLegacyEntry(v)) return v;
      const r = migrateEntry(v, legacyCtx, session !== undefined ? { session } : {});
      if (r.kind === "moved") {
        if (r.dropped.length) log(`移行: 旧設定の接続の一部の項目は普通の書き方に無いので移さなかった（名前だけ）: ${where}/${name}: ${r.dropped.join(", ")}`);
        return r.value;
      }
      if (r.kind === "fail") log(`移行失敗: 旧設定の接続を普通の書き方へ移せない（そのまま残す）: ${where}/${name}: ${r.reason}`);
      return v;
    };
    // 設定に既に在る旧設定の接続（builtin・auth.env）を普通の書き方へ
    if (legacyCtx) {
      const convMap = (st: Record<string, unknown>, where: string, session?: string): boolean => {
        let changed = false;
        const next: Record<string, unknown> = {};
        for (const [n, v] of entriesOf(st)) {
          const nv = conv(where, n, v, session);
          if (nv !== v) changed = true;
          Object.defineProperty(next, n, { value: nv, enumerable: true, writable: true, configurable: true });
        }
        if (changed) st.mcpServers = next;
        return changed;
      };
      if (convMap(raw, "共通")) {
        commonChanged = true;
        log("設定の旧設定の接続を普通の書き方へ移した（center 共通）");
      }
      for (const rec of list) {
        const st: Record<string, unknown> = { ...(rec.settings ?? {}) };
        if (convMap(st, rec.name, rec.name)) {
          rec.settings = st as ProjectSettings;
          sessionsChanged = true;
          touched.add(rec.name);
        }
      }
    }
    let coordinatorRaw: unknown;
    if (hasCoord) {
      coordinatorRaw = raw.coordinator;
      const legacy = readCoordinator(coordinatorRaw);
      const entry = legacyCtx?.coordinatorEntry() ?? null;
      if (legacy === null) {
        log("旧設定の統括の指定（center-settings.json の coordinator）が壊れているので捨てた");
        delete raw.coordinator;
        commonChanged = true;
        coordinatorRaw = undefined;
      } else if (entry === null) {
        ok = false;
        log(`移行失敗: 旧設定の統括の指定を移せない（統括の MCP の server の設定 coordinator-mcp.json が無い）。center-settings.json の coordinator は残す: session=${legacy}`);
      } else if (addSession(legacy, "bantou-coordinator", entry)) {
        delete raw.coordinator;
        commonChanged = true;
        log(`旧設定の統括の指定を session の設定（mcpServers の bantou-coordinator。type: http の 1 項目）へ移した: session=${legacy}`);
      } else {
        ok = false;
        log(`移行失敗: 旧設定の統括の指定の session が session_create で作った物の中に無い（${legacy}）。center-settings.json の coordinator は残す。その session の設定の mcpServers に統括の MCP の server の 1 項目を書く（README）`);
      }
    }
    if (fileData !== undefined) {
      for (const [name, c] of Object.entries(fileData.common)) if (addTo(raw, name, conv("mcp-connections.json 共通", name, c))) commonChanged = true;
      for (const [session, per] of Object.entries(fileData.sessions)) {
        for (const [name, ov] of Object.entries(per)) {
          if (!addSession(session, name, conv(`mcp-connections.json ${session}`, name, ov, session))) {
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

  const notifySleep = (name: string, sleeping: boolean): void => {
    try {
      opts.onSleepChange?.(name, sleeping);
    } catch (e) {
      log(`スリープ状態の通知に失敗: ${name} ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const savedOrThrow = (name: string): SavedSession => {
    const rec = saved.get(name);
    if (rec) return rec;
    const known = supervisor.list().some((s) => s.project === name);
    throw new Error(known ? `session_create で作ったものではない（config 由来）: ${name}` : `未定義の session: ${name}`);
  };

  return {
    async restore() {
      let rawCommon: unknown = opts.centerStore ? await opts.centerStore.load() : undefined;
      const list = await store.load();
      rawCommon = await migrateLegacyMcp(rawCommon, list);
      const mem = await migrateLegacyMemory(rawCommon, list);
      rawCommon = mem.raw;
      const migrated = mem.changed;
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
          if (s.sleeping === true) {
            // 眠っていた session は起こさない（messenger の宛先になるか、開かれたら起きる）
            notifySleep(s.name, true);
            log(`session スリープのまま復帰: ${s.name} (${s.path})`);
            continue;
          }
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
        checkSettings(input.settings, "session");
        await mkdir(path, { recursive: true });
        const settings = input.settings ? mergeSettings(undefined, input.settings) : undefined;
        const rec: SavedSession = {
          name,
          path,
          permissionMode: input.permissionMode ?? "auto",
          ...(settings && Object.keys(settings).length ? { settings } : {}),
          createdAt: new Date().toISOString(),
        };
        supervisor.add(toProject(rec), { wrapper: true, ...instrOpt(rec.settings) });
        // 設定 file の値を記録へ写してから足す（新しい記録の mcpServers / memory は disk に無いので、写した後に入れる）
        adoptMcpFromDisk();
        saved.set(name, rec);
        try {
          await persist(false);
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
      adoptMcpFromDisk();
      return { name, settings: readSettings(saved.get(name)?.settings) };
    },

    updateSettings: (name, patch) =>
      serial(async () => {
        checkSettings(patch, "session");
        const rec = saved.get(name);
        if (!rec) {
          const known = supervisor.list().some((p) => p.project === name);
          throw new Error(known ? `session_create で作ったものではない（config 由来）: ${name}` : `未定義の session: ${name}`);
        }
        // 設定 file の今の値（運用者の直接の書き換えを含む）に重ねる。保存では写し直さない（写すと今の更新が file の古い値で巻き戻る）
        adoptMcpFromDisk();
        const prev = rec.settings;
        const next = mergeSettings(readSettings(prev), patch);
        if (Object.keys(next).length) rec.settings = next;
        else delete rec.settings;
        try {
          await persist(false);
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

    getCenterSettings: () => {
      adoptMcpFromDisk();
      return { settings: readCenterSettings(common) };
    },

    serversOf: (name) => composeServers(saved.get(name)?.settings),

    memoryOf: (name) => {
      // 設定 file の今の値（file を読めなければメモリ上の値）。順に session の値（sessions.json の記録の settings.memory、
      // 記録の無い config の projects 由来の session は共通の設定の projectMemory）、移し切れていない旧 file の session の値、共通の値
      const src = opts.mcpSource?.();
      const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
      const own = src ? src.sessionMemory.get(name) : saved.get(name)?.settings?.memory;
      const pm = src ? src.projectMemory : common.projectMemory;
      const proj = !saved.has(name) && isRec(pm) && Object.hasOwn(pm, name) ? pm[name] : undefined;
      const com = src ? src.memory : common.memory;
      return validMemoryDef(own ?? proj ?? memoryFallback?.sessions[name] ?? com ?? memoryFallback?.common);
    },

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
        checkSettings(patch, "common");
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
        // 名前・path の変更は止めて起動し直す操作なので、眠っていた session も起きる
        const wasSleeping = rec.sleeping === true;
        const newRec: SavedSession = { ...rec, name: newName, path: newPath };
        delete newRec.sleeping;
        const doMove = moving && input.move === true;
        let renamedRemotes = false;
        let moved = false;
        let swapped = false;
        let added = false;
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
          if (renaming && opts.renameRemoteSession) {
            // 呼び出し中に例外（persist 失敗など）でも remotes のメモリは付け替わりうるので、先に印を立てて戻す
            renamedRemotes = true;
            await opts.renameRemoteSession(name, newName);
          }
          supervisor.add(toProject(newRec), { wrapper: true, ...instrOpt(newRec.settings) });
          added = true;
          if (wasSleeping) notifySleep(name, false);
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
            if (oldRec.sleeping === true) notifySleep(name, true);
            else await supervisor.start(name, { resume: true });
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
        const wasSleeping = saved.get(name)?.sleeping === true;
        saved.delete(name);
        await persist();
        if (wasSleeping) notifySleep(name, false);
        opts.events?.publish({ reason: "deleted", name });
        log(`session 削除: ${name}`);
        return { name, deleted: true as const };
      }),

    sleep: (name) =>
      serial(async () => {
        const rec = savedOrThrow(name);
        if (rec.sleeping === true && supervisor.status(name).state === "stopped") return info(supervisor.status(name));
        // 先にフラグを保存する（止めている途中で center が落ちても、次の起動で眠ったまま復帰する）
        rec.sleeping = true;
        try {
          await persist();
        } catch (e) {
          delete rec.sleeping;
          throw new Error(`状態ファイルに保存できない: ${(e as Error).message}`);
        }
        let st: RcStatus;
        try {
          st = await supervisor.stop(name);
        } catch (e) {
          // 止められなかった（claude が残っているかもしれない）。眠った事にしない: フラグを戻し、身代わりは立てない（フラグと身代わりを食い違わせない）
          delete rec.sleeping;
          await persist().catch((pe) => log(`スリープの取り消しを保存できない: ${name} ${(pe as Error).message}`));
          log(`session スリープ失敗（停止できない）: ${name} ${(e as Error).message}`);
          throw e;
        }
        notifySleep(name, true);
        opts.events?.publish({ reason: "sleep", name });
        log(`session スリープ: ${name}`);
        return info(st);
      }),

    wake: (name) =>
      serial(async () => {
        const rec = savedOrThrow(name);
        if (rec.sleeping !== true) return info(supervisor.status(name));
        delete rec.sleeping;
        try {
          await persist();
        } catch (e) {
          rec.sleeping = true;
          throw new Error(`状態ファイルに保存できない: ${(e as Error).message}`);
        }
        // 身代わりを先に外す（外さないと、起きた claude の peer と同名が並ぶ）
        notifySleep(name, false);
        let st: RcStatus;
        try {
          st = await supervisor.start(name, { resume: true });
        } catch (e) {
          // 起こせなかった。眠ったままに戻す（フラグと身代わりを元に戻す。身代わりが預かった message を引き継げるように）
          rec.sleeping = true;
          await persist().catch((pe) => log(`起床の取り消しを保存できない: ${name} ${(pe as Error).message}`));
          notifySleep(name, true);
          opts.events?.publish({ reason: "sleep", name });
          log(`session 起床失敗（眠ったままに戻した）: ${name} ${(e as Error).message}`);
          throw e;
        }
        opts.events?.publish({ reason: "sleep", name });
        log(`session 起床: ${name}`);
        return info(await settle(name, st));
      }),

    restartFresh: (name) =>
      serial(async () => {
        const rec = savedOrThrow(name);
        if (rec.sleeping === true) throw new Error(`眠っている session は再起動しない: ${name}`);
        await supervisor.stop(name);
        // 止めてから新しい claude の接続までの間の message を身代わりが預かる
        notifySleep(name, true);
        try {
          const st = await supervisor.start(name);
          opts.events?.publish({ reason: "restarted", name });
          log(`session リセッション再起動（新しい会話）: ${name}`);
          return info(await settle(name, st));
        } finally {
          notifySleep(name, false);
        }
      }),

    list: () => supervisor.list().map(info),
  };
}
