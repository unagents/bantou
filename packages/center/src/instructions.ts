import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** center が書いた CLAUDE.md の印（1 行目）。消す時は、この印のあるファイルだけを消す。 */
export const INSTRUCTIONS_MARK = "<!-- bantou: center の設定から生成。手で直しても次の保存で上書きされる -->";

export const INSTRUCTIONS_FILE = "CLAUDE.md";

/** 空白だけ・未指定を「無し」（undefined）にそろえる。 */
export function normalizeInstructions(text: string | undefined): string | undefined {
  return text !== undefined && text.trim() !== "" ? text : undefined;
}

/**
 * session の dir の CLAUDE.md を設定の内容で書く。内容が無ければ消す（center が書いた印のあるファイルだけ。
 * 手で置かれた CLAUDE.md は消さない）。dir が無ければ何もしない。
 */
export async function syncInstructionsFile(dir: string, text: string | undefined): Promise<"written" | "removed" | "kept" | "none"> {
  const file = join(dir, INSTRUCTIONS_FILE);
  const body = normalizeInstructions(text);
  if (body !== undefined) {
    await writeFile(file, `${INSTRUCTIONS_MARK}\n${body.endsWith("\n") ? body : `${body}\n`}`);
    return "written";
  }
  let cur: string;
  try {
    cur = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return "none";
    throw e;
  }
  if (!cur.startsWith(INSTRUCTIONS_MARK)) return "kept";
  await rm(file, { force: true });
  return "removed";
}
