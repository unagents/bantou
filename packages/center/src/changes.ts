import {
  AGENT_ID_PATTERN,
  type ChangeInfo,
  type ChangeProgressNotice,
  type ChangeReportNotice,
  type ChangeState,
  type ChangeStatusResultReply,
  type ErrorReply,
  type StepState,
} from "@agent-hand/bantou-protocol";
import type { Logger } from "./log.js";
import type { JsonListStore } from "./store.js";
import type { ServerLink, ServerPeer } from "./server-link.js";
import { describeServer, hostOf, type ServerRef } from "./server-identity.js";
import { serverAllowed } from "./project-settings.js";
import { sessionCapId } from "./center-id.js";
import { WAIT_DEFAULT_SEC, WAIT_MAX_SEC } from "./remotes.js";

/**
 * change（設計書 docs/design/worker-gate-review.md の 4 節）の center 側。master-cap が server に change を登録し、
 * 進みを見て、止め、worker の質問へ返答する。今の remote（cap）の記録・経路（remotes.ts）とは別に持ち、変えない。
 * 通知先の鍵 notify_id は今の cap_id と同じ形（`<center の cap_id>-<session 名>`）で center が付ける。
 */

/** 返答待ちの worker の質問（change_report）。replied_at = change_reply を送った時刻。superseded_at = 返答なしで先へ進んだ時刻。 */
export interface ChangeAsk {
  worker_id: string;
  /** change の steps の 0 始まりの番号。 */
  step: number;
  kind: "ask" | "approve";
  text: string;
  at: string;
  replied_at?: string;
  superseded_at?: string;
}

/** change_progress の最後の 1 件。 */
export interface ChangeProgressRecord {
  step: number;
  change_state: ChangeState;
  step_state: StepState;
  at: string;
  reason?: string;
}

/** center が保存する change の記録（state.json 相当の changes.json）。server の記録の写しは info（最後に change_status で取れた物）。 */
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
  info?: ChangeInfo;
  progress?: ChangeProgressRecord;
  asks: ChangeAsk[];
}

/** 呼び出し側に返す 1 件。 */
export type ChangeView = ChangeRecord & {
  /** 今の change の状態（通知か change_status で分かった最新。未確認は in_progress = 登録直後）。 */
  state: ChangeState;
  /** 返答待ちの質問の数（返答も取り消しも無い ask / approve）。 */
  waiting_reply: number;
  server_label: string;
};

export interface RegisterChangeArgs {
  owner: string;
  change_id: string;
  scope: string[];
  repo: string;
  branch?: string;
  worker_model?: string;
  server?: string;
}

const isOpenAsk = (a: ChangeAsk): boolean => a.replied_at === undefined && a.superseded_at === undefined;

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

/** 通知の本文（master-cap の messenger へ push する）。 */
export function formatChangeReportNotice(n: ChangeReportNotice): string {
  return [`[bantou] change_report change_id=${n.change_id} step=${n.step} worker=${n.worker_id} kind=${n.kind}`, n.text, `返答は change_reply（change_id=${n.change_id} worker_id=${n.worker_id}）`].join("\n");
}

export function formatChangeProgressNotice(n: ChangeProgressNotice): string {
  return [
    `[bantou] change_progress change_id=${n.change_id} step=${n.step} change=${n.change_state} step_state=${n.step_state}${n.reason ? ` reason=${n.reason}` : ""}`,
    "詳しい進みは change_status",
  ].join("\n");
}

