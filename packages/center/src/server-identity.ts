import { SERVER_ID_PATTERN } from "@agent-hand/bantou-protocol";

/** server が hello_result / status_result で名乗る識別（protocol 1.7.0。全て無いことがある = 旧 server）。 */
export interface ServerIdentity {
  server_id?: string;
  host?: string;
  user?: string;
  workspace?: string;
}

/** peer（発見結果）または記録のうち、server の指し方に使う部分。 */
export interface ServerRef extends ServerIdentity {
  /** 今の到達先（messenger の peer id）。記録では最後に確認した peer id。 */
  peerId?: string;
  /** messenger が報告する host 名（server が host を名乗らない旧 server 用）。 */
  hostname?: string;
  /** messenger 上の名前（全 server で "bantou-server"）。 */
  name?: string;
}

/** 返信から識別を取り出す。形式が合わないものは捨てる（protocol 側の検証を通った値だが、念のため）。 */
export function identityOfReply(r: ServerIdentity): ServerIdentity {
  const out: ServerIdentity = {};
  if (typeof r.server_id === "string" && SERVER_ID_PATTERN.test(r.server_id)) out.server_id = r.server_id;
  if (typeof r.host === "string" && r.host) out.host = r.host;
  if (typeof r.user === "string" && r.user) out.user = r.user;
  if (typeof r.workspace === "string" && r.workspace) out.workspace = r.workspace;
  return out;
}

/** 表示に使う host 名（server が名乗った host、無ければ messenger の hostname）。 */
export const hostOf = (s: ServerRef): string | undefined => s.host ?? s.hostname;

/**
 * 利用者に見せる 1 行。host 名を主にして server_id を添える（server_id が無い旧 server は peer id）。
 * 同じ host に複数いる時に見分けられるよう、user と workspace も付ける。
 */
export function describeServer(s: ServerRef): string {
  const host = hostOf(s) ?? s.name ?? "?";
  const id = s.server_id ?? s.peerId ?? "?";
  const extra = [s.user ? `user=${s.user}` : "", s.workspace ? `workspace=${s.workspace}` : ""].filter(Boolean).join(" ");
  return `${host}(${id})${extra ? ` ${extra}` : ""}`;
}

/** 曖昧な指定のエラー本文。候補は user と workspace 付きで並べる。 */
export function ambiguousServerMessage(sel: string, cands: ServerRef[]): string {
  return `server の指定が曖昧: ${sel} は ${cands.length} 件の server に一致する（誤送信を避けるため送らない）。server_id で指定: ${cands.map(describeServer).join(" / ")}`;
}

/** 同じ server_id を名乗る peer が live に複数いる時のエラー本文。候補は peer id・user・workspace 付き（peer id で指し直せる）。 */
export function duplicateServerIdMessage(serverId: string, cands: ServerRef[]): string {
  return `同じ server_id ${serverId} を名乗る peer が ${cands.length} 件いる（workspace / VM のコピー、または再登録直後の旧 peer id が失効前＝約 60 秒、の疑い）。誤送信を避けるため送らない。peer id で指定: ${cands.map((c) => `${c.peerId ?? "?"}=${describeServer(c)}`).join(" / ")}`;
}

/** 同じ server か（server_id があれば server_id 同士、無ければ peer id）。 */
export function sameServerRef(a: ServerRef, b: ServerRef): boolean {
  if (a.server_id !== undefined && b.server_id !== undefined) return a.server_id === b.server_id;
  return a.peerId !== undefined && a.peerId === b.peerId;
}
