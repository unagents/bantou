/**
 * MCP の接続の設定・鍵・確かめた結果の file（`mcp-connections.json` / `mcp-secrets.json` / `mcp-status.json`）の共通の読み書き。
 *
 * 書き込みは一時 file → rename、mode 0600。状態 dir は新しく作る時だけ 0700（既存の dir の権限は変えない）。
 * 読みは mtime / size / inode が変わった時だけ読み直す（`memory-settings.ts` と同じ規則）。値は log に出さない（理由の種類だけ）。
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

let tmpSeq = 0;

export interface JsonFile<T> {
  readonly path: string;
  /** 現在の内容。file が無ければ empty()。壊れていれば empty() と problem（理由の種類だけ）。 */
  load(): { data: T; problem?: string };
  write(data: T): void;
}

export function createJsonFile<T>(path: string, parse: (raw: unknown) => { data: T; problem?: string }, empty: () => T, log: (m: string) => void = () => {}): JsonFile<T> {
  let cache: { key: string; value: { data: T; problem?: string } } | undefined;
  return {
    path,
    load() {
      let key: string;
      try {
        const st = statSync(path);
        key = `${st.mtimeMs}:${st.size}:${st.ino}`;
      } catch {
        cache = undefined;
        return { data: empty() };
      }
      if (cache?.key === key) return cache.value;
      let value: { data: T; problem?: string };
      try {
        value = parse(JSON.parse(readFileSync(path, "utf8")));
      } catch (e) {
        value = { data: empty(), problem: `読めない（${e instanceof Error ? e.name : "error"}）` };
      }
      if (value.problem) log(`MCP の設定ファイルに問題がある: ${path} ${value.problem}`);
      cache = { key, value };
      return value;
    },
    write(data) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
      cache = undefined;
    },
  };
}

/** 既にある状態 dir の権限が group / other に開いていれば true（警告用。直さない）。 */
export function dirIsWide(dir: string): boolean {
  try {
    return (statSync(dir).mode & 0o077) !== 0;
  } catch {
    return false;
  }
}
