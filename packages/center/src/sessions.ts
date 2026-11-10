import { mkdir, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { projectSchema, PERMISSION_MODES, type Config, type ProjectConfig } from "./config.js";
import { composeAddDirs, composeInstructions, composeMemory, composeOutputStyle, composeServers, redactSettings, mergeSettings, projectSettingsPatchSchema, readSettings, type MemorySetting, type ProjectSettings, type ProjectSettingsPatch } from "./project-settings.js";
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
  settings: projectSettingsPatchSchema.optional().describe("プロジェクトごとの設定（{ instructions?: string, addDirs?: string[], outputStyle?: string, servers?: string[], … }）。instructions は --append-system-prompt、addDirs（絶対パス）は 1 つずつ --add-dir で渡す、outputStyle（claude の output style の markdown 本文）は session のフォルダの .claude/output-styles/bantou.md に書いて --settings で選ぶ（再起動・--continue でも付く）。servers（host 名か server_id）はこの session が使う server の範囲（未設定 = 全部、空配列 = 使わない）。memory（{ url, token?, agentId? }）は外部記憶の MCP endpoint（url は http/https の絶対 URL、token は Bearer、agentId は X-Agent-Id で省略時は session 名）。省略・空は無し"),
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
  create(input: { name: string; path?: string; permissionMode?: ProjectConfig["permissionMode"]; settings?: ProjectSettingsPatch }): Promise<SessionInfo>;
  /** session の settings を返す（未設定・config 由来の project は `{}`。未定義の name は例外）。 */
  getSettings(name: string): { name: string; settings: ProjectSettings };
  /**
   * settings を項目ごとにマージして保存し、更新後の全体を返す（null = 項目を削除、未知の項目は保持）。
   * session_create で作った session のみ。動いている session には効かず、次の起動から効く。
   */
  updateSettings(name: string, patch: ProjectSettingsPatch): Promise<{ name: string; settings: ProjectSettings }>;
  /** center 共通の設定（全 session に効く。instructions は各 session の追加指示の前に付く）。未設定は `{}`。 */
  getCenterSettings(): { settings: ProjectSettings };
  /** session が使ってよい server の指定（session の servers、無ければ center 共通の servers）。undefined = 全部。 */
  serversOf(name: string): string[] | undefined;
  /** center 共通の設定を項目ごとにマージして保存し、全 session の次の起動に反映する。更新後の全体を返す。 */
  updateCenterSettings(patch: ProjectSettingsPatch): Promise<{ settings: ProjectSettings }>;
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

  const persist = (): Promise<void> => store.save([...saved.values()]);

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
  const instrOpt = (s: ProjectSettings | undefined): { instructions?: string; addDirs?: string[]; outputStyle?: string; memory?: MemorySetting } => {
    const i = composeInstructions(common, s);
    const m = composeMemory(common, s);
    const d = composeAddDirs(common, s);
    const o = composeOutputStyle(common, s);
    return { ...(i ? { instructions: i } : {}), ...(d.length ? { addDirs: d } : {}), ...(o ? { outputStyle: o } : {}), ...(m ? { memory: m } : {}) };
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

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  return {
    async restore() {
      if (opts.centerStore) {
        common = readSettings(await opts.centerStore.load());
        if (Object.keys(common).length) log(`center 共通の設定を読んだ (項目: ${Object.keys(common).join(",")})`);
      }
      for (const s of await store.load()) {
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
        const st = await supervisor.start(name);
        log(`session 作成: ${name} (${path})`);
        return info(await settle(name, st));
      }),

    getSettings: (name) => {
      const known = supervisor.list().some((p) => p.project === name);
      if (!known) throw new Error(`未定義の session: ${name}`);
      return { name, settings: redactSettings(readSettings(saved.get(name)?.settings)) };
    },

    updateSettings: (name, patch) =>
      serial(async () => {
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
        supervisor.setMemory(name, composeMemory(common, next));
        log(`session の設定を更新: ${name} (項目: ${Object.keys(next).join(",") || "なし"})`);
        return { name, settings: redactSettings(next) };
      }),

    getCenterSettings: () => ({ settings: redactSettings({ ...common }) }),

    serversOf: (name) => composeServers(common, saved.get(name)?.settings),

    updateCenterSettings: (patch) =>
      serial(async () => {
        const prev = common;
        const next = mergeSettings(prev, patch);
        if (opts.centerStore) {
          try {
            await opts.centerStore.save(next);
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
          supervisor.setMemory(rec.name, composeMemory(common, rec.settings));
        }
        log(`center 共通の設定を更新 (項目: ${Object.keys(next).join(",") || "なし"})`);
        return { settings: redactSettings(next) };
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
            await persist();
          } catch (e) {
            throw new Error(`状態ファイルに保存できない: ${(e as Error).message}`);
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
          if (added) await undo("新しい名前の停止", () => supervisor.remove(newName));
          if (renamedRemotes) await undo("remotes の付け替え", () => opts.renameRemoteSession?.(newName, name));
          if (swapped) {
            replaceSaved(newName, oldRec);
            await undo("状態ファイルの復元", persist);
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
        opts.events?.publish({ reason: "deleted", name });
        log(`session 削除: ${name}`);
        return { name, deleted: true as const };
      }),

    list: () => supervisor.list().map(info),
  };
}
