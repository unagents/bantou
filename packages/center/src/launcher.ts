/**
 * center を起動した所（desktop の sidecar の起動元）の見分け。
 *
 * desktop は sidecar の center を起動する時、起動ごとの乱数の鍵を環境変数 `BANTOU_CENTER_LAUNCHER_KEY` で渡し、自分の sidecar へ
 * 繋ぐ時だけ header `X-Bantou-Launcher: <鍵>` を付ける。center は /mcp の MCP session を作る時（initialize）に鍵を比べ、一致した
 * session だけを起動元として扱う（外部記憶 memory・追加の MCP の server mcpServers の読み書きができる）。
 * 別 host の center に繋いでいる desktop（貼り付けた接続設定。鍵を持たない）・web・他の MCP の呼び出し元は token が合っていても起動元ではない。
 * stdio の center は起動元（stdin / stdout の相手）だけが呼べるので起動元として扱う。
 * 鍵は session の子 process には渡さない（remote-control.ts が env から消す）。
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const LAUNCHER_KEY_ENV = "BANTOU_CENTER_LAUNCHER_KEY";
export const LAUNCHER_HEADER = "x-bantou-launcher";
/** 鍵の最短の長さ（短い鍵は無いものとして扱う）。 */
export const LAUNCHER_KEY_MIN = 16;

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

/** header の値が鍵と一致するか（定時間比較）。鍵が無い・短い時は常に false。 */
export function launcherMatches(header: string | string[] | undefined, key: string | undefined): boolean {
  if (key === undefined || key.length < LAUNCHER_KEY_MIN) return false;
  const h = h0(header);
  if (typeof h !== "string" || h === "") return false;
  return timingSafeEqual(digest(h), digest(key));
}

const h0 = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
