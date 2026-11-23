import type { CenterCommonSettings, ProjectSettings } from "../types";

/** Note shown next to every project-settings form. */
export const INSTRUCTIONS_NOTE = "保存後に起動する session から効く。動いている session には効かない";

/** Max length (chars) of `instructions` (same limit as the center). */
export const INSTRUCTIONS_MAX = 16_000;

/** Max number of `addDirs` entries (same limit as the center). */
export const ADD_DIRS_MAX = 20;

/** Max length (chars) of `outputStyle` (same limit as the center). */
export const OUTPUT_STYLE_MAX = 32_000;

/** Max number of `servers` entries (same limit as the center). */
export const SERVERS_MAX = 50;

/** What a `servers` entry may be: a server's name (same patterns as the center). */
const SERVER_REF = /^(?:[A-Za-z0-9_-]{1,64}|[A-Za-z0-9][A-Za-z0-9._-]{0,252})$/;

/**
 * What the project-settings form edits: one value per item. A new item (skills, output style, …) is
 * a field here, a section in `ProjectSettingsFields.vue`, and a line in the functions below.
 * The same form serves the center-wide settings (same shape on the center).
 */
export interface SettingsDraft {
  instructions: string;
  /** Reference folders (`--add-dir`), one per row; blank rows are dropped on save. */
  addDirs: string[];
  /** The body of claude's output style (markdown). */
  outputStyle: string;
  /** Servers the session may use (server names). null = not set (all, or the center-wide value); [] = none. */
  servers: string[] | null;
  /** Extra MCP servers as JSON text (`{ "mcpServers": { … } }`, as in Claude Code's mcp.json). "" = none. Launcher only. */
  mcpServers: string;
  /** The external memory's MCP server as JSON text (one entry, e.g. `{ "type": "http", "url": …, "headers": { … } }`). "" = none. Launcher only. */
  memory: string;
}

export const emptyDraft = (): SettingsDraft => ({ instructions: "", addDirs: [], outputStyle: "", servers: null, mcpServers: "", memory: "" });

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The JSON text the form shows for the extra MCP servers (the mcp.json form `{ "mcpServers": { … } }`). */
export const serversText = (v: unknown): string => (isRec(v) && Object.keys(v).length ? JSON.stringify({ mcpServers: v }, null, 2) : "");
/** The JSON text the form shows for the memory server. */
export const memoryText = (v: unknown): string => (isRec(v) ? JSON.stringify(v, null, 2) : "");

/**
 * The extra MCP servers typed in the form: `{ "mcpServers": { name: entry } }` (as copied from an mcp.json) or the map itself.
 * Blank = remove (null). Each entry is an object (or null in a session: drops the center-wide one). The center checks the rest.
 */
export function parseServersText(text: string): { value: Record<string, unknown> | null } | { error: string } {
  if (!text.trim()) return { value: null };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { error: `追加の MCP の server が JSON として読めない: ${String(e)}` };
  }
  if (!isRec(v)) return { error: "追加の MCP の server は { \"mcpServers\": { 名前: 設定 } } の形で書く" };
  const map = Object.keys(v).length === 1 && isRec(v.mcpServers) ? v.mcpServers : v;
  for (const [name, e] of Object.entries(map)) if (e !== null && !isRec(e)) return { error: `追加の MCP の server ${name} の設定は object で書く` };
  return { value: Object.keys(map).length ? map : null };
}

/** The memory server typed in the form: one entry, or `{ "mcpServers": { name: entry } }` with exactly one entry. Blank = remove (null). */
export function parseMemoryText(text: string): { value: Record<string, unknown> | null } | { error: string } {
  if (!text.trim()) return { value: null };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { error: `外部記憶が JSON として読めない: ${String(e)}` };
  }
  if (!isRec(v)) return { error: "外部記憶は MCP の server の設定 1 件（{ \"type\": \"http\", \"url\": …, \"headers\": { … } } など）で書く" };
  if (Object.keys(v).length === 1 && isRec(v.mcpServers)) {
    const all = Object.values(v.mcpServers);
    if (all.length !== 1 || !isRec(all[0])) return { error: "外部記憶は MCP の server の設定 1 件で書く" };
    return { value: all[0] };
  }
  return { value: v };
}

