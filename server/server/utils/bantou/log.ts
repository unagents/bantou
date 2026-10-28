/** `<ISO> bantou: <msg>` 形式で標準出力へ 1 行出す。改行は空白に畳む。 */
export const log = (msg: string): void => {
  console.log(`${new Date().toISOString()} bantou: ${msg.replace(/[\r\n]+/g, " ")}`);
};

/** 致命的エラー用の 1 行（`<ISO> bantou: <msg>`）。stderr 向け。 */
export const fatalLine = (msg: string): string =>
  `${new Date().toISOString()} bantou: ${msg.replace(/[\r\n]+/g, " ")}`;
