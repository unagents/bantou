import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { projectSchema, PERMISSION_MODES, type Config, type ProjectConfig } from "./config.js";
import { mergeSettings, projectSettingsPatchSchema, readSettings, type ProjectSettings, type ProjectSettingsPatch } from "./project-settings.js";
import type { Logger } from "./log.js";
import type { RcStatus, RemoteControlSupervisor } from "./remote-control.js";
import type { EventHub } from "./events.js";
import type { JsonListStore } from "./store.js";
import type { ContextUsage } from "./context-usage.js";

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
  /** 起動時に追加指示（instructions）を付けたか。本文は出さない。 */
  instructions: boolean;
}

export const sessionCreateSchema = {
  name: z.string().regex(SESSION_NAME, "英数字と _ - のみ"),
  path: z.string().min(1).optional().describe("絶対パス。省略時は <workspace>/<name>（無ければ作る）"),
  permissionMode: z.enum(PERMISSION_MODES).optional().describe("省略時 auto"),
  settings: projectSettingsPatchSchema.optional().describe("プロジェクトごとの設定（{ instructions?: string, … }）。instructions は --append-system-prompt で渡す（再起動・--continue でも付く）。省略・空文字は無し"),
};

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
  log: Logger;
  /** create 後、接続（URL 取得）か失敗を待つ上限。0 で待たない。既定 15 秒。 */
  waitMs?: number;
  /** session の増減を通知する先（GET /events）。省略時は通知しない。 */
  events?: EventHub;
  /** session ごとのコンテキスト使用状況の取得元。省略時は常に null。 */
  contextUsage?: (name: string) => ContextUsage | null;
}): SessionManager {
  const { config, supervisor, store, log } = opts;
  const waitMs = opts.waitMs ?? 15_000;
  const saved = new Map<string, SavedSession>();
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
    instructions: s.instructions,
  });

  const toProject = (s: SavedSession): ProjectConfig =>
    projectSchema.parse({ name: s.name, path: s.path, permissionMode: s.permissionMode });

  /** settings から supervisor に渡す instructions（あれば）。 */
  const instrOpt = (s: ProjectSettings | undefined): { instructions?: string } => {
    const i = readSettings(s).instructions;
    return typeof i === "string" ? { instructions: i } : {};
  };

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  return {
    async restore() {
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
        let st = await supervisor.start(name);
        log(`session 作成: ${name} (${path})`);
        // 接続（URL 取得）か失敗までを少し待つ。待ちきれなければ starting のまま返す
        const deadline = Date.now() + waitMs;
        // 一度でも終了したら（trust 未承認などの即死）待たずに、原因（lastError）付きで返す
        while (Date.now() < deadline && (st.state === "starting" || st.state === "connected") && !st.sessionUrl && !st.lastExit) {
          await sleep(200);
          st = supervisor.status(name);
        }
        return info(st);
      }),

    getSettings: (name) => {
      const known = supervisor.list().some((p) => p.project === name);
      if (!known) throw new Error(`未定義の session: ${name}`);
      return { name, settings: readSettings(saved.get(name)?.settings) };
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
        supervisor.setInstructions(name, typeof next.instructions === "string" ? next.instructions : "");
        log(`session の設定を更新: ${name} (項目: ${Object.keys(next).join(",") || "なし"})`);
        return { name, settings: next };
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
