/**
 * `<ISO> bantou-center: <msg>` 形式で stderr へ 1 行出す。改行は空白に畳む。
 * stdout は MCP の stdio チャネルなので、ログを絶対に出さない。
 */
export const log = (msg: string): void => {
  process.stderr.write(`${new Date().toISOString()} bantou-center: ${msg.replace(/[\r\n]+/g, " ")}\n`);
};

/** 致命的エラー用の 1 行。stderr 向け。 */
export const fatalLine = (msg: string): string =>
  `${new Date().toISOString()} bantou-center: ${msg.replace(/[\r\n]+/g, " ")}`;

export type Logger = (msg: string) => void;
