import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** claude の `--settings {"outputStyle":…}` に渡す名前（書き出す style の frontmatter の name と同じ）。 */
export const OUTPUT_STYLE_NAME = "bantou";

/** session のフォルダ配下の、書き出す style ファイル。claude は project の `.claude/output-styles/` から名前で探す。 */
export const outputStyleFile = (projectPath: string): string => join(projectPath, ".claude", "output-styles", `${OUTPUT_STYLE_NAME}.md`);

// 利用者が貼った本文の先頭の frontmatter（`---` … `---`）。name が違うと claude が見つけないので、center のものに置き換える
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/** 書き出す style ファイルの中身。本文の frontmatter は center のものに置き換える。 */
export function outputStyleContent(body: string): string {
  const text = body.replace(FRONTMATTER, "").replace(/^\s*\n/, "");
  return `---\nname: ${OUTPUT_STYLE_NAME}\ndescription: bantou の設定（outputStyle）で指定した出力スタイル\n---\n${text}${text.endsWith("\n") ? "" : "\n"}`;
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
