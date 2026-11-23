import {
  AGENT_ID_PATTERN,
  type ChangeProgressNotice,
  type ChangeState,
  type ErrorReply,
  type WorkerReportNotice,
} from "@agent-hand/bantou-protocol";
import type { Logger } from "./log.js";
import type { JsonListStore } from "./store.js";
import type { ServerLink, ServerPeer } from "./server-link.js";
import { describeServer, hostOf, type ServerRef } from "./server-identity.js";
import { serverAllowed } from "./project-settings.js";
import { sessionCapId } from "./center-id.js";

/**
 * change（設計書 docs/design/worker-gate-review.md）の center 側。master-cap が server に change を登録する。
 * change の worker への返答（worker_reply）と停止（worker_stop）は、今の tool に change_id を足して通す（この記録で server を引く）。
 * 一覧・進み・待ちは持たない（master-cap が openspec-mcp で見る）。今の remote（cap）の記録・経路（remotes.ts）とは別に持ち、変えない。
 * 通知先の鍵 notify_id は今の cap_id と同じ形（`<center の cap_id>-<session 名>`）で center が付ける。
 */

/** center が保存する change の記録（changes.json）。どの server の change か・どの session の物かを引くための物。 */
export interface ChangeRecord {
  change_id: string;
  /** 登録した master-cap の session。 */
  session: string;
  /** register_change の notify_id（通知先の鍵）。 */
  notify_id: string;
  server_id?: string;
  /** 今の到達先（peer id）。 */
  peer?: string;
  serverName: string;
  serverHost?: string;
  scope: string[];
  repo: string;
  branch?: string;
  worker_model?: string;
  registered_at: string;
}

export interface RegisterChangeArgs {
  owner: string;
  change_id: string;
  scope: string[];
  repo: string;
  branch?: string;
  worker_model?: string;
  server?: string;
}

const refOf = (r: ChangeRecord): ServerRef => ({
  ...(r.server_id !== undefined ? { server_id: r.server_id } : {}),
  ...(r.peer !== undefined ? { peerId: r.peer } : {}),
  ...(r.serverHost ? { host: r.serverHost } : {}),
  name: r.serverName,
});

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** server の error 返信を投げる（呼び出し側の tool が isError にする）。 */
function unwrap<T extends { type: string }>(reply: T | ErrorReply): T {
  if (reply.type === "error") throw new Error((reply as ErrorReply).message);
  return reply as T;
}

/** 通知の本文（master-cap の messenger へ push する）。cap の worker_report の通知（remotes.ts）と同じ形。 */
export function formatChangeReportNotice(n: WorkerReportNotice): string {
  return [
    `[bantou] worker_report change_id=${n.change_id} worker=${n.worker_id} kind=${n.kind}`,
    n.text,
    `返答: worker_reply(change_id="${n.change_id}", worker_id="${n.worker_id}", text)`,
  ].join("\n");
}

export function formatChangeProgressNotice(n: ChangeProgressNotice): string {
  return `[bantou] change_progress change_id=${n.change_id} step=${n.step} change=${n.change_state} step_state=${n.step_state}${n.reason ? ` reason=${n.reason}` : ""}`;
}

export interface ChangeManager {
  /** 保存済みの記録を読み込む。 */
  restore(): Promise<void>;
  /** server に change を登録する。server の error は投げる。再登録（completed / stopped の change）は同じ change_id の記録を置き換える。 */
  register(args: RegisterChangeArgs): Promise<{ change_id: string; server: string; peer: string; host?: string; state: ChangeState; accepted: true; notify_id: string }>;
  /** change の worker へ返答する（今の worker_reply を change_id で通す。同じ session で起こし直す依頼が server の queue に入る）。 */
  workerReply(args: { owner: string; change_id: string; worker_id: string; text: string }): Promise<{ change_id: string; server: string; worker_id: string; accepted: true }>;
  /** change の worker を止める（今の worker_stop を change_id で通す。server が step と change を「止められた」にする）。 */
  workerStop(args: { owner: string; change_id: string; worker_id: string }): Promise<{ change_id: string; server: string; worker_id: string; stopped: boolean }>;
  /** change の worker の質問（worker_report の ask / approve。change_id つき）を master-cap へ push する。 */
  onWorkerReport(n: WorkerReportNotice, fromId?: string): void;
  onChangeProgress(n: ChangeProgressNotice, fromId?: string): void;
}

