/**
 * 最後に「試した」結果の保存（`mcp-status.json`、mode 0600、秘密を含まない）。
 * 道具の一覧の写しは先の一覧そのもの（接続ごとに 1 MB まで、越えたら残さない）を、設定の hash と一緒に残す。
 */
import { join } from "node:path";
import { createJsonFile, type JsonFile } from "./mcp-json-file.js";

export const MCP_STATUS_FILE = "mcp-status.json";
export const TOOLS_COPY_MAX_BYTES = 1024 * 1024;

export const RESULTS = ["ok", "unreachable", "timeout", "auth", "not-found", "protocol", "config-error"] as const;
export type ProbeKind = (typeof RESULTS)[number];

export interface StatusRecord {
  checkedAt: string;
  result: ProbeKind;
  httpStatus?: number;
  toolCount: number;
  /** session に見える道具の名前（toolPrefix と絞り込みを当てた後）。 */
  visibleTools: string[];
  durationMs: number;
  /** 写しを取った時の設定の hash。 */
  configHash: string;
  /** 先の一覧そのもの（name / description / inputSchema / annotations）。1 MB を越えたら無い。 */
  toolsCopy?: unknown[];
}
export interface StatusData {
  version: 1;
  /** `<scope>/<接続名>`（scope = common か session 名）。 */
  results: Record<string, StatusRecord>;
}

export const statusKey = (scope: string | undefined, name: string): string => `${scope ?? "common"}/${name}`;

export function parseStatus(raw: unknown): { data: StatusData; problem?: string } {
  const data: StatusData = { version: 1, results: {} };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { data, problem: "形が不正" };
  const r = (raw as Record<string, unknown>).results;
  if (typeof r !== "object" || r === null || Array.isArray(r)) return { data, problem: "results が無い" };
  let dropped = 0;
  for (const [k, v] of Object.entries(r)) {
    const e = v as Partial<StatusRecord> | null;
    if (
      e !== null &&
      typeof e === "object" &&
      typeof e.checkedAt === "string" &&
      RESULTS.includes(e.result as ProbeKind) &&
      typeof e.toolCount === "number" &&
      Array.isArray(e.visibleTools) &&
      typeof e.durationMs === "number" &&
      typeof e.configHash === "string"
    )
      data.results[k] = e as StatusRecord;
    else dropped++;
  }
  return dropped ? { data, problem: `${dropped} 件が不正（捨てた）` } : { data };
}

export interface StatusStore {
  file: JsonFile<StatusData>;
  get(key: string): StatusRecord | undefined;
  /** 残す。toolsCopy が 1 MB を越えれば写しだけ落とす。 */
  put(key: string, rec: StatusRecord): void;
}

export function createStatusStore(stateDir: string, log: (m: string) => void = () => {}): StatusStore {
  const file = createJsonFile<StatusData>(join(stateDir, MCP_STATUS_FILE), parseStatus, () => ({ version: 1, results: {} }), log);
  return {
    file,
    get: (key) => file.load().data.results[key],
    put(key, rec) {
      const { data } = file.load();
      const r = { ...rec };
      if (r.toolsCopy !== undefined && Buffer.byteLength(JSON.stringify(r.toolsCopy)) > TOOLS_COPY_MAX_BYTES) delete r.toolsCopy;
      data.results[key] = r;
      file.write(data);
    },
  };
}
