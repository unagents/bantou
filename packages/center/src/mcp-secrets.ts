/**
 * MCP の接続の鍵の保存（`mcp-secrets.json`、mode 0600）。接続の設定（mcp-connections.json）とは別 file。
 * 入れるのは `bantou-center mcp secret` だけ（標準入力か file。引数には書けない）。値は表示・log・error に出さない。
 */
import { join } from "node:path";
import { createJsonFile, own, setOwn, type JsonFile } from "./mcp-json-file.js";

export const MCP_SECRETS_FILE = "mcp-secrets.json";
export const SECRET_NAME_MAX = 100;
/** 名前の形（設計の R-15: 英数字と . _ - の 100 文字以内）。file の読み込みはこの検査だけ。 */
export const SECRET_NAME = new RegExp(`^[A-Za-z0-9._-]{1,${SECRET_NAME_MAX}}$`);
/** 値によくある接頭辞（鍵の値を名前の欄に書き間違えた時に断る）。 */
const VALUE_PREFIX = /^(sk|pk|rk|ak|xox[a-z]?|gh[pousr]|github_pat|glpat|AKIA|ASIA|eyJ|Bearer|Basic|key|token|secret|pass)[-_.]?[A-Za-z0-9]{8,}/i;
export const SECRET_NAME_ERROR = "鍵の名前の形でない（短い識別子にする。鍵の値は標準入力か file で渡す）";
/** session 名の部分で、英字だけ・数字だけの連続がこの長さ以上なら断る。 */
const TAIL_PLAIN_RUN = 20;
/** `<接続名>.<session 名>` の形（session 名は 64 文字まで）。 */
const CONN_SESSION = /^([A-Za-z0-9][A-Za-z0-9_-]{0,31})\.(.+)$/;

/** 名前の形だけの検査（読み込み用。値らしさは見ない）。 */
export function checkSecretNameShape(name: string): string | undefined {
  return SECRET_NAME.test(name) ? undefined : SECRET_NAME_ERROR;
}

/** 文字種（小文字・大文字・数字）が切り替わる回数。乱数らしい文字列ほど多い。 */
function classChanges(run: string): number {
  const cls = (c: string): number => (c >= "0" && c <= "9" ? 0 : c >= "a" && c <= "z" ? 1 : 2);
  let n = 0;
  for (let i = 1; i < run.length; i++) if (cls(run[i]) !== cls(run[i - 1])) n++;
  return n;
}

/**
 * 新しく書く時の鍵の「名前」の検査（値を名前の欄に取り違えて書くのを断る。値は出さない）。形（100 文字以内）に加えて:
 * - 値によくある接頭辞（sk- / ghp_ / eyJ など）で始まる物は断る。
 * - 区切り（. _ -）で分けた各部分の英数字の連続が、16 文字以上で文字種（小文字・大文字・数字）の切り替えが 6 回以上なら乱数らしいので断る。
 * - 連続が 24 文字以上なら断る（ただし `<接続名>.<session 名>` の形の session 名の部分は、長い名前がありうるので長さだけでは断らない）。
 * - `<接続名>.<session 名>` の session 名の部分にも（`.` `_` `-` の直後のどこからでも）、接頭辞・切り替え回数の検査と、英字だけ・数字だけの 20 文字以上の連続の検査を当てる。
 * 名前として通る形の値は事前に区別できないので、これは保証でなく緩和。
 */
export function checkSecretNameNew(name: string): string | undefined {
  if (checkSecretNameShape(name)) return SECRET_NAME_ERROR;
  if (VALUE_PREFIX.test(name)) return SECRET_NAME_ERROR;
  const m = CONN_SESSION.exec(name);
  const head = m ? m[1] : name;
  const tail = m ? m[2] : "";
  // session 名の部分にも同じ値らしさの検査を当てる（先頭にしか当てないと `a.ghp_…` が通る）
  // 区切り（. _ -）の直後ならどこからでも接頭辞を見る（tail が区切りで始まる形も含む）
  for (let i = 0; i < tail.length; i++) if ((i === 0 || "._-".includes(tail[i - 1])) && VALUE_PREFIX.test(tail.slice(i))) return SECRET_NAME_ERROR;
  if (tail && tail.length >= TAIL_PLAIN_RUN) for (const run of tail.match(/[A-Za-z0-9]+/g) ?? []) if (run.length >= TAIL_PLAIN_RUN && /^(?:[A-Za-z]+|[0-9]+)$/.test(run)) return SECRET_NAME_ERROR;
  for (const [part, longOk] of [[head, false], [tail, true]] as const) {
    for (const run of part.match(/[A-Za-z0-9]+/g) ?? []) {
      if (!longOk && run.length >= 24) return SECRET_NAME_ERROR;
      if (run.length >= 16 && classChanges(run) >= 6) return SECRET_NAME_ERROR;
    }
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
      checkSecretNameShape(name) === undefined &&
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
