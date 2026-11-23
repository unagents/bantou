/** `<ISO> bantou: <msg>` 形式で標準出力へ 1 行出す。改行は空白に畳む。 */
export const log = (msg: string): void => {
  console.log(`${new Date().toISOString()} bantou: ${msg.replace(/[\r\n]+/g, " ")}`);
};

/** URL の query（?token=...）・fragment・userinfo を伏せる。log に出す URL はこれを通す。 */
export function redactUrl(url: string): string {
  const cut = url.search(/[?#]/);
  const base = cut === -1 ? url : url.slice(0, cut);
  const mark = cut === -1 ? "" : "?***";
  return base.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1***@") + mark;
}

/** 文言の中に url（token 付きの生の値）が入っていたら、伏せた形に置き換える。 */
export function redactIn(text: string, url: string): string {
  return url === "" ? text : text.split(url).join(redactUrl(url));
}

/** 致命的エラー用の 1 行（`<ISO> bantou: <msg>`）。stderr 向け。 */
export const fatalLine = (msg: string): string =>
  `${new Date().toISOString()} bantou: ${msg.replace(/[\r\n]+/g, " ")}`;
