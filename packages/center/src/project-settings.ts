import { isAbsolute } from "node:path";
import { z } from "zod";
import { SESSION_INSTRUCTIONS_MAX } from "./config.js";
import { memoryDefIssues, memoryDefOf, type McpServerDef } from "./mcp-server-def.js";

/** 参照フォルダ（`--add-dir`）の最大数（1 つの設定あたり）。 */
export const ADD_DIRS_MAX = 20;
/** session が使う server の指定（`servers`）の最大数（1 つの設定あたり）。 */
export const SERVERS_MAX = 50;
/** server の名前（agent-messenger の名前）の形式（英数字で始まり、英数字と . _ - のみ。253 文字以内）。 */
export const HOST_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;

/** 出力スタイル本文の最大文字数。 */
export const OUTPUT_STYLE_MAX = 32_000;

/** 外部記憶（memory）の url / token / agentId の最大文字数。agentId は session 名の上限（64）に合わせる。 */
export const MEMORY_URL_MAX = 2048;
export const MEMORY_TOKEN_MAX = 4096;
export const MEMORY_AGENT_ID_MAX = 64;
/** token は HTTP header の値に載るので、空白・制御文字・非 ASCII を含まない（空文字は「token 無し」）。 */
const MEMORY_TOKEN_PATTERN = /^[\x21-\x7E]*$/;

/** 旧形式の外部記憶（0.1.56 までの `{ url, token?, agentId? }`。memory-settings.json と旧い settings.memory）。今は普通の MCP の設定（McpServerDef）で持つ。 */
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
   * この session が使ってよい server（server の名前。remote_send の server に渡す値）。未設定 = 全部。空配列 = どの server も使わない。
   * session の設定だけで持つ（center 共通の設定には無い）。
   */
  servers?: string[];
  /**
   * 追加の MCP の server（名前 → Claude Code の mcp.json の mcpServers の値と同じ形。stdio・http・sse など。headers に Bearer などの値もそのまま書ける）。
   * center 共通の設定では全 session に載り、session の設定ではその session だけに載る（同じ名前は共通を置き換える。null = 共通の server をその session では外す）。
   * 旧形式（transport: http + auth.secret）も書ける（mcp-connections.ts）。統括の道具は、独立した MCP の server（coordinator-mcp.ts）を普通の http の 1 項目で書く。
   * 書けるのは center を起動した所（desktop の sidecar の設定の画面・stdio の起動元）と設定 file の直接の編集。
   */
  mcpServers?: Record<string, unknown>;
  /**
   * 外部記憶（memory）の MCP の server（Claude Code の mcp.json の mcpServers の値と同じ形。例 `{ type: "http", url, headers: { Authorization: "Bearer …" } }`）。
   * session の値があれば共通の値は使わない。旧形式 `{ url, token?, agentId? }` は読み替える（mcp-server-def.ts の memoryDefOf）。
   */
  memory?: McpServerDef;
  /**
   * guardrail の設定: openspec 向けの schema 定義（名前 → { schema, templates }）。center 共通の設定だけで持つ。
   * schema は schema.yaml の文字列、templates は templates/ からの相対 path → 中身の文字列。bantou は YAML も中身も解釈しない（そのまま保存して返す）。
   */
  guardrailSchemas?: Record<string, GuardrailSchema>;
  [key: string]: unknown;
}

/** guardrail の schema 定義 1 件（schema-discovery の `resources/read` の応答の `schema` と `templates` になる）。 */
export interface GuardrailSchema {
  /** schema.yaml の文字列。 */
  schema: string;
  /** templates/ からの相対 path → 中身の文字列。無ければ空。 */
  templates: Record<string, string>;
}

