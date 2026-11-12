// Command handlers: the desktop's Rust commands that reach the center, by the same names and the same args / results.
// `session.rs` (arg builders, `normalize_settings`, `settings_of`, `workspace_of`), `center.rs` (settings commands),
// `center_mcp.rs` (`center_call`, `center_connection`). Args are what the UI sends through `invoke` (camelCase keys).
// Design 4 / 5.1 / 5.5. No Nuxt / Nitro / Tauri import. The set of keys of the table is the allow-list of commands.

import type { Session, SessionList, SessionPathHints } from "../../ui/types/index.ts";
import type { CenterSettingsHandle } from "./center-settings.ts";
import { CenterMcpError, ToolNotAllowedError, type CenterMcp } from "./mcp.ts";
import type { SessionService } from "./sessions.ts";
import { parseSession } from "./sessions.ts";
import { CenterSettingsError } from "./settings.ts";

/** A failure with the HTTP status a route answers with. The message is safe to send to the browser. */
export class CommandError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CommandError";
    this.status = status;
  }
}

export type CommandHandler = (args: Record<string, unknown>) => Promise<unknown>;
export type CommandTable = Readonly<Record<string, CommandHandler>>;

/** Max length (chars) of a project setting `instructions` (session.rs `SESSION_INSTRUCTIONS_MAX`). */
export const SESSION_INSTRUCTIONS_MAX = 16_000;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const bad = (message: string): never => {
  throw new CommandError(400, message);
};

/** A required string arg (the Rust command takes `String`; a missing or non-string value is refused). */
function reqStr(a: Record<string, unknown>, k: string): string {
  const v = a[k];
  return typeof v === "string" ? v : bad(`${k} は文字列で渡す`);
}

/** `Option<String>`: absent or null is undefined, a non-string is refused. */
function optStr(a: Record<string, unknown>, k: string): string | undefined {
  const v = a[k];
  if (v === undefined || v === null) return undefined;
  return typeof v === "string" ? v : bad(`${k} は文字列で渡す`);
}

/** `trim` and drop a blank value (`.map(str::trim).filter(non-empty)`). */
const nonBlank = (v: string | undefined) => (v === undefined || v.trim() === "" ? undefined : v.trim());

/**
 * Check a project settings object (session.rs `normalize_settings`): a blank `instructions` becomes `null` (the
 * center removes the item), over the limit is an error, other keys pass through unchanged.
 */
export function normalizeSettings(settings: unknown): Record<string, unknown> {
  if (!isObj(settings)) return bad("設定はオブジェクトで渡す");
  const out = { ...settings };
  const t = out.instructions;
  if (t === undefined || t === null) return out;
  if (typeof t !== "string") return bad("追加指示は文字列で渡す");
  if (t.trim() === "") out.instructions = null;
  else if ([...t].length > SESSION_INSTRUCTIONS_MAX) return bad(`追加指示は ${SESSION_INSTRUCTIONS_MAX} 文字以内`);
  return out;
}

/** Body of the center's `session_create` (session.rs `create_args`): `path` only when not blank, `settings` only with a non-null item. */
export function createArgs(name: string, path: string | undefined, settings: Record<string, unknown> | undefined) {
  const a: Record<string, unknown> = { name };
  const p = nonBlank(path);
  if (p !== undefined) a.path = p;
  if (settings) {
    const m = Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== null));
    if (Object.keys(m).length > 0) a.settings = m;
  }
  return a;
}

/** Body of the center's `session_settings_update` (session.rs `update_args`). */
export const updateArgs = (name: string, settings: Record<string, unknown>) => ({ name, settings });

/** Body of the center's `session_update` (session.rs `rename_args`): only what is given; `move` goes with `path` only. */
export function renameArgs(name: string, newName?: string, path?: string, moveDir?: boolean) {
  const a: Record<string, unknown> = { name };
  const n = nonBlank(newName);
  if (n !== undefined) a.newName = n;
  const p = nonBlank(path);
  if (p !== undefined) {
    a.path = p;
    if (moveDir !== undefined) a.move = moveDir;
  }
  return a;
}

/** The `settings` of the center's `{ name, settings }` answer (`{}` when absent). (session.rs `settings_of`) */
export const settingsOf = (answer: unknown): Record<string, unknown> =>
  isObj(answer) && isObj(answer.settings) ? answer.settings : {};

/** `workspace` of the center's `center_info` answer (null when absent / not a string / blank). (session.rs `workspace_of`) */
export function workspaceOf(answer: unknown): string | null {
  if (!isObj(answer) || typeof answer.workspace !== "string") return null;
  const w = answer.workspace.trim();
  return w === "" ? null : w;
}

