import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** claude の `--settings {"outputStyle":…}` に渡す名前（書き出す style の frontmatter の name と同じ）。 */
export const OUTPUT_STYLE_NAME = "bantou";

/** session のフォルダ配下の、書き出す style ファイル。claude は project の `.claude/output-styles/` から名前で探す。 */
export const outputStyleFile = (projectPath: string): string => join(projectPath, ".claude", "output-styles", `${OUTPUT_STYLE_NAME}.md`);

// 利用者が貼った本文の先頭の frontmatter（`---` … `---`）
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const DEFAULT_DESCRIPTION = "bantou の設定（outputStyle）で指定した出力スタイル";

/**
 * 書き出す style ファイルの中身。frontmatter の `name` は center のもの（claude は名前で探す）に差し替え、
 * 他の key（`description`、`keep-coding-instructions` など claude が読むもの）はそのまま残す。
 * frontmatter が無ければ name と description だけ付ける。
 */
export function outputStyleContent(body: string): string {
  const m = FRONTMATTER.exec(body);
  const text = body.slice(m ? m[0].length : 0).replace(/^\s*\n/, "");
  const kept = (m?.[1] ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !/^name\s*:/.test(line));
  if (!kept.some((line) => /^description\s*:/.test(line))) kept.push(`description: ${DEFAULT_DESCRIPTION}`);
  return `---\nname: ${OUTPUT_STYLE_NAME}\n${kept.join("\n")}\n---\n${text}${text.endsWith("\n") ? "" : "\n"}`;
}

/**
 * session の起動前に style ファイルを揃える。本文があれば書いて true、無ければ古いファイルを消して false。
 * 書けない時は投げる（呼ぶ側で起動を止めずに log に出す）。
 */
export function syncOutputStyleSync(projectPath: string, body: string): boolean {
  const file = outputStyleFile(projectPath);
  if (!body) {
    rmSync(file, { force: true });
    return false;
  }
  mkdirSync(join(projectPath, ".claude", "output-styles"), { recursive: true });
  writeFileSync(file, outputStyleContent(body));
  return true;
}
