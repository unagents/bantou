import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** 書込ごとに違う tmp 名にする（同じ pid の同時 save が互いの tmp を rename して ENOENT になるのを防ぐ）。 */
let tmpSeq = 0;

/** center の状態ファイル（JSON 配列）。壊れた・無いファイルは空として読み、書込は tmp + rename。 */
export interface JsonListStore<T> {
  load(): Promise<T[]>;
  save(items: T[]): Promise<void>;
}

export function createJsonListStore<T>(path: string, log: (m: string) => void): JsonListStore<T> {
  return {
    async load() {
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
        log(`状態ファイルを読めない（空として扱う）: ${path} ${(e as Error).message}`);
        return [];
      }
      try {
        const v: unknown = JSON.parse(raw);
        if (Array.isArray(v)) return v as T[];
        log(`状態ファイルが配列でない（空として扱う）: ${path}`);
      } catch (e) {
        log(`状態ファイルが JSON として不正（空として扱う）: ${path} ${(e as Error).message}`);
      }
      return [];
    },
    async save(items) {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`;
      await writeFile(tmp, `${JSON.stringify(items, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, path);
    },
  };
}

/** center の設定ファイル（JSON object 1 つ）。壊れた・無いファイルは {} として読み、書込は tmp + rename。 */
export interface JsonObjectStore<T extends object> {
  load(): Promise<T | undefined>;
  save(value: T): Promise<void>;
}

export function createJsonObjectStore<T extends object>(path: string, log: (m: string) => void): JsonObjectStore<T> {
  return {
    async load() {
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        log(`設定ファイルを読めない（無いとして扱う）: ${path} ${(e as Error).message}`);
        return undefined;
      }
      try {
        const v: unknown = JSON.parse(raw);
        if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as T;
        log(`設定ファイルが object でない（無いとして扱う）: ${path}`);
      } catch (e) {
        log(`設定ファイルが JSON として不正（無いとして扱う）: ${path} ${(e as Error).message}`);
      }
      return undefined;
    },
    async save(value) {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`;
      await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, path);
    },
  };
}
