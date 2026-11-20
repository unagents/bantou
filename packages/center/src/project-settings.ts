import { isAbsolute } from "node:path";
import { z } from "zod";
import { SERVER_ID_PATTERN } from "@agent-hand/bantou-protocol";
import { SESSION_INSTRUCTIONS_MAX } from "./config.js";

/** 参照フォルダ（`--add-dir`）の最大数（1 つの設定あたり）。 */
export const ADD_DIRS_MAX = 20;
/** session が使う server の指定（`servers`）の最大数（1 つの設定あたり）。 */
export const SERVERS_MAX = 50;
/** host 名の形式（英数字で始まり、英数字と . _ - のみ。253 文字以内）。server_id は SERVER_ID_PATTERN。 */
export const HOST_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;

/** 出力スタイル本文の最大文字数。 */
export const OUTPUT_STYLE_MAX = 32_000;

/** 外部記憶（memory）の url / token / agentId の最大文字数。agentId は session 名の上限（64）に合わせる。 */
export const MEMORY_URL_MAX = 2048;
export const MEMORY_TOKEN_MAX = 4096;
export const MEMORY_AGENT_ID_MAX = 64;
/** token は HTTP header の値に載るので、空白・制御文字・非 ASCII を含まない（空文字は「token 無し」）。 */
const MEMORY_TOKEN_PATTERN = /^[\x21-\x7E]*$/;

/** 外部記憶（memory の MCP endpoint）。保存済みの値。 */
export interface MemorySetting {
  /** memory の MCP endpoint（http/https の絶対 URL）。 */
  url: string;
  /** `Authorization: Bearer` に使う token。環境変数 BANTOU_MEMORY_TOKEN で渡す。無ければ Authorization を付けない。 */
  token?: string;
  /** `X-Agent-Id`。省略時は session 名。 */
  agentId?: string;
}

/**
 * プロジェクト（session）ごとの設定。sessions.json の各 session の `settings` に保存する。
 * 既知の項目は検証し、未知の項目は JSON のまま保持する（将来の項目を足しても古い center が消さない）。
 */
export interface ProjectSettings {
  /** master-cap の追加指示。起動のたびに `--append-system-prompt <値>` で渡す。 */
  instructions?: string;
  /** master-cap が参照してよいフォルダ（絶対パス）。起動のたびに 1 つずつ `--add-dir <path>` で渡す。 */
  addDirs?: string[];
  /**
   * claude の output style の本文（markdown）。起動のたびに session のフォルダの `.claude/output-styles/bantou.md` に書き、
   * `--settings {"outputStyle":"bantou"}` で選ぶ。session の値があれば共通の値は使わない（連結しない）。
   */
  outputStyle?: string;
  /**
   * この session が使ってよい server（host 名か server_id）。未設定 = 全部。空配列 = どの server も使わない。
   * session の設定だけで持つ（center 共通の設定には無い）。
   */
  servers?: string[];
  [key: string]: unknown;
}

const serverRefSchema = z
  .string()
  .refine((v) => SERVER_ID_PATTERN.test(v) || HOST_NAME_PATTERN.test(v), { message: "server の指定は host 名か server_id（英数字と . _ - のみ）" });

const addDirSchema = z.string().min(1).refine((p) => isAbsolute(p), { message: "参照フォルダは絶対パスで指定する" });

const memoryUrlSchema = z
  .string()
  .max(MEMORY_URL_MAX, `url は ${MEMORY_URL_MAX} 文字以内`)
  // 空白・改行・タブ・制御文字は不可（new URL() は前後の空白や途中の改行を剥がして通すため、先に弾く。保存値は入力のまま）
  .refine((v) => v === v.trim() && !/[\x00-\x20\x7f]/.test(v), { message: "url に空白・改行・制御文字は使えない" })
  // ${…} は claude が --mcp-config の中で環境変数として展開する（BANTOU_SESSION_TOKEN などが memory の host へ送られる）ので不可
  .refine((v) => !v.includes("${"), { message: "url に ${…} は書けない（環境変数が展開される。token は token に書く）" })
  .refine(
    (v) => {
      try {
        const u = new URL(v);
        // user:pass@ は argv・log に出るので認めない（token は token 欄に書く）
        return (u.protocol === "http:" || u.protocol === "https:") && u.username === "" && u.password === "";
      } catch {
        return false;
      }
    },
    { message: "url は http / https の絶対 URL（user:pass@ は不可。token は token に書く）" },
  );

