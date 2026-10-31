import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { projectSchema, PERMISSION_MODES, type Config, type ProjectConfig } from "./config.js";
import type { Logger } from "./log.js";
import type { RcStatus, RemoteControlSupervisor } from "./remote-control.js";
import type { JsonListStore } from "./store.js";

export const SESSION_NAME = /^[A-Za-z0-9_-]+$/;

/** center が自前で保存する session（config の projects には書かない）。 */
export interface SavedSession {
  name: string;
  path: string;
  permissionMode: ProjectConfig["permissionMode"];
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
}

export const sessionCreateSchema = {
  name: z.string().regex(SESSION_NAME, "英数字と _ - のみ"),
  path: z.string().min(1).optional().describe("絶対パス。省略時は <workspace>/<name>（無ければ作る）"),
  permissionMode: z.enum(PERMISSION_MODES).optional().describe("省略時 auto"),
};

export interface SessionManager {
  /** 保存済みの session を supervisor に載せて --continue で復帰させる（失敗時は素の起動へ fallback）。 */
  restore(): Promise<void>;
  create(input: { name: string; path?: string; permissionMode?: ProjectConfig["permissionMode"] }): Promise<SessionInfo>;
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
  });

  const toProject = (s: SavedSession): ProjectConfig =>
    projectSchema.parse({ name: s.name, path: s.path, permissionMode: s.permissionMode });

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  return {
    async restore() {
      for (const s of await store.load()) {
        try {
          if (!SESSION_NAME.test(s.name) || !isAbsolute(s.path)) throw new Error("保存内容が不正");
          supervisor.add(toProject(s), { wrapper: true });
          saved.set(s.name, s);
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
        const rec: SavedSession = {
          name,
          path,
          permissionMode: input.permissionMode ?? "auto",
          createdAt: new Date().toISOString(),
        };
        supervisor.add(toProject(rec), { wrapper: true });
        saved.set(name, rec);
        try {
          await persist();
        } catch (e) {
          saved.delete(name);
          await supervisor.remove(name);
          throw new Error(`状態ファイルに保存できない: ${(e as Error).message}`);
        }
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

    delete: (name) =>
      serial(async () => {
        if (!saved.has(name)) {
          const known = supervisor.list().some((s) => s.project === name);
          throw new Error(known ? `session_create で作ったものではない（config 由来）: ${name}` : `未定義の session: ${name}`);
        }
        await supervisor.remove(name);
        saved.delete(name);
        await persist();
        log(`session 削除: ${name}`);
        return { name, deleted: true as const };
      }),

    list: () => supervisor.list().map(info),
  };
}
