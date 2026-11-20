/**
 * MCP の接続の鍵の保存（`mcp-secrets.json`、mode 0600）。接続の設定（mcp-connections.json）とは別 file。
 * 入れるのは `bantou-center mcp secret` だけ（標準入力か file。引数には書けない）。値は表示・log・error に出さない。
 */
import { join } from "node:path";
import { createJsonFile, own, setOwn, type JsonFile } from "./mcp-json-file.js";

export const MCP_SECRETS_FILE = "mcp-secrets.json";
export const SECRET_NAME_MAX = 64;
export const SECRET_NAME = new RegExp(`^[A-Za-z0-9._-]{1,${SECRET_NAME_MAX}}$`);
/** 値によくある接頭辞（鍵の値を名前の欄に書き間違えた時に断る）。 */
const VALUE_PREFIX = /^(sk|pk|rk|ak|xox[a-z]?|gh[pousr]|github_pat|glpat|AKIA|ASIA|eyJ|Bearer|Basic|key|token|secret|pass)[-_.]?[A-Za-z0-9]{8,}/i;
export const SECRET_NAME_ERROR = "鍵の名前の形でない（短い識別子にする。鍵の値は標準入力か file で渡す）";

/**
 * 鍵の「名前」の検査（値を名前の欄に取り違えて書くのを断る。値は出さない）。
 * 英数字と . _ - の 64 文字以内、値らしい接頭辞（sk- / ghp_ / eyJ など）で始まる物、長い英数字の連続（24 文字以上、
 * または 16 文字以上で英字と数字が混ざる物）は名前として認めない。名前として通る形の値は事前に区別できないので、これは保証でなく緩和。
 */
export function checkSecretName(name: string): string | undefined {
  if (!SECRET_NAME.test(name)) return SECRET_NAME_ERROR;
  if (VALUE_PREFIX.test(name)) return SECRET_NAME_ERROR;
  for (const run of name.match(/[A-Za-z0-9]+/g) ?? []) {
    if (run.length >= 24) return SECRET_NAME_ERROR;
    if (run.length >= 16 && /[A-Za-z]/.test(run) && /[0-9]/.test(run)) return SECRET_NAME_ERROR;
  }
  return undefined;
}
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
      checkSecretName(name) === undefined &&
      e !== null &&
      typeof e === "object" &&
      typeof e.value === "string" &&
      checkSecretValue(e.value) === undefined &&
      Number.isInteger(e.rev) &&
      typeof e.updatedAt === "string"
    )
      setOwn(data.secrets, name, { value: e.value, rev: e.rev as number, updatedAt: e.updatedAt });
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
    get: (name) => own(file.load().data.secrets, name),
    set(name, value, now = new Date()) {
      const { data, problem } = file.load();
      if (problem) throw new Error("鍵の file が壊れている（手で直すか消してから入れ直す）");
      const rev = (own(data.secrets, name)?.rev ?? 0) + 1;
      setOwn(data.secrets, name, { value, rev, updatedAt: now.toISOString() });
      file.write(data);
      return rev;
    },
    unset(name) {
      const { data, problem } = file.load();
      if (problem) throw new Error("鍵の file が壊れている（手で直すか消してから入れ直す）");
      if (!Object.hasOwn(data.secrets, name)) return false;
      delete data.secrets[name];
      file.write(data);
      return true;
    },
  };
}
