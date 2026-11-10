import type { CenterCommonSettings, ProjectSettings } from "~/types";

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

/** What a `servers` entry may be: a host name or a server_id (same patterns as the center). */
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
  /** Servers the session may use (host names or server_ids). null = not set (all, or the center-wide value); [] = none. */
  servers: string[] | null;
}

export const emptyDraft = (): SettingsDraft => ({ instructions: "", addDirs: [], outputStyle: "", servers: null });

/** The form values for the settings the center returned. */
export const draftOf = (s: ProjectSettings): SettingsDraft => ({
  instructions: s.instructions ?? "",
  addDirs: Array.isArray(s.addDirs) ? s.addDirs.filter((d): d is string => typeof d === "string") : [],
  outputStyle: s.outputStyle ?? "",
  servers: Array.isArray(s.servers) ? cleanServers(s.servers.filter((d): d is string => typeof d === "string")) : null,
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

/** The form values as an update body: a blank item is `null` (the center removes it). */
export const toUpdate = (d: SettingsDraft): ProjectSettings => {
  const dirs = cleanDirs(d.addDirs);
  return {
    instructions: d.instructions.trim() ? d.instructions : null,
    addDirs: dirs.length ? dirs : null,
    outputStyle: d.outputStyle.trim() ? d.outputStyle : null,
    // null (not set) removes the item; an empty list is kept and means "no server"
    servers: d.servers === null ? null : cleanServers(d.servers),
  };
};

/** The form values as an update body for the center-wide settings: no `servers` (the center rejects it; it is a per-session setting). */
export const toCenterUpdate = (d: SettingsDraft): CenterCommonSettings => {
  const { servers: _servers, ...rest } = toUpdate(d);
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
    if (badServer !== undefined) return `server は host 名か server_id（英数字と . _ - のみ）で指定する: ${badServer}`;
  }
  return null;
};