export interface ChangeManager {
  /** 保存済みの記録を読み込む。 */
  restore(): Promise<void>;
  /** server に change を登録する。server の error は投げる。再登録（completed / stopped の change）は同じ change_id の記録を置き換える。 */
  register(args: RegisterChangeArgs): Promise<{ change_id: string; server: string; peer: string; host?: string; state: ChangeState; accepted: true; notify_id: string }>;
  /** owner の change の一覧（server へは問い合わせない。最後に分かった状態）。 */
  list(filter: { owner: string; change_id?: string }): ChangeView[];
  /**
   * server へ change_status を送り、記録の写しを更新して返す。change_id 省略時は owner の全ての change（server ごとに 1 回聞き、owner の change だけ返す）。
   * 届かない server の change は error を付けて写しのまま返す。
   */
  status(filter: { owner: string; change_id?: string }): Promise<{ changes: Array<ChangeView & { error?: string }>; boards: Array<{ server: string; board: Record<string, unknown> }> }>;
  /** change を止める（動いている worker を止め、queue の依頼を取り下げる）。 */
  stop(args: { owner: string; change_id: string }): Promise<{ change_id: string; stopped: boolean }>;
  /** worker の質問へ返答する（同じ session で起こし直す依頼が queue に入る）。 */
  reply(args: { owner: string; change_id: string; worker_id: string; text: string }): Promise<{ change_id: string; worker_id: string; accepted: true }>;
  /** change が completed / stopped になる、または返答待ちの質問が出るまで待つ。change_id 省略時は owner の in_progress の change のどれか。timeout なら今の記録を返す。 */
  wait(args: { owner: string; change_id?: string; timeoutSec?: number }): Promise<ChangeView>;
  onChangeReport(n: ChangeReportNotice, fromId?: string): void;
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
  const waiters = new Set<() => void>();
  const wake = (): void => {
    for (const w of [...waiters]) w();
  };
  const persist = async (): Promise<void> => {
    try {
      await store.save(records);
    } catch (e) {
      log(`change の記録を保存できない: ${errMsg(e)}`);
    }
  };

  const stateOf = (r: ChangeRecord): ChangeState => r.progress?.change_state ?? r.info?.state ?? "in_progress";
  const viewOf = (r: ChangeRecord): ChangeView => ({
    ...r,
    asks: r.asks.map((a) => ({ ...a })),
    state: stateOf(r),
    waiting_reply: r.asks.filter(isOpenAsk).length,
    server_label: describeServer(refOf(r)),
  });

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

  /** 通知から記録を決める。notify_id と change_id が一致するもののうち、送り元の server に合う物。 */
  const resolve = (notify_id: string, change_id: string, fromId?: string): ChangeRecord | undefined => {
    const cands = records.filter((r) => r.notify_id === notify_id && r.change_id === change_id);
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

  const apply = (r: ChangeRecord, info: ChangeInfo): void => {
    r.info = info;
    // status の方が新しい（通知より後に取った）ので、通知の写しは捨てる
    delete r.progress;
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
        asks: [],
      };
      // 受け付けた = 前の記録（同じ server の同じ change_id）は置き換える
      const same = (x: ChangeRecord): boolean =>
        x.session === a.owner && x.change_id === a.change_id && (rec.server_id !== undefined ? x.server_id === rec.server_id : x.peer === rec.peer);
      for (let i = records.length - 1; i >= 0; i--) if (same(records[i])) records.splice(i, 1);
      records.push(rec);
      await persist();
      wake();
      log(`change 登録: ${rec.change_id} session=${rec.session} server=${describeServer(refOf(rec))} steps=${rec.scope.length}`);
      return { change_id: reply.change_id, server: peer.server_id ?? peer.id, peer: peer.id, ...(host ? { host } : {}), state: reply.state, accepted: true as const, notify_id };
    },

    list({ owner, change_id }) {
      return records.filter((r) => r.session === owner && (change_id === undefined || r.change_id === change_id)).map(viewOf);
    },

    async status({ owner, change_id }) {
      const targets = records.filter((r) => r.session === owner && (change_id === undefined || r.change_id === change_id));
      if (change_id !== undefined && targets.length === 0) throw new Error(`未定義の change: ${change_id}`);
      const byServer = new Map<string, ChangeRecord[]>();
      for (const r of targets) byServer.set(r.server_id ?? r.peer ?? r.serverName, [...(byServer.get(r.server_id ?? r.peer ?? r.serverName) ?? []), r]);
      const errors = new Map<ChangeRecord, string>();
      const boards: Array<{ server: string; board: Record<string, unknown> }> = [];
      for (const [key, group] of byServer) {
        try {
          const peer = await findPeer(group[0]);
          const reply: ChangeStatusResultReply = unwrap(await link.changeStatusOn(peer, change_id !== undefined ? { change_id } : {}));
          for (const r of group) {
            const info = reply.changes.find((c) => c.change_id === r.change_id);
            if (info) apply(r, info);
            else errors.set(r, "server がこの change を知らない");
          }
          if (reply.board) boards.push({ server: key, board: reply.board });
        } catch (e) {
          for (const r of group) errors.set(r, errMsg(e));
        }
      }
      await persist();
      wake();
      return { changes: targets.map((r) => ({ ...viewOf(r), ...(errors.has(r) ? { error: errors.get(r)! } : {}) })), boards };
    },

