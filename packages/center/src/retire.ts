import { RETIRE_MIN_PROTOCOL, supportsRetire, type RetireResultReply, type RetireService, type RetireStopped } from "@agent-hand/bantou-protocol";
import type { Logger } from "./log.js";
import type { RemoteManager } from "./remotes.js";
import type { ServerLink } from "./server-link.js";
import { describeServer, hostOf, identityOfReply } from "./server-identity.js";

/** server_retire の結果（tool の返り値）。 */
export interface RetireOutcome {
  ok: true;
  /** retiring = retire_result を受けた。already_retiring = server が既に退役中と答えた（error retiring:true）。 */
  state: "retiring" | "already_retiring";
  server_id: string;
  host?: string;
  user?: string;
  workspace?: string;
  /** 送り先だった peer id（server が止まると消える）。 */
  peer: string;
  /** 止めた cap / worker の数（already_retiring では分からないので無い）。 */
  stopped?: RetireStopped;
  /** server が終了を始める時刻（ISO 8601）。 */
  exit_at?: string;
  exit_code?: number;
  /** host で root が行う後始末（unit 削除 → user 削除 → workspace 削除）。 */
  host_steps?: string[];
  service?: RetireService;
  /** center の記録から消した cap の件数と session。server には何も送っていない。 */
  records_removed: number;
  sessions: string[];
  message: string;
}

/**
 * server を退役させる。
 * 1. server の指定（server_id / host 名 / peer id）を既存の selectPeer で 1 つに決める（曖昧ならエラー）。
 * 2. hello で protocol の版を確かめ、supportsRetire が false なら送らない（旧 server は retire_server に無返信で、無返信を退役済みと見なせないため）。
 * 3. server_id を付けて retire_server を送り、retire_result を待つ。受信できたら peer を退役済みにし（発見から外す）、center の記録（session × server の cap）を消す。
 *    無返信・タイムアウト・error は退役したとは見なさず、記録も消さない。
 */
export async function retireServer(
  deps: { link: ServerLink; remotes: Pick<RemoteManager, "forgetServer">; log: Logger },
  input: { server: string; reason?: string },
): Promise<RetireOutcome> {
  const { link, remotes, log } = deps;
  const peer = await link.selectPeer(input.server);
  const label = describeServer({ ...peer, peerId: peer.id });
  const hello = await link.hello(peer);
  if (hello.type !== "hello_result") {
    throw new Error(
      `server の protocol の版を確認できず、退役を送らない（hello: ${hello.type === "error" ? hello.message : "不明な返信"}）。${label}。この server が退役に未対応（protocol ${RETIRE_MIN_PROTOCOL} 未満）の可能性がある。host で手動で止める`,
    );
  }
  if (!supportsRetire(hello.protocol_version)) {
    throw new Error(`この server は退役に未対応（protocol ${hello.protocol_version ?? "不明"}。退役は ${RETIRE_MIN_PROTOCOL} 以降）。host で手動で止める: ${label}`);
  }
  const ident = { ...identityOfReply(peer), ...identityOfReply(hello) };
  const serverId = ident.server_id;
  if (serverId === undefined) throw new Error(`server_id が分からず、退役を送らない（誤爆の保険に server_id が要る）: ${label}`);

  log(`server 退役を指示: ${label} protocol=${hello.protocol_version}${input.reason ? ` reason=${input.reason}` : ""}`);
  const reply = await link.retireOn(peer, { server_id: serverId, ...(input.reason ? { reason: input.reason } : {}) });
  const who = { server_id: serverId, ...(hostOf({ ...ident, hostname: peer.hostname }) ? { host: hostOf({ ...ident, hostname: peer.hostname }) } : {}), ...(ident.user ? { user: ident.user } : {}), ...(ident.workspace ? { workspace: ident.workspace } : {}) };

  const finish = async (r: Omit<RetireOutcome, "records_removed" | "sessions" | "ok" | "server_id" | "peer">): Promise<RetireOutcome> => {
    link.markRetired(peer.id);
    const gone = await remotes.forgetServer({ server_id: serverId, peerId: peer.id });
    return { ok: true, ...who, peer: peer.id, ...r, records_removed: gone.removed, sessions: gone.sessions };
  };

  if (reply.type === "retire_result") {
    log(`server 退役を受理: ${label} stopped=caps:${reply.stopped.caps}/workers:${reply.stopped.workers} exit_at=${reply.exit_at}`);
    return finish(retireFields(reply));
  }
  if (reply.type === "error" && reply.retiring === true) {
    log(`server は既に退役中: ${label}`);
    return finish({ state: "already_retiring", message: "既に退役中（server は止まっていく途中）。host で消す手順は最初の退役の結果を参照（server が止まった後は host の unit・user・workspace を root で消す）" });
  }
  // 無返信（タイムアウト）・送信失敗・error: 退役したとは見なさない。記録も消さない
  throw new Error(`退役の返信（retire_result）を受け取れなかった: ${reply.type === "error" ? reply.message : "不明な返信"}。退役したとは限らない（server_peers / server_status で確かめる）。${label}`);
}

function retireFields(r: RetireResultReply): Omit<RetireOutcome, "records_removed" | "sessions" | "ok" | "server_id" | "peer"> {
  return {
    state: "retiring",
    stopped: r.stopped,
    exit_at: r.exit_at,
    exit_code: r.exit_code,
    host_steps: r.host_steps,
    ...(r.service ? { service: r.service } : {}),
    message: "退役を受け付けた。server は cap / worker を止めて終了する（再起動しない）。host の後始末は host_steps を root で実行する",
  };
}