/** 外部記憶の設定の入力検証（center の CLI `bantou-center memory` が使う。MCP の更新では受け付けない）。 */
export const memorySchema = z
  .object({
    url: memoryUrlSchema,
    token: z
      .string()
      .max(MEMORY_TOKEN_MAX, `token は ${MEMORY_TOKEN_MAX} 文字以内`)
      .regex(MEMORY_TOKEN_PATTERN, "token は空白・制御文字・非 ASCII を含められない")
      .optional(),
    agentId: z
      .string()
      .max(MEMORY_AGENT_ID_MAX, `agentId は ${MEMORY_AGENT_ID_MAX} 文字以内`)
      .regex(/^(|[A-Za-z0-9_-]+)$/, "agentId は英数字と _ - のみ")
      .optional(),
  })
  .strict();

/** 統括にする session の名前の上限（session 名の規則は英数字と _ -）。 */
export const COORDINATOR_SESSION_MAX = 64;
const COORDINATOR_SESSION_PATTERN = /^[A-Za-z0-9_-]+$/;

/** 統括の session（center 共通の設定 `coordinator`。null / 無し = 無効）。 */
export const coordinatorSchema = z
  .object({
    session: z.string().min(1).max(COORDINATOR_SESSION_MAX, `session は ${COORDINATOR_SESSION_MAX} 文字以内`).regex(COORDINATOR_SESSION_PATTERN, "session は英数字と _ - のみ"),
  })
  .strict();

/** 保存済みの値から統括の session 名を取り出す（壊れていれば null = 無効）。 */
export function readCoordinator(raw: unknown): string | null {
  const r = coordinatorSchema.safeParse(raw);
  return r.success ? r.data.session : null;
}

/** 更新の入力。項目ごとに省略可。null はその項目を削除する。未知の項目は素通しする。 */
export const projectSettingsPatchSchema = z
  .object({
    instructions: z.string().max(SESSION_INSTRUCTIONS_MAX, `${SESSION_INSTRUCTIONS_MAX} 文字以内`).nullable().optional(),
    addDirs: z.array(addDirSchema).max(ADD_DIRS_MAX, `参照フォルダは ${ADD_DIRS_MAX} 個以内`).nullable().optional(),
    outputStyle: z.string().max(OUTPUT_STYLE_MAX, `出力スタイルは ${OUTPUT_STYLE_MAX} 文字以内`).nullable().optional(),
    servers: z.array(serverRefSchema).max(SERVERS_MAX, `servers は ${SERVERS_MAX} 個以内`).nullable().optional(),
  })
  .passthrough();

export type ProjectSettingsPatch = z.infer<typeof projectSettingsPatchSchema>;

/** center の側だけで扱う設定の項目名（画面・web・master-cap の設定更新からは受けない）。 */
export const CENTER_ONLY_KEYS: readonly string[] = ["memory", "mcp", "mcpConnections", "mcpSecrets"];

/** center の側だけの項目を MCP（画面・web・master-cap の設定更新）から受けた時のエラー文。項目の値は含めない。 */
export const CENTER_ONLY_MCP_ERROR =
  "外部記憶（memory）や MCP の接続の設定は MCP からは変えられない（url・token・agentId などは center の側だけで扱う）。center を動かしている host の command（README の「外部記憶の設定」の `bantou-center memory` など）を使う";
export const MEMORY_MCP_ERROR = CENTER_ONLY_MCP_ERROR;

/** patch に center の側だけの項目（null を含む）があれば投げる。黙って捨てない。 */
export function assertCenterOnly(patch: object | undefined): void {
  if (patch === undefined || patch === null) return;
  if (CENTER_ONLY_KEYS.some((k) => Object.prototype.hasOwnProperty.call(patch, k))) throw new Error(CENTER_ONLY_MCP_ERROR);
}

/**
 * center 共通の設定の更新の入力。session の設定から `servers` を除いたもの（servers は session ごとの設定だけで持つ）。
 * `servers` の指定は null（削除。無害）以外は受け付けない（updateCenterSettings がエラーにする）。
 */
export const centerSettingsPatchSchema = projectSettingsPatchSchema.omit({ servers: true }).extend({ coordinator: coordinatorSchema.nullable().optional() }).passthrough();
export type CenterSettingsPatch = z.infer<typeof centerSettingsPatchSchema>;

/** center 共通の設定に `servers` を入れようとした時のエラー文。 */
export const CENTER_SERVERS_ERROR = "servers は center 共通の設定では持てない。session の設定（session_settings_update / session_create の settings）で指定する";

/** 保存済みの center 共通の設定（center-settings.json 由来）。残っている `servers` は読み捨てる（次の保存で消える）。 */
export function readCenterSettings(raw: unknown): ProjectSettings {
  const out = readSettings(raw);
  delete out.servers;
  // 壊れた coordinator は無効にする（別の session を統括にしない）
  if (out.coordinator !== undefined && readCoordinator(out.coordinator) === null) delete out.coordinator;
  return out;
}