export function createChangeManager(opts: {
  link: ServerLink;
  store: JsonListStore<ChangeRecord>;
  log: Logger;
  /** center ごとに固定の cap_id 接頭（`c-<center の安定 id>`）。notify_id = `<capId>-<session>`。 */
  capId: string;
  /** session が使ってよい server の指定（host 名か server_id）。undefined = 全部。 */
  serversOf?: (owner: string) => string[] | undefined;
  /** owner の session へ text を送る。省けば通知しない。 */
  notify?: (owner: string, text: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  now?: () => number;
}): ChangeManager {
  const { link, store, log } = opts;
  const records: ChangeRecord[] = [];
  const persist = async (): Promise<void> => {
    try {
      await store.save(records);
    } catch (e) {
      log(`change の記録を保存できない: ${errMsg(e)}`);
    }
  };

  const livePeers = (): Promise<ServerPeer[]> => (link.identifiedPeers ? link.identifiedPeers() : link.peers());

  const inRange = (allowed: string[] | undefined, p: ServerPeer): boolean =>
    serverAllowed(allowed, { ...(p.server_id !== undefined ? { server_id: p.server_id } : {}), ...(hostOf(p) ? { host: hostOf(p)! } : {}) });

  /** 登録先の server を決める。session の servers の範囲があれば範囲内だけ。 */
  const selectPeerFor = async (owner: string, sel: string | undefined): Promise<ServerPeer> => {
    const allowed = opts.serversOf?.(owner);
    const notAllowed = (what: string): Error =>
      new Error(`この session の servers に無い: ${what}（session=${owner}, servers=[${(allowed ?? []).join(", ")}]${allowed?.length === 0 ? "。空 = どの server も使わない" : ""}）`);
    if (allowed === undefined) return link.selectPeer(sel);
    if (sel === undefined) {
      const ok = (await livePeers()).filter((p) => inRange(allowed, p));
      if (ok.length === 0) throw notAllowed("使える server が無い");
      return link.selectPeer(ok[0].server_id ?? ok[0].id);
    }
    const p = await link.selectPeer(sel);
    if (!inRange(allowed, p)) throw notAllowed(describeServer({ ...p, peerId: p.id }));
    return p;
  };

  /** 記録の server を今の peer から探す（server_id → 到達先の peer id）。 */
  const findPeer = async (r: ChangeRecord): Promise<ServerPeer> => {
    const peers = await livePeers();
    const hit =
      r.server_id !== undefined
        ? (peers.find((p) => p.server_id === r.server_id) ?? peers.find((p) => p.server_id === undefined && r.peer !== undefined && p.id === r.peer))
        : peers.find((p) => p.id === r.peer);
    if (!hit) throw new Error(`server が見つからない: ${describeServer(refOf(r))}`);
    if (r.peer !== hit.id) {
      r.peer = hit.id;
      void persist();
    }
    return hit;
  };

  const mine = (owner: string, change_id: string): ChangeRecord[] => records.filter((r) => r.session === owner && r.change_id === change_id);
  const pickOne = (owner: string, change_id: string): ChangeRecord => {
    const c = mine(owner, change_id);
    if (c.length === 0) throw new Error(`未定義の change: ${change_id}`);
    if (c.length > 1) throw new Error(`change ${change_id} は複数の server にある（${c.map((r) => describeServer(refOf(r))).join(" / ")}）`);
    return c[0];
  };

  /** 通知から記録を決める。change_id が一致するもののうち、送り元の server に合う物（change は server 上で change_id が鍵）。 */
  const resolve = (change_id: string, fromId?: string): ChangeRecord | undefined => {
    const cands = records.filter((r) => r.change_id === change_id);
    if (cands.length === 0) return undefined;
    if (fromId === undefined) return cands.length === 1 ? cands[0] : undefined;
    const ident = link.identityOf?.(fromId);
    const hit =
      (ident?.server_id !== undefined ? cands.find((r) => r.server_id === ident.server_id) : undefined) ?? cands.find((r) => r.peer === fromId);
    const rec = hit ?? (cands.length === 1 ? cands[0] : undefined);
    if (rec && ident?.server_id !== undefined && rec.server_id !== undefined && rec.server_id !== ident.server_id) return undefined;
    if (rec && rec.peer !== fromId) rec.peer = fromId;
    return rec;
  };

  const push = (r: ChangeRecord, text: string, what: string): void => {
    if (!opts.notify) return;
    void opts
      .notify(r.session, text)
      .catch((e: unknown) => ({ ok: false as const, reason: errMsg(e) }))
      .then((res) => {
        if (res.ok) log(`${what} 通知: change=${r.change_id} owner=${r.session}`);
        else log(`${what} を通知できない: change=${r.change_id} owner=${r.session} ${res.reason}`);
      });
  };

  return {
    async restore() {
      records.splice(0, records.length, ...(await store.load()));
      log(`change の記録を復元: ${records.length} 件`);
    },

    async register(a) {
      if (!AGENT_ID_PATTERN.test(a.change_id)) throw new Error("change_id は英数字と _ - のみ");
      const notify_id = sessionCapId(opts.capId, a.owner);
      // 同じ change の再登録は、前の登録の server へ送る（server 指定が無い時）。登録済みかの判断（in_progress の間は断る）は server がする
      const prev = mine(a.owner, a.change_id);
      const sel = a.server;
      let peer: ServerPeer;
      if (sel === undefined && prev.length === 1) peer = await findPeer(prev[0]);
      else peer = await selectPeerFor(a.owner, sel);
      const reply = unwrap(
        await link.registerChangeOn(peer, {
          change_id: a.change_id,
          scope: a.scope,
          repo: a.repo,
          ...(a.branch !== undefined ? { branch: a.branch } : {}),
          ...(a.worker_model !== undefined ? { worker_model: a.worker_model } : {}),
          notify_id,
        }),
      );
      const host = hostOf(peer);
      const rec: ChangeRecord = {
        change_id: a.change_id,
        session: a.owner,
        notify_id,
        ...(peer.server_id !== undefined ? { server_id: peer.server_id } : {}),
        peer: peer.id,
        serverName: peer.name,
        ...(host ? { serverHost: host } : {}),
        scope: a.scope,
        repo: a.repo,
        ...(a.branch !== undefined ? { branch: a.branch } : {}),
        ...(a.worker_model !== undefined ? { worker_model: a.worker_model } : {}),
        registered_at: new Date((opts.now ?? Date.now)()).toISOString(),
      };
      // 受け付けた = 前の記録（同じ server の同じ change_id）は置き換える
      const same = (x: ChangeRecord): boolean =>
        x.session === a.owner && x.change_id === a.change_id && (rec.server_id !== undefined ? x.server_id === rec.server_id : x.peer === rec.peer);
      for (let i = records.length - 1; i >= 0; i--) if (same(records[i])) records.splice(i, 1);
      records.push(rec);
      await persist();
      log(`change 登録: ${rec.change_id} session=${rec.session} server=${describeServer(refOf(rec))} steps=${rec.scope.length}`);
      return { change_id: reply.change_id, server: peer.server_id ?? peer.id, peer: peer.id, ...(host ? { host } : {}), state: reply.state, accepted: true as const, notify_id };
    },

    async workerReply({ owner, change_id, worker_id, text }) {
      if (!AGENT_ID_PATTERN.test(worker_id)) throw new Error("worker_id は英数字と _ - のみ");
      if (text.length === 0 || text.includes("\0")) throw new Error("text が不正（空・NUL 文字は不可）");
      const r = pickOne(owner, change_id);
      const peer = await findPeer(r);
      const blocked = link.gate?.(peer, "worker_reply");
      if (blocked) throw new Error(blocked.message);
      const reply = unwrap(await link.workerReplyOn(peer, { change_id, worker_id, text }));
      log(`change worker_reply: ${change_id} worker=${worker_id}`);
      return { change_id, server: peer.server_id ?? peer.id, worker_id: reply.worker_id, accepted: true as const };
    },

    async workerStop({ owner, change_id, worker_id }) {
      if (!AGENT_ID_PATTERN.test(worker_id)) throw new Error("worker_id は英数字と _ - のみ");
      const r = pickOne(owner, change_id);
      const peer = await findPeer(r);
      const blocked = link.gate?.(peer, "worker_stop");
      if (blocked) throw new Error(blocked.message);
      const reply = unwrap(await link.workerStopOn(peer, { change_id, worker_id }));
      log(`change worker_stop: ${change_id} worker=${worker_id} stopped=${reply.stopped}`);
      return { change_id, server: peer.server_id ?? peer.id, worker_id: reply.worker_id, stopped: reply.stopped };
    },

    onWorkerReport(n, fromId) {
      const r = n.change_id !== undefined ? resolve(n.change_id, fromId) : undefined;
      if (!r) {
        log(`worker_report を捨てる（change の記録が無い）: change=${n.change_id ?? "-"} worker=${n.worker_id}`);
        return;
      }
      push(r, formatChangeReportNotice(n), "worker_report");
    },

    onChangeProgress(n, fromId) {
      const r = resolve(n.change_id, fromId);
      if (!r) {
        log(`change_progress を捨てる（記録が無い）: notify_id=${n.notify_id} change=${n.change_id}`);
        return;
      }
      push(r, formatChangeProgressNotice(n), "change_progress");
    },
  };
}
