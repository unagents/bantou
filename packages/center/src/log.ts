import { appendFileSync } from "node:fs";

/**
 * `<ISO> bantou-center: <msg>` 形式で stderr へ 1 行出す。改行は空白に畳む。
 * stdout は MCP の stdio チャネルなので、ログを絶対に出さない。
 */
export const log = (msg: string): void => {
  const line = `${new Date().toISOString()} bantou-center: ${msg.replace(/[\r\n]+/g, " ")}\n`;
  try {
    process.stderr.write(line);
  } catch {
    // stderr が壊れていても（EPIPE 等）center を落とさない
  }
  if (logFile) {
    try {
      appendFileSync(logFile, line);
    } catch {
      // ファイルに書けなくても続行
    }
  }
};

let logFile: string | null = null;

/** log() の出力を追記するファイルを設定する（desktop が読まない時のための記録）。null で解除。 */
export const setLogFile = (path: string | null): void => {
  logFile = path;
};

/** 致命的エラー用の 1 行。stderr 向け。 */
export const fatalLine = (msg: string): string =>
  `${new Date().toISOString()} bantou-center: ${msg.replace(/[\r\n]+/g, " ")}`;

export type Logger = (msg: string) => void;
