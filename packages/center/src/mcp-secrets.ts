/**
 * MCP の接続の鍵の保存（`mcp-secrets.json`、mode 0600）。接続の設定（mcp-connections.json）とは別 file。
 * 入れるのは `bantou-center mcp secret` だけ（標準入力か file。引数には書けない）。値は表示・log・error に出さない。
 */
import { join } from "node:path";
import { createJsonFile, type JsonFile } from "./mcp-json-file.js";

export const MCP_SECRETS_FILE = "mcp-secrets.json";
export const SECRET_NAME = /^[A-Za-z0-9._-]{1,100}$/;
export const SECRET_VALUE_MAX = 4096;
const SECRET_VALUE = /^[\x21-\x7E]+$/;

export interface SecretEntry {
  value: string;
  rev: number;
  updatedAt: string;
}
export interface SecretsData {
  version: 1;
  secrets: Record<string, SecretEntry>;
}

/** 値の検査。誤りの文に入力値は含めない。 */
export function checkSecretValue(v: string): string | undefined {
  if (v.length === 0) return "鍵が空";
  if (v.length > SECRET_VALUE_MAX) return `鍵は ${SECRET_VALUE_MAX} 文字以内`;
  if (!SECRET_VALUE.test(v)) return "鍵は空白・制御文字・非 ASCII を含められない";
  return undefined;
}

export function parseSecrets(raw: unknown): { data: SecretsData; problem?: string } {
  const data: SecretsData = { version: 1, secrets: {} };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { data, problem: "形が不正" };
  const s = (raw as Record<string, unknown>).secrets;
  if (typeof s !== "object" || s === null || Array.isArray(s)) return { data, problem: "secrets が無い" };
  let dropped = 0;
  for (const [name, v] of Object.entries(s)) {
    const e = v as Partial<SecretEntry> | null;
    if (
      SECRET_NAME.test(name) &&
      e !== null &&
      typeof e === "object" &&
      typeof e.value === "string" &&
      checkSecretValue(e.value) === undefined &&
      Number.isInteger(e.rev) &&
      typeof e.updatedAt === "string"
    )
      data.secrets[name] = { value: e.value, rev: e.rev as number, updatedAt: e.updatedAt };
    else dropped++;
  }
  return dropped ? { data, problem: `${dropped} 件が不正（捨てた）` } : { data };
}

export interface SecretsStore {
  file: JsonFile<SecretsData>;
  /** 鍵の名前 → 値と rev（無ければ undefined）。 */
  get(name: string): SecretEntry | undefined;
  /** 値を入れる（rev を 1 増やす）。返すのは新しい rev。 */
  set(name: string, value: string, now?: Date): number;
  /** 消す。元から無ければ false。 */
  unset(name: string): boolean;
}

export function createSecretsStore(stateDir: string, log: (m: string) => void = () => {}): SecretsStore {
  const file = createJsonFile<SecretsData>(join(stateDir, MCP_SECRETS_FILE), parseSecrets, () => ({ version: 1, secrets: {} }), log);
  return {
    file,
    get: (name) => file.load().data.secrets[name],
    set(name, value, now = new Date()) {
      const { data, problem } = file.load();
      if (problem) throw new Error("鍵の file が壊れている（手で直すか消してから入れ直す）");
      const rev = (data.secrets[name]?.rev ?? 0) + 1;
      data.secrets[name] = { value, rev, updatedAt: now.toISOString() };
      file.write(data);
      return rev;
    },
    unset(name) {
      const { data, problem } = file.load();
      if (problem) throw new Error("鍵の file が壊れている（手で直すか消してから入れ直す）");
      if (!(name in data.secrets)) return false;
      delete data.secrets[name];
      file.write(data);
      return true;
    },
  };
}