/** The form values for the settings the center returned. */
export const draftOf = (s: ProjectSettings): SettingsDraft => ({
  instructions: s.instructions ?? "",
  addDirs: Array.isArray(s.addDirs) ? s.addDirs.filter((d): d is string => typeof d === "string") : [],
  outputStyle: s.outputStyle ?? "",
  servers: Array.isArray(s.servers) ? cleanServers(s.servers.filter((d): d is string => typeof d === "string")) : null,
  mcpServers: serversText(s.mcpServers),
  memory: memoryText(s.memory),
});

/** The server rows as the center takes them: trimmed, blanks dropped, duplicates dropped. */
export const cleanServers = (list: string[]): string[] => {
  const out: string[] = [];
  for (const d of list.map((x) => x.trim())) if (d && !out.includes(d)) out.push(d);
  return out;
};

/** The folder rows as the center takes them: trimmed, blanks dropped, duplicates dropped. */
export const cleanDirs = (dirs: string[]): string[] => {
  const out: string[] = [];
  for (const d of dirs.map((x) => x.trim())) if (d && !out.includes(d)) out.push(d);
  return out;
};

/**
 * The form values as an update body: a blank item is `null` (the center removes it).
 * `mcpServers` / `memory` (launcher only) are sent only when `base` (the saved values) is given and the text changed: an item
 * left out is unchanged on the center, so a form that does not show them never touches them.
 */
export const toUpdate = (d: SettingsDraft, opts: { base?: SettingsDraft } = {}): ProjectSettings => {
  const dirs = cleanDirs(d.addDirs);
  const out: ProjectSettings = {
    instructions: d.instructions.trim() ? d.instructions : null,
    addDirs: dirs.length ? dirs : null,
    outputStyle: d.outputStyle.trim() ? d.outputStyle : null,
    // null (not set) removes the item; an empty list is kept and means "no server"
    servers: d.servers === null ? null : cleanServers(d.servers),
  };
  if (opts.base && d.mcpServers !== opts.base.mcpServers) {
    const r = parseServersText(d.mcpServers);
    if ("value" in r) out.mcpServers = r.value;
  }
  if (opts.base && d.memory !== opts.base.memory) {
    const r = parseMemoryText(d.memory);
    if ("value" in r) out.memory = r.value;
  }
  return out;
};

/** The form values as an update body for the center-wide settings: no `servers` (the center rejects it; it is a per-session setting). */
export const toCenterUpdate = (d: SettingsDraft, opts: { base?: SettingsDraft } = {}): CenterCommonSettings => {
  const { servers: _servers, ...rest } = toUpdate(d, opts);
  return rest;
};

/** The form values for `session_create`: only the items that are set (a `null` item means none, so it is left out). */
export const toCreate = (d: SettingsDraft): ProjectSettings =>
  Object.fromEntries(Object.entries(toUpdate(d)).filter(([, v]) => v !== null)) as ProjectSettings;

/** An absolute path on the center's host (POSIX `/…`, or Windows `C:\\…` / `\\\\server\\…`). */
const isAbsolutePath = (p: string): boolean => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p);

/** Problem with the form values, or null. */
export const draftError = (d: SettingsDraft): string | null => {
  if ([...d.instructions].length > INSTRUCTIONS_MAX) return `追加指示は ${INSTRUCTIONS_MAX} 文字以内`;
  const dirs = cleanDirs(d.addDirs);
  if (dirs.length > ADD_DIRS_MAX) return `参照フォルダは ${ADD_DIRS_MAX} 個以内`;
  const bad = dirs.find((p) => !isAbsolutePath(p));
  if (bad !== undefined) return `参照フォルダは絶対パスで指定する: ${bad}`;
  if ([...d.outputStyle].length > OUTPUT_STYLE_MAX) return `出力スタイルは ${OUTPUT_STYLE_MAX} 文字以内`;
  if (d.servers !== null) {
    const list = cleanServers(d.servers);
    if (list.length > SERVERS_MAX) return `server は ${SERVERS_MAX} 個以内`;
    const badServer = list.find((s) => !SERVER_REF.test(s));
    if (badServer !== undefined) return `server は server の名前（英数字と . _ - のみ）で指定する: ${badServer}`;
  }
  const ms = parseServersText(d.mcpServers);
  if ("error" in ms) return ms.error;
  const mem = parseMemoryText(d.memory);
  if ("error" in mem) return mem.error;
  return null;
};
