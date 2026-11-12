// Settings file store (design 5.5): JSON, written to a temp file in the same dir, chmod 600, then renamed.

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join, basename } from "node:path";
import type { SettingsStore } from "./store.ts";

/** A missing file reads as `undefined` (= defaults). A file that is not valid JSON also reads as `undefined`. */
export function createFileSettingsStore(path: string): SettingsStore {
  return {
    async read() {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw e;
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return undefined;
      }
    },
    async write(value) {
      const dir = dirname(path);
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
      try {
        await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
        await chmod(tmp, 0o600);
        await rename(tmp, path);
      } catch (e) {
        await rm(tmp, { force: true });
        throw e;
      }
    },
  };
}
