/** `<ISO> bantou: <msg>` 形式で標準出力へ 1 行出す。改行は空白に畳む。 */
export const log = (msg: string): void => {
  console.log(`${new Date().toISOString()} bantou: ${msg.replace(/[\r\n]+/g, " ")}`);
};