/**
 * patch を current に重ねた新しい settings を返す（current は変えない）。
 * - patch に無い（undefined）項目は変えない。
 * - null はその項目を削除する。`instructions` / `outputStyle` の空文字・`addDirs` の空配列も削除と同じ（保存しない）。
 * - `addDirs` は重複を除く（先勝ち）。
 * - `servers` は重複を除く（先勝ち）。空配列は保存する（= どの server も使わない。未設定と区別する）。削除は null。
 * - `memory` は扱わない（無視する。MCP の入口で assertNoMemory が断る。外部記憶は memory-settings.ts）。
 * - 未知の項目は値をそのまま入れる。
 */
export function mergeSettings(current: ProjectSettings | undefined, patch: ProjectSettingsPatch): ProjectSettings {
  const out: ProjectSettings = { ...(current ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null || ((k === "instructions" || k === "outputStyle") && v === "")) delete out[k];
    else if (k === "addDirs") {
      const dirs = uniqueDirs(v);
      if (dirs.length) out.addDirs = dirs;
      else delete out.addDirs;
    } else if (k === "servers") out.servers = uniqueDirs(v);
    else if (k === "memory") continue;
    else out[k] = v;
  }
  return out;
}

/** 文字列の配列から空と重複を除く（先勝ち）。配列でなければ空。 */
function uniqueDirs(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const d of v) if (typeof d === "string" && d !== "" && !out.includes(d)) out.push(d);
  return out;
}

/** 保存済みの値（sessions.json 由来。壊れていても落とさない）から settings を取り出す。 */
export function readSettings(raw: unknown): ProjectSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: ProjectSettings = { ...(raw as Record<string, unknown>) };
  if (typeof out.instructions !== "string" || out.instructions === "") delete out.instructions;
  if (typeof out.outputStyle !== "string" || out.outputStyle === "") delete out.outputStyle;
  const dirs = uniqueDirs(out.addDirs);
  if (dirs.length) out.addDirs = dirs;
  else delete out.addDirs;
  // 外部記憶は memory-settings.json だけで持つ（ここに残っていても読み捨てる。sessions.ts の restore が移し替える）
  delete out.memory;
  // servers: 配列なら（空でも）残す。配列でなければ未設定（壊れた値で全 server を止めない）
  if (Array.isArray(out.servers)) out.servers = uniqueDirs(out.servers);
  else delete out.servers;
  return out;
}

/** center 共通と session の参照フォルダを 1 つにする（共通が先、重複は除く）。`--add-dir` に 1 つずつ渡す。 */
export function composeAddDirs(common: ProjectSettings | undefined, own: ProjectSettings | undefined): string[] {
  return uniqueDirs([...(readSettings(common).addDirs ?? []), ...(readSettings(own).addDirs ?? [])]);
}

/**
 * center 共通の追加指示と session の追加指示を 1 つにする（`--append-system-prompt` の値）。
 * 共通が先、空行 1 つを挟んで session のもの。どちらも無ければ空文字（付けない）。
 */
export function composeInstructions(common: ProjectSettings | undefined, own: ProjectSettings | undefined): string {
  return [readSettings(common).instructions, readSettings(own).instructions].filter((x): x is string => typeof x === "string").join("\n\n");
}

/**
 * 出力スタイルの本文。session の値があればそれ、無ければ center 共通の値、どちらも無ければ空文字（付けない）。
 * output style は 1 つしか選べないので連結しない。
 */
export function composeOutputStyle(common: ProjectSettings | undefined, own: ProjectSettings | undefined): string {
  return readSettings(own).outputStyle ?? readSettings(common).outputStyle ?? "";
}

/**
 * session が使ってよい server の指定（host 名か server_id）。session の `servers` だけを見る（center 共通の設定は見ない）。
 * 無ければ undefined（= 全部）。空配列は「どの server も使わない」。
 */
export function composeServers(own: ProjectSettings | undefined): string[] | undefined {
  return readSettings(own).servers;
}

/** server（server_id と host 名）が `servers` の指定に入っているか。server_id は完全一致、host 名は大文字小文字を区別しない。 */
export function serverAllowed(servers: string[] | undefined, s: { server_id?: string; host?: string }): boolean {
  if (servers === undefined) return true;
  return servers.some((e) => (s.server_id !== undefined && e === s.server_id) || (s.host !== undefined && e.toLowerCase() === s.host.toLowerCase()));
}
