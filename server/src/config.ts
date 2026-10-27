import { readFile } from "node:fs/promises";

export interface Config {
  /** workspace フォルダの絶対パス。 */
  workspace: string;
}

/** config.json を読み込んで検証する。 */
export async function loadConfig(path: string): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    throw new Error(`config を読めない: ${path} (${(e as Error).message})`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`config が JSON として不正: ${path} (${(e as Error).message})`);
  }
  const ws = (data as { workspace?: unknown } | null)?.workspace;
  if (typeof ws !== "string" || ws.length === 0) {
    throw new Error(`config の workspace は必須の文字列: ${path}`);
  }
  return { workspace: ws };
}