/** guardrail の schema の名前の規則（schema-discovery のプロトコル: `[A-Za-z0-9][A-Za-z0-9._-]*`。大文字小文字を区別する）。 */
export const GUARDRAIL_SCHEMA_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** templates の path が templates/ からの相対 path か（空でない・絶対でない・`.` `..` や空の区間を含まない・`\` と NUL を含まない）。 */
export function isTemplatePath(p: string): boolean {
  if (p === "" || p.includes("\\") || p.includes("\0")) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/** 1 件の定義として読める形に整える（schema が文字列・templates が 相対 path → 文字列。templates 省略は空）。読めなければ undefined。 */
export function guardrailSchemaValue(v: unknown): GuardrailSchema | undefined {
  if (!isRecord(v) || typeof v.schema !== "string") return undefined;
  const rawT = v.templates === undefined ? {} : v.templates;
  if (!isRecord(rawT)) return undefined;
  const entries = Object.entries(rawT);
  if (!entries.every(([path, body]) => isTemplatePath(path) && typeof body === "string")) return undefined;
  // fromEntries は own property として作る（path が __proto__ でも prototype を書き換えない）
  return { schema: v.schema, templates: Object.fromEntries(entries as [string, string][]) };
}

/** 保存済みの設定から guardrail の schema 定義（名前 → 中身）を取り出す。名前の規則・形に合わない物は含めない。壊れていれば空。 */
export function guardrailSchemasOf(settings: unknown): Record<string, GuardrailSchema> {
  const raw = isRecord(settings) ? settings.guardrailSchemas : undefined;
  if (!isRecord(raw)) return {};
  const out: [string, GuardrailSchema][] = [];
  for (const [name, def] of Object.entries(raw)) {
    const v = GUARDRAIL_SCHEMA_NAME.test(name) ? guardrailSchemaValue(def) : undefined;
    if (v) out.push([name, v]);
  }
  // fromEntries は own property として作る
  return Object.fromEntries(out);
}

/** 名前を指して定義 1 件を返す（無ければ undefined）。 */
export function guardrailSchemaOf(settings: unknown, name: string): GuardrailSchema | undefined {
  const all = guardrailSchemasOf(settings);
  return Object.hasOwn(all, name) ? all[name] : undefined;
}

/** schema 定義の一覧（名前の昇順）。 */
export function guardrailSchemaNames(settings: unknown): string[] {
  return Object.keys(guardrailSchemasOf(settings)).sort();
}

const serverRefSchema = z
  .string()
  .refine((v) => HOST_NAME_PATTERN.test(v), { message: "server の指定は server の名前（agent-messenger の名前。英数字と . _ - のみ）" });

const addDirSchema = z.string().min(1).refine((p) => isAbsolute(p), { message: "参照フォルダは絶対パスで指定する" });

export const memoryUrlSchema = z
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

/**
 * 旧設定（center-settings.json の coordinator）から統括の session 名を取り出す（壊れていれば null）。
 * 統括の指定はもう設定では持たない（mcpServers の bantou-coordinator の割り当てが正本）。旧設定の移行（sessions.ts の restore）だけが読む。
 */
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
    // 中身の検査は settingsIssues（共通と session で null の扱いが違う）
    mcpServers: z.record(z.string(), z.unknown()).nullable().optional(),
    memory: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .passthrough();

export type ProjectSettingsPatch = z.infer<typeof projectSettingsPatchSchema>;

/**
 * center を起動した所（desktop の sidecar の設定の画面・stdio の起動元）だけが書ける項目。別 host の center に繋いでいる desktop・web・
 * 他の MCP の呼び出し元からは読み書きしない（読みの応答からも除く）。
 */
export const LAUNCHER_KEYS: readonly string[] = ["memory", "mcpServers"];
/** 旧設定の項目（どこからも MCP では書かない。旧 CLI・移行だけが扱う）。 */
export const LEGACY_INTERNAL_KEYS: readonly string[] = ["mcp", "mcpConnections", "mcpSecrets", "coordinator"];
/**
 * center 共通の設定の `projectMemory`（config の projects 由来の session = sessions.json に記録が無い session の名前 → 外部記憶）。
 * 書くのは `bantou-center memory --session` と移行と設定 file の直接の編集だけ（MCP の設定の更新では受けない）。起動元以外の読みからは除く。
 */
export const FILE_ONLY_KEYS: readonly string[] = ["projectMemory"];
/** center の側だけで扱う設定の項目名（起動元以外の設定更新からは受けない）。 */
export const CENTER_ONLY_KEYS: readonly string[] = [...LAUNCHER_KEYS, ...LEGACY_INTERNAL_KEYS, ...FILE_ONLY_KEYS];

/** center の側だけの項目を起動元以外（別 host の desktop・web・他の呼び出し元）から受けた時のエラー文。項目の値は含めない。 */
export const CENTER_ONLY_MCP_ERROR =
  "外部記憶（memory）と追加の MCP の server（mcpServers）は、center を起動した所（sidecar の center を動かしている desktop の設定の画面）でだけ変えられる。別 host の center に繋いでいる desktop・web からは変えられない";
export const MEMORY_MCP_ERROR = CENTER_ONLY_MCP_ERROR;
/** 旧設定の項目を受けた時のエラー文。 */
export const LEGACY_KEYS_ERROR = "mcp・mcpConnections・mcpSecrets・coordinator は旧設定の項目で、設定の更新では書けない（追加の MCP の server は mcpServers に書く）";
/** projectMemory を設定の更新で受けた時のエラー文。 */
export const PROJECT_MEMORY_ERROR = "projectMemory（config の projects 由来の session の外部記憶）は設定の更新では書けない。`bantou-center memory set --session <名前>` か center-settings.json の直接の編集で書く";

const hasKey = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/**
 * patch の center の側だけの項目（null を含む）を検査する。黙って捨てない。
 * launcher = 呼び出し元が center を起動した所（memory・mcpServers を書ける）。旧設定の項目は誰からも受けない。
 */
export function assertCenterOnly(patch: object | undefined, opts: { launcher?: boolean } = {}): void {
  if (patch === undefined || patch === null) return;
  if (LEGACY_INTERNAL_KEYS.some((k) => hasKey(patch, k))) throw new Error(opts.launcher ? LEGACY_KEYS_ERROR : CENTER_ONLY_MCP_ERROR);
  if (FILE_ONLY_KEYS.some((k) => hasKey(patch, k))) throw new Error(opts.launcher ? PROJECT_MEMORY_ERROR : CENTER_ONLY_MCP_ERROR);
  if (!opts.launcher && LAUNCHER_KEYS.some((k) => hasKey(patch, k))) throw new Error(CENTER_ONLY_MCP_ERROR);
}

/** 読みの応答から center の側だけの項目を除く（起動元以外へ返す時）。 */
export function withoutLauncherKeys<T extends object>(settings: T): T {
  const out = { ...settings } as Record<string, unknown>;
  for (const k of [...LAUNCHER_KEYS, ...FILE_ONLY_KEYS]) delete out[k];
  return out as T;
}

/**
 * patch の memory・mcpServers の中身の検査（誤りの文に値は含めない。名前は含める）。scope = "common"（center 共通）か "session"。
 * - mcpServers: 名前ごとに、普通の MCP の設定（mcp-server-def.ts の serverDefIssues）・組み込み・旧形式のどれか。session では null（共通を外す）も可。
 * - memory: 普通の MCP の設定（旧形式 { url, token?, agentId? } も可）。
 */
export function settingsIssues(patch: object | undefined, scope: "common" | "session", checkServer: (name: string, raw: unknown, scope: "common" | "session") => string[]): string[] {
  if (patch === undefined || patch === null) return [];
  const out: string[] = [];
  const p = patch as { mcpServers?: unknown; memory?: unknown; guardrailSchemas?: unknown };
  // guardrail の schema 定義は center 共通の設定だけで持つ（session の設定には置かない。null＝削除は無害なので通す）
  if (scope === "session" && p.guardrailSchemas !== undefined && p.guardrailSchemas !== null) out.push("guardrailSchemas は center 共通の設定でだけ書ける");
  if (p.mcpServers !== undefined && p.mcpServers !== null) {
    if (typeof p.mcpServers !== "object" || Array.isArray(p.mcpServers)) out.push("mcpServers は 名前 → MCP の server の設定 の object");
    else
      for (const [name, raw] of Object.entries(p.mcpServers as Record<string, unknown>)) {
        if (raw === null && scope === "session") continue;
        if (raw === null) {
          out.push(`mcpServers.${name}: null は session の設定でだけ書ける（共通の server をその session で外す）`);
          continue;
        }
        for (const i of checkServer(name, raw, scope)) out.push(`mcpServers.${name}: ${i}`);
      }
  }
  if (p.memory !== undefined && p.memory !== null) for (const i of memoryDefIssues(p.memory)) out.push(`memory: ${i}`);
  return out;
}

/**
 * center 共通の設定の更新の入力。session の設定から `servers` を除いたもの（servers は session ごとの設定だけで持つ）。
 * `servers` の指定は null（削除。無害）以外は受け付けない（updateCenterSettings がエラーにする）。
 */
export const centerSettingsPatchSchema = projectSettingsPatchSchema
  .omit({ servers: true })
  .extend({
    // 名前 → { schema（YAML の文字列）, templates?（相対 path → 中身の文字列）}。名前ごとに足す・変える（定義は丸ごと置き換え）。名前の値が null でその schema を消す。項目全体の null で全部消す
    guardrailSchemas: z
      .record(
        z.string().regex(GUARDRAIL_SCHEMA_NAME, "schema の名前は英数字で始まり、英数字と . _ - のみ"),
        z
          .object({
            schema: z.string(),
            templates: z.record(z.string().refine(isTemplatePath, { message: "templates の path は templates/ からの相対 path" }), z.string()).optional(),
          })
          .nullable(),
      )
      .nullable()
      .optional(),
  })
  .passthrough();
export type CenterSettingsPatch = z.infer<typeof centerSettingsPatchSchema>;

/** center 共通の設定に `servers` を入れようとした時のエラー文。 */
export const CENTER_SERVERS_ERROR = "servers は center 共通の設定では持てない。session の設定（session_settings_update / session_create の settings）で指定する";

/** 保存済みの center 共通の設定（center-settings.json 由来）。残っている `servers` は読み捨てる（次の保存で消える）。 */
export function readCenterSettings(raw: unknown): ProjectSettings {
  const out = readSettings(raw);
  delete out.servers;
  // 旧設定の coordinator は読み捨てる（統括の口は mcpServers の bantou-coordinator で割り当てる。移行は sessions.ts の restore）
  delete out.coordinator;
  return out;
}

/**
 * patch を current に重ねた新しい settings を返す（current は変えない）。
 * - patch に無い（undefined）項目は変えない。
 * - null はその項目を削除する。`instructions` / `outputStyle` の空文字・`addDirs` の空配列も削除と同じ（保存しない）。
 * - `addDirs` は重複を除く（先勝ち）。
 * - `servers` は重複を除く（先勝ち）。空配列は保存する（= どの server も使わない。未設定と区別する）。削除は null。
 * - `memory` は普通の MCP の設定の形にして入れる（旧形式は読み替える）。
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
    // guardrail の schema 定義は名前ごとにマージ（名前の値 null でその schema を消す。空になれば項目ごと消す）
    else if (k === "guardrailSchemas") {
      const patchEntries = Object.entries(isRecord(v) ? v : {}).filter(([name]) => GUARDRAIL_SCHEMA_NAME.test(name));
      const removed = new Set(patchEntries.filter(([, def]) => def === null || def === undefined).map(([name]) => name));
      // 定義は丸ごと置き換える。読めない形の値（zod を通らない経路）は入れない
      const added = patchEntries.flatMap(([name, def]): [string, GuardrailSchema][] => {
        const g = guardrailSchemaValue(def);
        return g ? [[name, g]] : [];
      });
      const replaced = new Set(added.map(([name]) => name));
      const merged = Object.fromEntries([...Object.entries(guardrailSchemasOf(out)).filter(([name]) => !removed.has(name) && !replaced.has(name)), ...added]);
      if (Object.keys(merged).length) out.guardrailSchemas = merged;
      else delete out.guardrailSchemas;
    }
    // 外部記憶は普通の MCP の設定の形で持つ（旧形式は読み替える）
    else if (k === "memory") {
      const d = memoryDefOf(v);
      if (d) out.memory = d;
      else delete out.memory;
    } else out[k] = v;
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
  // 外部記憶: 普通の MCP の設定の形にする（旧形式 { url, token, agentId } は読み替える）。object でなければ未設定
  const mem = memoryDefOf(out.memory);
  if (mem) out.memory = mem;
  else delete out.memory;
  // servers: 配列なら（空でも）残す。配列でなければ未設定（壊れた値で全 server を止めない）
  if (Array.isArray(out.servers)) out.servers = uniqueDirs(out.servers);
  else delete out.servers;
  // mcpServers: 連想配列だけ残す（中身の検査は mcp-connections.ts が使う時に行う）
  if (typeof out.mcpServers !== "object" || out.mcpServers === null || Array.isArray(out.mcpServers)) delete out.mcpServers;
  // guardrailSchemas: 名前の規則に合う物だけ残す。空・壊れていれば未設定
  if ("guardrailSchemas" in out) {
    const g = guardrailSchemasOf(out);
    if (Object.keys(g).length) out.guardrailSchemas = g;
    else delete out.guardrailSchemas;
  }
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
 * session が使ってよい server の指定（server の名前）。session の `servers` だけを見る（center 共通の設定は見ない）。
 * 無ければ undefined（= 全部）。空配列は「どの server も使わない」。
 */
export function composeServers(own: ProjectSettings | undefined): string[] | undefined {
  return readSettings(own).servers;
}

/** server（agent-messenger の名前。`host` に渡す）が `servers` の指定に入っているか。名前の完全一致（大文字小文字も区別する）。 */
export function serverAllowed(servers: string[] | undefined, s: { host?: string }): boolean {
  if (servers === undefined) return true;
  return servers.some((e) => s.host !== undefined && e === s.host);
}