export interface CommandDeps {
  settings: CenterSettingsHandle;
  mcp: CenterMcp;
  sessions: SessionService;
  /** Accept `center_set_settings` (design decision 14). Default false: the browser may not change the destination. */
  allowSettingsWrite?: boolean;
  /** Called with the secrets in a settings input, so the answer / error text can be cleaned of them. */
  noteSecrets?: (secrets: string[]) => void;
}

/** A failure of a center call as a `CommandError`: not allowed 404, settings error 400, anything else 502 (the center / network). */
export function toCommandError(e: unknown): CommandError {
  if (e instanceof CommandError) return e;
  if (e instanceof ToolNotAllowedError) return new CommandError(404, e.message);
  if (e instanceof CenterSettingsError) return new CommandError(400, e.message);
  if (e instanceof CenterMcpError) return new CommandError(502, e.message);
  // Anything else: its text is not known to be free of secrets, so it is not passed on.
  return new CommandError(500, "内部エラー");
}

export function createCommands(deps: CommandDeps): CommandTable {
  const { settings, mcp, sessions } = deps;

  const sessionOf = (v: unknown, what: string): Session => {
    try {
      return parseSession(v);
    } catch (e) {
      throw new CommandError(502, `${what} の結果を読めない: ${(e as Error).message}`);
    }
  };

  const table: Record<string, CommandHandler> = {
    // --- center settings (center.rs) ---
    center_get_settings: () => settings.get(),
    async center_set_settings(a) {
      if (!deps.allowSettingsWrite) {
        throw new CommandError(403, "この版では画面から接続先を変更できない（設定 file か env で変える）");
      }
      const s = a.settings;
      if (!isObj(s)) return bad("settings はオブジェクトで渡す");
      const secrets: string[] = [];
      if (typeof s.token === "string" && s.token !== "") secrets.push(s.token);
      if (isObj(s.remote)) {
        if (typeof s.remote.token === "string" && s.remote.token !== "") secrets.push(s.remote.token);
        if (typeof s.remote.url === "string") {
          try {
            const u = new URL(s.remote.url);
            if (u.password !== "") secrets.push(u.password);
          } catch {
            // not a URL: the settings check refuses it
          }
        }
      }
      deps.noteSecrets?.(secrets);
      return settings.set(s as unknown as Parameters<CenterSettingsHandle["set"]>[0]);
    },

    // --- center_mcp.rs ---
    async center_call(a) {
      const name = reqStr(a, "name");
      const args = a.arguments;
      if (args !== undefined && args !== null && !isObj(args)) return bad("arguments はオブジェクトで渡す");
      return mcp.call(name, args ?? undefined);
    },
    center_connection: () => mcp.connection(),

    // --- session.rs ---
    list_sessions: async (): Promise<SessionList> => sessions.get(),
    refresh_sessions: (): Promise<SessionList> => sessions.refresh(),
    async create_session(a) {
      const name = reqStr(a, "name").trim();
      const raw = a.settings;
      const st = raw === undefined || raw === null ? undefined : normalizeSettings(raw);
      const v = await mcp.json("session_create", createArgs(name, optStr(a, "path"), st));
      const s = sessionOf(v, "session_create");
      await sessions.refresh();
      return s;
    },
    async session_update(a) {
      const name = reqStr(a, "name").trim();
      const moveDir = a.moveDir;
      if (moveDir !== undefined && moveDir !== null && typeof moveDir !== "boolean") return bad("moveDir は真偽値で渡す");
      const v = await mcp.json("session_update", renameArgs(name, optStr(a, "newName"), optStr(a, "path"), moveDir ?? undefined));
      const s = sessionOf(v, "session_update");
      await sessions.refresh();
      return s;
    },
    async session_get_settings(a) {
      const v = await mcp.json("session_settings_get", { name: reqStr(a, "name").trim() });
      return settingsOf(v);
    },
    async session_update_settings(a) {
      const st = normalizeSettings(a.settings);
      const v = await mcp.json("session_settings_update", updateArgs(reqStr(a, "name").trim(), st));
      return settingsOf(v);
    },
    async session_path_hints(): Promise<SessionPathHints> {
      let workspace: string | null = null;
      try {
        workspace = workspaceOf(await mcp.json("center_info"));
      } catch {
        // unknown / an older center without `center_info`: no hint
      }
      // The folder dialog picks a folder on this PC: the browser has none (design 4).
      return { workspace, canPick: false };
    },
  };
  return Object.freeze(table);
}
