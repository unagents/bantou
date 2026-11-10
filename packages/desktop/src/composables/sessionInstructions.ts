import type { ProjectSettings } from "~/types";

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

/** Max lengths of the external-memory fields (same limits as the center). */
export const MEMORY_URL_MAX = 2048;
export const MEMORY_TOKEN_MAX = 4096;
export const MEMORY_AGENT_ID_MAX = 64;

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
  /** External memory (MCP endpoint). All blank = not set. */
  memory: MemoryDraft;
}

/**
 * The external-memory fields. The center never returns the saved token (it answers `tokenSet`): `token` is only what
 * is typed now (blank = keep the saved one), `tokenClear` removes the saved one.
 */
export interface MemoryDraft {
  url: string;
  token: string;
  agentId: string;
  /** A token is saved on the center (shown as a note, never the value). */
  tokenSet: boolean;
  /** Remove the saved token on save. */
  tokenClear: boolean;
}

export const emptyMemory = (): MemoryDraft => ({ url: "", token: "", agentId: "", tokenSet: false, tokenClear: false });

export const emptyDraft = (): SettingsDraft => ({ instructions: "", addDirs: [], outputStyle: "", servers: null, memory: emptyMemory() });

/** The form values for the settings the center returned. */
export const draftOf = (s: ProjectSettings): SettingsDraft => ({
  instructions: s.instructions ?? "",
  addDirs: Array.isArray(s.addDirs) ? s.addDirs.filter((d): d is string => typeof d === "string") : [],
  outputStyle: s.outputStyle ?? "",
  servers: Array.isArray(s.servers) ? cleanServers(s.servers.filter((d): d is string => typeof d === "string")) : null,
  memory: s.memory
    ? { url: s.memory.url ?? "", token: "", agentId: s.memory.agentId ?? "", tokenSet: s.memory.tokenSet === true, tokenClear: false }
    : emptyMemory(),
});

/** True when no memory field is filled in (the item is not set). */
const memoryBlank = (m: MemoryDraft): boolean => !m.url.trim() && !m.token.trim() && !m.agentId.trim() && !m.tokenClear;

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
    // The center replaces the whole object: an omitted token keeps the saved one, "" removes it. Blank url = remove the item.
    memory: !d.memory.url.trim()
      ? null
      : {
          url: d.memory.url.trim(),
          ...(d.memory.token.trim() ? { token: d.memory.token.trim() } : d.memory.tokenClear ? { token: "" } : {}),
          ...(d.memory.agentId.trim() ? { agentId: d.memory.agentId.trim() } : {}),
        },
  };
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
  const m = d.memory;
  if (!memoryBlank(m)) {
    const url = m.url.trim();
    if (!url) return "外部記憶の URL を入れる（token / agent ID だけでは保存できない）";
    if ([...url].length > MEMORY_URL_MAX) return `外部記憶の URL は ${MEMORY_URL_MAX} 文字以内`;
    if (/[\x00-\x20\x7f]/.test(url)) return "外部記憶の URL に空白・改行は使えない";
    if (url.includes("${")) return "外部記憶の URL に ${…} は書けない（環境変数が展開される。token は token 欄に入れる）";
    let u: URL | null = null;
    try {
      u = new URL(url);
    } catch {
      u = null;
    }
    if (!u || (u.protocol !== "http:" && u.protocol !== "https:")) return "外部記憶の URL は http / https の絶対 URL";
    if (u.username || u.password) return "外部記憶の URL に user:pass@ は書けない（token は token 欄に入れる）";
    const token = m.token.trim();
    if ([...token].length > MEMORY_TOKEN_MAX) return `外部記憶の token は ${MEMORY_TOKEN_MAX} 文字以内`;
    if (!/^[\x21-\x7E]*$/.test(token)) return "外部記憶の token に空白・制御文字・日本語は使えない";
    const agentId = m.agentId.trim();
    if ([...agentId].length > MEMORY_AGENT_ID_MAX) return `外部記憶の agent ID は ${MEMORY_AGENT_ID_MAX} 文字以内`;
    if (agentId && !/^[A-Za-z0-9_-]+$/.test(agentId)) return "外部記憶の agent ID は英数字と _ - のみ";
  }
  return null;
};