    async stop({ owner, change_id }) {
      const r = pickOne(owner, change_id);
      const peer = await findPeer(r);
      const reply = unwrap(await link.stopChangeOn(peer, { change_id }));
      log(`change 停止: ${change_id} stopped=${reply.stopped}`);
      return { change_id: reply.change_id, stopped: reply.stopped };
    },

    async reply({ owner, change_id, worker_id, text }) {
      if (!AGENT_ID_PATTERN.test(worker_id)) throw new Error("worker_id は英数字と _ - のみ");
      if (text.length === 0 || text.includes("\0")) throw new Error("text が不正（空・NUL 文字は不可）");
      const r = pickOne(owner, change_id);
      const peer = await findPeer(r);
      // 返答を送った時点で返答待ちだった質問だけを対象にする
      const targets = r.asks.filter((a) => a.worker_id === worker_id && isOpenAsk(a));
      const reply = unwrap(await link.changeReplyOn(peer, { change_id, worker_id, text }));
      const at = new Date((opts.now ?? Date.now)()).toISOString();
      for (const a of targets) if (isOpenAsk(a)) a.replied_at = at;
      await persist();
      wake();
      log(`change_reply: ${change_id} worker=${worker_id}`);
      return { change_id: reply.change_id, worker_id: reply.worker_id, accepted: true as const };
    },

    async wait({ owner, change_id, timeoutSec }) {
      const sec = Math.min(Math.max(timeoutSec ?? WAIT_DEFAULT_SEC, 1), WAIT_MAX_SEC);
      let targets: ChangeRecord[];
      if (change_id !== undefined) targets = mine(owner, change_id);
      else targets = records.filter((r) => r.session === owner && stateOf(r) === "in_progress");
      if (targets.length === 0) throw new Error(change_id !== undefined ? `未定義の change: ${change_id}` : "in_progress の change が無い");
      const has = (t: ChangeRecord): boolean => records.includes(t);
      const check = (): ChangeView | undefined => {
        for (const t of targets) {
          if (!has(t)) continue;
          const s = stateOf(t);
          if (s === "completed" || s === "stopped" || t.asks.some(isOpenAsk)) return viewOf(t);
        }
        return undefined;
      };
      const first = check();
      if (first) return first;
      return new Promise<ChangeView>((res, rej) => {
        const done = (v: ChangeView | Error): void => {
          clearTimeout(timer);
          waiters.delete(w);
          v instanceof Error ? rej(v) : res(v);
        };
        const w = (): void => {
          const v = check();
          if (v) done(v);
          else if (targets.every((t) => !has(t))) done(new Error("待っていた change の記録が置き換わった・消えた"));
        };
        const timer = setTimeout(() => {
          const v = check();
          const alive = targets.find((t) => has(t));
          if (v) done(v);
          else if (alive) done(viewOf(alive));
          else done(new Error("待っていた change の記録が置き換わった・消えた"));
        }, sec * 1000);
        waiters.add(w);
      });
    },

    onChangeReport(n, fromId) {
      const r = resolve(n.notify_id, n.change_id, fromId);
      if (!r) {
        log(`change_report を捨てる（記録が無い）: notify_id=${n.notify_id} change=${n.change_id} worker=${n.worker_id}`);
        return;
      }
      // 同じ worker の前の未返答の質問は、返答なしで先へ進んだので解消
      for (const a of r.asks) if (a.worker_id === n.worker_id && isOpenAsk(a)) a.superseded_at = n.at;
      r.asks.push({ worker_id: n.worker_id, step: n.step, kind: n.kind, text: n.text, at: n.at });
      void persist();
      wake();
      push(r, formatChangeReportNotice(n), "change_report");
    },

    onChangeProgress(n, fromId) {
      const r = resolve(n.notify_id, n.change_id, fromId);
      if (!r) {
        log(`change_progress を捨てる（記録が無い）: notify_id=${n.notify_id} change=${n.change_id}`);
        return;
      }
      r.progress = { step: n.step, change_state: n.change_state, step_state: n.step_state, at: n.at, ...(n.reason !== undefined ? { reason: n.reason } : {}) };
      // change が終わった（completed / stopped）ので、未返答の質問は返答先が無い
      for (const a of r.asks) if (isOpenAsk(a)) a.superseded_at = n.at;
      void persist();
      wake();
      push(r, formatChangeProgressNotice(n), "change_progress");
    },
  };
}
