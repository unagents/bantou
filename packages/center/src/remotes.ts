import { z } from "zod";
import { AGENT_ID_PATTERN, MODEL_PATTERN, type CapResultReply, type ErrorReply, type StatusReply } from "@agent-hand/bantou-protocol";
import type { ActivityStore, RemoteActivity } from "./activity.js";
import { loadConfigSync, type ServerConfig } from "./config.js";
import type { Logger } from "./log.js";
import type { ServerLink, ServerPeer } from "./server-link.js";
import type { JsonListStore } from "./store.js";

/** remote の呼び出し元（master-cap の session 名）を運ぶ HTTP header。 */
export const OWNER_HEADER = "x-bantou-session";
/** header の代わりに URL query で渡す時の名前。 */
export const OWNER_QUERY = "session";

export const OWNER_PATTERN = /^[A-Za-z0-9_-]+$/;
/** 保存・返却する結果テキストの上限。 */
const RESULT_MAX = 8000;
/** 履歴に残す prompt の先頭の長さ。 */
export const PROMPT_HEAD_MAX = 200;
/** 履歴の最大件数（古い完了済みから捨てる。未完了の指示は捨てない）。 */
export const HISTORY_MAX = 200;
/** 通知に載せる指示の先頭の長さ。 */
const NOTIFY_PROMPT_MAX = 80;

/** unknown = server に届かない・status も取れず、cap の状態が分からない（次に status が取れた時に running / done に戻る）。 */
export type RemoteState = "running" | "done" | "failed" | "unknown";

/** cap_result を受けた後、次の activity を待つ猶予（ms）。server の activity 通知は 5 秒ごとなので 3 回分。超えたら status で判定する。 */
export const SETTLE_GRACE_MS = 15_000;
/** status で追従する間隔（ms）。unknown の再試行・再起動後や cap 再開中の追従。 */
export const PROBE_POLL_MS = 15_000;

/** 履歴: session から送った指示。done_at が無い間は未完了。 */
export interface InstructionEntry {
  type: "instruction";
  at: string;
  /** 指示を送った session 名。 */
  owner: string;
  /** prompt の先頭（PROMPT_HEAD_MAX 文字）。 */
  prompt: string;
  /** 完了にした時刻（cap が idle で worker が無くなった時点）。 */
  done_at?: string;
  /** 完了通知を owner の session へ送れた時刻。 */
  notified_at?: string;
  /** 完了通知を送れなかった理由（または送らなかった理由）。 */
  notify_error?: string;
}

/** 履歴: server から届いた cap_result（または失敗の error 返信）。 */
export interface ResultEntry {
  type: "result";
  at: string;
  ok: boolean;
  /** 結果の本文。RESULT_MAX で切る。 */
  text: string;
  error?: string;
}

export type HistoryEntry = InstructionEntry | ResultEntry;

/**
 * center が保持する「server の cap」の記録。server ごとに 1 件、remote_id = cap_id（center ごとに固定）。
 * メモリ + 状態ファイル。
 */
export interface RemoteRecord {
  remote_id: string;
  /** 最後に使った server の peer id（peer id は再登録で変わるので、server は serverName / serverHost でも探す）。 */
  server: string;
  serverName: string;
  serverHost?: string;
  state: RemoteState;
  /** cap を作った時（最初の kick_cap）に渡したモデル。渡していなければ無い。 */
  model?: string;
  /** cap を作った時に渡した worker の既定モデル。 */
  worker_model?: string;
  createdAt: string;
  finishedAt?: string;
  /** 最新の cap_result の本文。 */
  result?: string;
  /** 最新の失敗。成功の結果で消える。 */
  error?: string;
  /** 指示と結果の履歴（古い順）。 */
  history: HistoryEntry[];
  /** 旧形式（作業ごとの cap）の記録。一覧に出すだけで、指示は送らない・通知しない。delete で止めて消せる。 */
  legacy?: true;
  /** 旧形式の owner。 */
  owner?: string;
}

/** remote_list が返す 1 件。通知がまだ無ければ activity は無い。 */
export type RemoteView = Omit<RemoteRecord, "owner"> & { owners: string[]; activity?: RemoteActivity };

/** 通知に載せる result の先頭の長さ。 */
export const NOTIFY_RESULT_MAX = 500;
/** remote_wait の既定・上限（秒）。 */
export const WAIT_DEFAULT_SEC = 600;
export const WAIT_MAX_SEC = 1800;

const serverArg = z.string().min(1).optional().describe("server の peer id（一致しなければ名前）。省略時は protocol bantou で発見した先頭");

export const remoteWaitSchema = {
  remote_id: z.string().regex(AGENT_ID_PATTERN, "英数字と _ - のみ").optional().describe("待つ cap。省略時は owner の未完了の指示がある cap のどれか（最初に終わったもの）"),
  server: serverArg.describe("cap のある server（複数の server に同じ remote_id がある時の絞り込み）"),
  timeout_sec: z.number().int().min(1).max(WAIT_MAX_SEC).optional().describe(`待つ秒数。既定 ${WAIT_DEFAULT_SEC}、上限 ${WAIT_MAX_SEC}。超えたら state=running のまま返す`),
};

/** 通知の本文を作る。 */
export function formatDoneNotice(r: { remote_id: string; state: string; result?: string; error?: string; instructions?: string[] }): string {
  const head = r.result === undefined ? "" : r.result.length > NOTIFY_RESULT_MAX ? `${r.result.slice(0, NOTIFY_RESULT_MAX)}…(省略。全文は remote_list)` : r.result;
  return [
    `[bantou] remote 完了 remote_id=${r.remote_id} state=${r.state}`,
    ...(r.instructions?.length ? [`指示: ${r.instructions.map((p) => (p.length > NOTIFY_PROMPT_MAX ? `${p.slice(0, NOTIFY_PROMPT_MAX)}…` : p)).join(" / ")}`] : []),
    `result: ${head}`,
    ...(r.error ? [`error: ${r.error}`] : []),
  ].join("\n");
}

const modelArg = (what: string) =>
  z.string().regex(MODEL_PATTERN, "英数字と . _ [ ] - のみ（先頭は - 不可）").optional().describe(what);

/** remote_send（別名 remote_create）の入力。model / worker_model の既定は config の servers[]（送信のたびに読み直す）。 */
export const remoteSendSchema = {
  prompt: z.string().min(1).refine((s) => !s.includes("\0"), { message: "NUL 文字を含められない" }).describe("server の remote-cap への次の指示。worker ごとにモデルを変えたい時は、prompt の中で cap に worker_start の model を指定させる"),
  server: serverArg,
  model: modelArg("cap のモデル（--model）。cap を最初に作る時だけ使う。cap が既にあれば無視する（返り値に model_ignored）。省略時は config servers[].model"),
  worker_model: modelArg("この指示で cap が起動する worker の既定モデル（worker_start に model が無い時に使う）。cap が既にあっても送り、server が cap の既定として記憶する。省略時、新規の cap は config servers[].workerModel、既存の cap は送らない（server の記憶のまま）"),
};
/** 互換: remote_create の入力は remote_send と同じ。 */
export const remoteCreateSchema = remoteSendSchema;

export interface RemoteSendResult {
  remote_id: string;
  server: string;
  serverName: string;
  state: RemoteState;
  /** この指示で cap を作った（server に cap が無く、最初の kick_cap を送った）。 */
  created: boolean;
  model?: string;
  worker_model?: string;
  /** cap が既存で、指定された model を使わなかった。 */
  model_ignored?: true;
  note?: string;
}

export interface RemoteManager {
  /**
   * 保存済みの記録を読み込む。running と未完了の指示はそのまま復元し、server の status で cap と worker の状態を取り直して追従する
   * （取れなければ unknown。再起動後に届く cap_result は applyLateReply が反映する。messenger の peer 名が再起動前と同じ前提）。
   * 旧形式（作業ごとの cap）の記録は legacy として残す。
   */
  restore(): Promise<void>;
  /**
   * server の cap（remote_id = cap_id、center ごとに固定）へ次の指示を送る。
   * server の status で cap の有無を確かめ、無い時だけ最初の kick_cap（model / worker_model は config の servers[]）。
   * 返信は待たず、running で返る。cap が実行中なら server 側で直列に待たされる。
   */
  send(input: { owner: string; prompt: string; server?: string; model?: string; worker_model?: string }): Promise<RemoteSendResult>;
  /** stop_cap を送って記録を外す。remote_id 省略時は center の cap。server で複数から絞る。 */
  delete(input: { remote_id?: string; server?: string; force?: boolean }): Promise<{ remote_id: string; deleted: true; stopped: boolean; warning?: string }>;
  /**
   * 最初の返信の後に server が送ってきた cap_result / error（kick_cap。report 起因の再開など）を記録に反映する。
   * 記録が無い（delete 済み・cap_kick の cap・旧形式）・まだ最初の返信待ちの時は何もしない。反映したら true。
   * fromId = 送ってきた server の peer id（同じ cap_id が複数 server にある時の取り違え防止）。
   */
  applyLateReply(reply: CapResultReply | ErrorReply, fromId?: string): boolean;
  list(filter?: { owner?: string }): RemoteView[];
  /** server から activity 通知を受けた時に呼ぶ。cap が idle で worker も無くなったなら、未完了の指示を完了にして通知する・待ちを起こす。 */
  onActivity(capId: string, fromId?: string): void;
  /**
   * cap が終わる（list の state が done / failed = cap が idle で、配下の worker に running / stalled が無い）まで待って返す。
   * remote_id 省略時は owner の未完了の指示がある cap のどれかが終わるまで。timeout なら state=running のまま返す。
   */
  wait(input: { remote_id?: string; server?: string; owner?: string; timeoutSec?: number }): Promise<RemoteView>;
}

/** unknown にした時の error の接頭辞（回復時に消す印）。 */
const STATUS_ERR = "status を取れない";

const truncate = (s: string): string => (s.length > RESULT_MAX ? `${s.slice(0, RESULT_MAX)}…(省略)` : s);

const isPending = (e: HistoryEntry): e is InstructionEntry => e.type === "instruction" && e.done_at === undefined;

const ownersOf = (r: RemoteRecord): string[] => {
  const seen: string[] = [];
  for (const e of r.history) if (e.type === "instruction" && !seen.includes(e.owner)) seen.push(e.owner);
  if (r.owner && !seen.includes(r.owner)) seen.push(r.owner);
  return seen;
};

export function createRemoteManager(opts: {
  link: ServerLink;
  store: JsonListStore<RemoteRecord>;
  log: Logger;
  /** center ごとに固定の cap_id（`c-<center の安定 id>`。center-id.ts）。 */
  capId: string;
  /** config の servers[]。server ごとの model / workerModel を引く（無ければ指定しない）。configPath があれば送信のたびに読み直し、読めない時はこの値。 */
  servers?: ServerConfig[];
  /** 指定すると、send のたびにこの config ファイルを読み直して servers[] を取る（sessionInstructions と同じ）。 */
  configPath?: string;
  /** cap_result の後、次の activity を待つ猶予（ms）。既定 SETTLE_GRACE_MS。 */
  graceMs?: number;
  /** status での追従・再試行の間隔（ms）。既定 PROBE_POLL_MS。 */
  pollMs?: number;
  /** server からの activity 通知の保持。省けば list に activity は付かない。 */
  activity?: ActivityStore;
  /** 完了通知の送り先。owner の session へ text を送る。省けば通知しない。 */
  notify?: (owner: string, text: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
}): RemoteManager {
  const { link, store, log, capId } = opts;
  const graceMs = opts.graceMs ?? SETTLE_GRACE_MS;
  const pollMs = opts.pollMs ?? PROBE_POLL_MS;
  let lastGoodServers = opts.servers;
  const records: RemoteRecord[] = [];
  /** cap_result（や再起動）の後、次の activity か猶予の経過を待っている記録 → 待ち始めた時刻。この間は完了にしない（メモリのみ）。 */
  const settling = new Map<RemoteRecord, number>();
  /** status で「動いていない」と判定した時刻。これより前に受けた activity は古いので、判定に使わない（メモリのみ）。 */
  const statusIdleAt = new Map<RemoteRecord, number>();
  /** status で状態を確かめる予約（メモリのみ）。 */
  const probes = new Map<RemoteRecord, ReturnType<typeof setTimeout>>();
  /** 返信待ちの kick_cap の数（メモリのみ）。center の link は同じ cap_id の指示を直列にするので、2 本目以降は 1 本目の返信後に送られる。 */
  const inflight = new Map<RemoteRecord, number>();
  const waiters = new Set<() => void>();
  /** server（peer id）ごとの送信の直列化（status の確認 → 記録 → kick_cap の投入）。 */
  const locks = new Map<string, Promise<unknown>>();

  const persist = (): Promise<void> =>
    store.save(records).catch((e: unknown) => log(`remotes 保存失敗: ${e instanceof Error ? e.message : String(e)}`));

  const has = (r: RemoteRecord): boolean => records.includes(r);

  const activityOf = (r: RemoteRecord): RemoteActivity | undefined =>
    opts.activity?.get(r.remote_id, r.server) ?? opts.activity?.get(r.remote_id, "");

  const activityBusy = (r: RemoteRecord): boolean => {
    const a = activityOf(r);
    if (!a) return false;
    // status で idle と判定した後は、それより前に受けた activity（cap_result 前の running など）を使わない
    const idleAt = statusIdleAt.get(r);
    if (idleAt !== undefined && Date.now() - a.received_ms_ago < idleAt) return false;
    return a.agents.some((x) => (x.kind === "worker" || x.kind === "cap") && (x.state === "running" || x.state === "stalled"));
  };

  /**
   * list と同じ見え方の state。返信待ちの指示がある間・cap_result の後の判定待ち（settling）の間・
   * cap の turn が終わっていても cap か worker が動いている間は running。
   */
  const stateOf = (r: RemoteRecord): RemoteState => {
    if (r.state === "running" || (inflight.get(r) ?? 0) > 0) return "running";
    if (r.state === "unknown") return "unknown";
    if (settling.has(r)) return "running";
    if (r.state !== "done") return r.state;
    return activityBusy(r) ? "running" : "done";
  };

  const unschedule = (r: RemoteRecord): void => {
    const t = probes.get(r);
    if (t) clearTimeout(t);
    probes.delete(r);
  };
  const schedule = (r: RemoteRecord, ms: number): void => {
    unschedule(r);
    const t = setTimeout(() => {
      probes.delete(r);
      void probe(r);
    }, Math.max(0, ms));
    t.unref?.();
    probes.set(r, t);
  };

  const viewOf = (r: RemoteRecord): RemoteView => {
    const { owner: _o, ...rest } = r;
    const state = stateOf(r);
    const base: RemoteView = { ...rest, history: r.history.map((e) => ({ ...e })), owners: ownersOf(r), state };
    if (state === "running") delete base.finishedAt;
    const activity = activityOf(r);
    return { ...base, ...(activity ? { activity } : {}) };
  };

  const wake = (): void => {
    for (const w of [...waiters]) w();
  };

  /**
   * cap が idle かつ worker 無し（stateOf が running でない）になったら、未完了の指示を全て完了にし、owner ごとに 1 回通知する。
   * 完了にするのは同期で行うので、同じ指示を二重に通知しない。
   */
  const completeIfIdle = (r: RemoteRecord): void => {
    const s = stateOf(r);
    if (!has(r) || r.legacy || s === "running" || s === "unknown") return;
    const pending = r.history.filter(isPending);
    if (pending.length === 0) return;
    const now = new Date().toISOString();
    for (const p of pending) p.done_at = now;
    void persist();
    const byOwner = new Map<string, InstructionEntry[]>();
    for (const p of pending) byOwner.set(p.owner, [...(byOwner.get(p.owner) ?? []), p]);
    const text = (instr: InstructionEntry[]): string =>
      formatDoneNotice({ remote_id: r.remote_id, state: stateOf(r), ...(r.result !== undefined ? { result: r.result } : {}), ...(r.error ? { error: r.error } : {}), instructions: instr.map((i) => i.prompt) });
    for (const [owner, instr] of byOwner) {
      if (!opts.notify) {
        for (const i of instr) i.notify_error = "通知の送り先が無い";
        continue;
      }
      void opts.notify(owner, text(instr)).then(
        (res) => res,
        (e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : String(e) }),
      ).then((res) => {
        for (const i of instr) {
          if (res.ok) {
            i.notified_at = new Date().toISOString();
            delete i.notify_error;
          } else {
            delete i.notified_at;
            i.notify_error = res.reason;
          }
        }
        if (res.ok) log(`remote 完了通知: ${r.remote_id} owner=${owner} state=${stateOf(r)} 指示=${instr.length}`);
        else log(`remote 完了通知を送れない: ${r.remote_id} owner=${owner} ${res.reason}`);
        if (has(r)) void persist();
        wake();
      });
    }
    wake();
  };

  const trim = (r: RemoteRecord): void => {
    let i = 0;
    while (r.history.length > HISTORY_MAX && i < r.history.length) {
      if (r.history[i].type === "instruction" && isPending(r.history[i] as InstructionEntry)) i++;
      else r.history.splice(i, 1);
    }
  };

  /**
   * 結果を履歴と最新の状態に反映する。kind: cap_result = cap の turn が終わった（成功・失敗とも）/ error = server の error 返信 /
   * transport = server に届かない・返信が来ない（state は failed でなく unknown）。
   * cap_result は即座に完了にしない: 未完了の指示があれば settling にして、次の activity か猶予（graceMs）の後の status で判定する。
   */
  const applyResult = (r: RemoteRecord, res: { ok: boolean; text: string; error?: string }, kind: "cap_result" | "error" | "transport"): void => {
    if (!has(r)) return;
    const now = new Date().toISOString();
    r.history.push({ type: "result", at: now, ok: res.ok, text: truncate(res.text), ...(res.error ? { error: res.error } : {}) });
    r.state = kind === "transport" ? "unknown" : res.ok ? "done" : "failed";
    r.finishedAt = now;
    if (kind === "cap_result" && r.history.some(isPending)) {
      settling.set(r, Date.now());
      schedule(r, graceMs);
    } else if (kind === "transport") {
      schedule(r, pollMs);
    }
    if (res.ok) {
      r.result = truncate(res.text);
      delete r.error;
    } else {
      r.error = res.error ?? "失敗";
      if (res.text) r.result = truncate(res.text);
    }
    trim(r);
    void persist();
    completeIfIdle(r);
    wake();
  };

  /** server の status から、cap か worker が動いているか。worker は cap との対応が status に無いので server 全体で見る。 */
  const statusBusy = (st: StatusReply): boolean => {
    const cap = st.caps.find((c) => c.id === capId);
    return (cap !== undefined && (cap.state === "running" || (cap.queued ?? 0) > 0)) || st.workers.some((w) => w.state === "running");
  };

  /**
   * server の status で記録の状態を確かめる。取れなければ unknown（再試行を予約）。取れたら:
   * 動いている → running で追従（pollMs ごと）。動いていない → 猶予内なら猶予の終わりまで待ち（遅れた cap_result を拾う）、
   * 過ぎたら running / unknown を done にして完了判定。返信待ちの kick_cap がある間は返信が進めるので何もしない。
   */
  const probe = async (r: RemoteRecord): Promise<void> => {
    if (!has(r) || r.legacy || (inflight.get(r) ?? 0) > 0) return;
    const startedAt = Date.now();
    let st: StatusReply;
    try {
      const reply = await link.statusOn(await findPeer(r));
      if (reply.type === "error") throw new Error(reply.message);
      st = reply;
    } catch (e) {
      if (!has(r) || (inflight.get(r) ?? 0) > 0) return;
      const msg = e instanceof Error ? e.message : String(e);
      if (r.state !== "unknown") log(`remote 状態不明: ${r.remote_id} status を取れない: ${msg}`);
      r.state = "unknown";
      r.error = `${STATUS_ERR}: ${msg}`;
      void persist();
      wake();
      schedule(r, pollMs);
      return;
    }
    if (!has(r) || (inflight.get(r) ?? 0) > 0) return;
    if (statusBusy(st)) {
      settling.delete(r);
      statusIdleAt.delete(r);
      if (r.state !== "running") log(`remote 追従: ${r.remote_id} cap / worker が動いている（status）`);
      r.state = "running";
      delete r.finishedAt;
      if (r.error?.startsWith(STATUS_ERR)) delete r.error;
      void persist();
      wake();
      schedule(r, pollMs);
      return;
    }
    // status を取っている間に新しい activity が来て、動いていると言っているなら、そちらを信じて次の周期で確かめ直す
    const fresh = activityOf(r);
    if (fresh && Date.now() - fresh.received_ms_ago >= startedAt && activityBusy(r)) {
      schedule(r, pollMs);
      return;
    }
    const since = settling.get(r);
    if (since !== undefined && Date.now() - since < graceMs) {
      schedule(r, graceMs - (Date.now() - since));
      return;
    }
    settling.delete(r);
    statusIdleAt.set(r, Date.now());
    if (r.state === "running" || r.state === "unknown") {
      r.state = "done";
      r.finishedAt = new Date().toISOString();
      if (r.error?.startsWith(STATUS_ERR)) delete r.error;
    }
    log(`remote 完了判定（status）: ${r.remote_id} state=${stateOf(r)}`);
    void persist();
    completeIfIdle(r);
    wake();
  };

  const resultOf = (reply: CapResultReply | ErrorReply): { ok: boolean; text: string; error?: string } =>
    reply.type === "cap_result"
      ? { ok: reply.ok, text: reply.result_text, ...(reply.ok ? {} : { error: reply.error ?? "失敗" }) }
      : { ok: false, text: "", error: reply.message };

  /** server の peer から記録を探す（id 一致 → 名前 + host 一致）。旧形式は除く。 */
  const findRecord = (peer: ServerPeer): RemoteRecord | undefined => {
    const own = records.filter((r) => !r.legacy && r.remote_id === capId);
    return (
      own.find((r) => r.server === peer.id) ??
      own.find((r) => r.serverName === peer.name && r.serverHost === peer.hostname)
    );
  };

  /** 通知・遅れた返信の送信元から記録を決める。同じ cap_id が 1 件だけなら、peer id が変わっていてもそれ。 */
  const resolveRecord = (id: string, fromId?: string): RemoteRecord | undefined => {
    const cands = records.filter((r) => !r.legacy && r.remote_id === id);
    if (cands.length === 0) return undefined;
    if (fromId !== undefined) {
      const hit = cands.find((r) => r.server === fromId);
      if (hit) return hit;
    }
    if (cands.length > 1) return undefined;
    if (fromId !== undefined && cands[0].server !== fromId) {
      cands[0].server = fromId;
      void persist();
    }
    return cands[0];
  };

  /** 記録の server を今の peer から探す（id 一致 → 名前 + host 一致 → 名前のみ）。 */
  const findPeer = async (r: RemoteRecord): Promise<ServerPeer> => {
    const peers = await link.peers();
    const hit =
      peers.find((p) => p.id === r.server) ??
      peers.find((p) => p.name === r.serverName && p.hostname === r.serverHost) ??
      peers.find((p) => p.name === r.serverName);
    if (!hit) throw new Error(`server が見つからない: ${r.serverName}(${r.server})`);
    return hit;
  };

  /** remote_id（省略時は center の cap）と server から記録を 1 件決める。複数あれば server で絞らせる。 */
  const pick = async (remote_id: string | undefined, server: string | undefined): Promise<RemoteRecord> => {
    const id = remote_id ?? capId;
    let cands = records.filter((r) => r.remote_id === id);
    if (cands.length === 0) throw new Error(`未定義の remote: ${id}`);
    if (server !== undefined) {
      const peer = await link.selectPeer(server);
      cands = cands.filter((r) => r.server === peer.id || (r.serverName === peer.name && r.serverHost === peer.hostname));
      if (cands.length === 0) throw new Error(`その server に remote ${id} は無い: ${server}`);
    }
    if (cands.length > 1) throw new Error(`remote ${id} は複数の server にある（server で指定: ${cands.map((r) => `${r.serverName}(${r.server})`).join(", ")}）`);
    return cands[0];
  };

  /** 送信のたびに config を読み直した servers[]。読めない・不正な時は直前に読めた値。 */
  const currentServers = (): ServerConfig[] | undefined => {
    if (!opts.configPath) return lastGoodServers;
    try {
      lastGoodServers = loadConfigSync(opts.configPath).servers;
    } catch (e) {
      log(`config の読み直しに失敗。直前の servers で送信: ${e instanceof Error ? e.message : String(e)}`);
    }
    return lastGoodServers;
  };

  /** config の servers[] から、この server の model / workerModel を引く（peer id・peer 名・name・指定された sel のどれかで一致）。 */
  const serverModels = (peer: ServerPeer, sel?: string): { model?: string; worker_model?: string } => {
    const cfg = currentServers()?.find((s) => s.peer === peer.id || s.peer === peer.name || s.name === peer.name || (sel !== undefined && s.name === sel));
    return { ...(cfg?.model ? { model: cfg.model } : {}), ...(cfg?.workerModel ? { worker_model: cfg.workerModel } : {}) };
  };

  const serial = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    locks.set(key, next);
    void next.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      if (locks.get(key) === next) locks.delete(key);
    });
    return next;
  };

  return {
    async restore() {
      for (const r of await store.load()) {
        if (typeof r?.remote_id !== "string" || !AGENT_ID_PATTERN.test(r.remote_id)) continue;
        if (!Array.isArray(r.history)) {
          // 旧形式（作業ごとの cap）。読み捨てず、legacy として一覧に残す
          r.history = [];
          r.legacy = true;
        }
        if (r.state !== "running" && r.state !== "done" && r.state !== "failed" && r.state !== "unknown") r.state = "unknown";
        if (r.legacy && r.state === "running") {
          // 旧形式は追従しない。返信を受け取れないので従来どおり failed
          r.state = "failed";
          r.finishedAt = new Date().toISOString();
          r.error = "center 再起動で返信を受け取れなかった（server 側は実行を続けている可能性がある）";
        }
        records.push(r);
        // running・unknown・未完了の指示がある記録は、failed にせず復元して server の status で追従する
        if (!r.legacy && (r.state === "running" || r.state === "unknown" || r.history.some(isPending))) {
          settling.set(r, Date.now());
          schedule(r, 0);
        }
      }
      if (records.length > 0) await persist();
      log(`remote 記録を読込: ${records.length} 件${records.some((r) => r.legacy) ? `（旧形式 ${records.filter((r) => r.legacy).length} 件）` : ""}`);
    },

    async send(input) {
      for (const [k, v] of [["model", input.model], ["worker_model", input.worker_model]] as const) {
        if (v !== undefined && !MODEL_PATTERN.test(v)) throw new Error(`${k} が不正: 英数字と . _ [ ] - のみ（先頭は - 不可）`);
      }
      if (!OWNER_PATTERN.test(input.owner)) throw new Error("owner は英数字と _ - のみ");
      const peer = await link.selectPeer(input.server);
      // protocol の版が合わない・更新待ちの server へは、記録を作らず isError で返す（session が後で再送できる）
      const blocked = link.gate?.(peer, "kick_cap");
      if (blocked) throw new Error(blocked.message);
      return serial(peer.id, async () => {
        const st = await link.statusOn(peer);
        if (st.type === "error") throw new Error(`server の cap を確かめられない: ${st.message}`);
        const exists = st.caps.some((c) => c.id === capId);
        // 新規の cap: 指定 > config。既存の cap: model は無視、worker_model は指定された時だけ送る（server が cap の既定として記憶する）
        const cfgModels = exists ? {} : serverModels(peer, input.server);
        const model = exists ? undefined : (input.model ?? cfgModels.model);
        const workerModel = input.worker_model ?? cfgModels.worker_model;
        const models = { ...(model ? { model } : {}), ...(workerModel ? { worker_model: workerModel } : {}) };
        const now = new Date().toISOString();
        let rec = findRecord(peer);
        if (!rec) {
          rec = { remote_id: capId, server: peer.id, serverName: peer.name, ...(peer.hostname ? { serverHost: peer.hostname } : {}), state: "running", createdAt: now, history: [] };
          records.push(rec);
        }
        rec.server = peer.id;
        rec.serverName = peer.name;
        if (peer.hostname) rec.serverHost = peer.hostname;
        // cap を作る時だけ model を渡す。記録も作った時の値にする
        if (!exists) {
          if (models.model) rec.model = models.model;
          else delete rec.model;
          if (!models.worker_model) delete rec.worker_model;
        }
        if (models.worker_model) rec.worker_model = models.worker_model;
        const target = rec;
        target.history.push({ type: "instruction", at: now, owner: input.owner, prompt: input.prompt.slice(0, PROMPT_HEAD_MAX) });
        target.state = "running";
        delete target.finishedAt;
        settling.delete(target);
        statusIdleAt.delete(target);
        unschedule(target);
        trim(target);
        inflight.set(target, (inflight.get(target) ?? 0) + 1);
        await persist();
        log(`remote 指示: ${capId} owner=${input.owner} server=${peer.name}(${peer.id}) ${exists ? "既存の cap へ" : "cap を作成（最初の kick_cap）"}`);
        const settle = (res: { ok: boolean; text: string; error?: string }, kind: "cap_result" | "error" | "transport"): void => {
          inflight.set(target, Math.max(0, (inflight.get(target) ?? 1) - 1));
          applyResult(target, res, kind);
          log(`remote 結果: ${capId} state=${stateOf(target)}`);
        };
        void link
          .kickCapOn(peer, { cap_id: capId, prompt: input.prompt, ...models, reason: `remote_send owner=${input.owner}` })
          .then(
            (reply) => settle(resultOf(reply), reply.type === "cap_result" ? "cap_result" : "error"),
            (e: unknown) => settle({ ok: false, text: "", error: e instanceof Error ? e.message : String(e) }, "transport"),
          );
        return {
          remote_id: capId,
          server: peer.id,
          serverName: peer.name,
          state: "running" as const,
          created: !exists,
          ...(target.model ? { model: target.model } : {}),
          ...(target.worker_model ? { worker_model: target.worker_model } : {}),
          ...(exists && input.model ? { model_ignored: true as const, note: "cap は既存なので model は無視した" } : {}),
        };
      });
    },

    async delete({ remote_id, server, force }) {
      const rec = await pick(remote_id, server);
      let stopped = false;
      let warning: string | undefined;
      try {
        const peer = await findPeer(rec);
        const reply = await link.stopCapOn(peer, { cap_id: rec.remote_id });
        if (reply.type === "stop_result") stopped = reply.stopped;
        else throw new Error(reply.type === "error" ? reply.message : "不明な返信");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // 実行中の記録を、止められないまま消さない。force か、既に終わっている記録なら消す
        if (stateOf(rec) === "running" && !force) throw new Error(`remote を止められない: ${msg}（force: true で記録だけ消せる）`);
        warning = `server へ stop_cap を送れなかった: ${msg}`;
      }
      const i = records.indexOf(rec);
      if (i >= 0) records.splice(i, 1);
      inflight.delete(rec);
      settling.delete(rec);
      statusIdleAt.delete(rec);
      unschedule(rec);
      opts.activity?.forget(rec.remote_id, rec.server);
      wake();
      await persist();
      log(`remote 削除: ${rec.remote_id} server=${rec.serverName} stopped=${stopped}${warning ? ` warning=${warning}` : ""}`);
      return { remote_id: rec.remote_id, deleted: true, stopped, ...(warning ? { warning } : {}) };
    },

    applyLateReply(reply, fromId) {
      const id = reply.cap_id;
      const rec = id === undefined ? undefined : resolveRecord(id, fromId);
      // 返信待ちがある間（inflight）はここへ来る返信も待ちに照合されるはずなので、取り違えを避けて触らない
      if (!rec || (inflight.get(rec) ?? 0) > 0) return false;
      applyResult(rec, resultOf(reply), reply.type === "cap_result" ? "cap_result" : "error");
      log(`remote 結果を更新: ${rec.remote_id} state=${stateOf(rec)}`);
      return true;
    },

    list: (filter) =>
      records.filter((r) => filter?.owner === undefined || ownersOf(r).includes(filter.owner)).map(viewOf),

    onActivity(id, fromId) {
      const r = resolveRecord(id, fromId);
      if (r) {
        // 新しい activity が来たので、cap_result 後・再起動後の判定待ちは終わり。以後は activity で判定する
        settling.delete(r);
        // done / failed の記録は、新しい activity が判定の根拠になるので、猶予後の status 判定は要らない
        if (r.state === "done" || r.state === "failed") unschedule(r);
        if ((inflight.get(r) ?? 0) === 0 && (r.state === "running" || r.state === "unknown")) {
          // 返信待ちでない running（再起動後・status 追従）と unknown は、activity で動いていなければ done に戻す
          if (activityBusy(r)) {
            r.state = "running";
          } else {
            r.state = "done";
            r.finishedAt = new Date().toISOString();
            unschedule(r);
          }
          if (r.error?.startsWith(STATUS_ERR)) delete r.error;
          void persist();
        }
        completeIfIdle(r);
      }
      wake();
    },

    async wait({ remote_id, server, owner, timeoutSec }) {
      const sec = Math.min(Math.max(timeoutSec ?? WAIT_DEFAULT_SEC, 1), WAIT_MAX_SEC);
      let targets: RemoteRecord[];
      if (remote_id !== undefined || server !== undefined) {
        targets = [await pick(remote_id, server)];
      } else {
        if (owner === undefined) throw new Error("remote_id を省略するには owner（session）が必要");
        targets = records.filter((r) => !r.legacy && r.history.some((e) => isPending(e) && e.owner === owner));
        if (targets.length === 0) throw new Error("running の remote が無い（未完了の指示が無い）");
      }
      const check = (): RemoteView | undefined => {
        for (const t of targets) {
          // 待っている間に delete された cap は、その時点で failed 扱いにはせず待ちから外す
          if (!has(t)) continue;
          // unknown は終わっていない（status が取れれば戻る）ので待ち続ける
          const s = stateOf(t);
          if (s === "done" || s === "failed") return viewOf(t);
        }
        return undefined;
      };
      const first = check();
      if (first) return first;
      return new Promise<RemoteView>((resolve, reject) => {
        const done = (v: RemoteView | Error): void => {
          clearTimeout(timer);
          waiters.delete(w);
          v instanceof Error ? reject(v) : resolve(v);
        };
        const w = (): void => {
          const v = check();
          if (v) done(v);
          else if (targets.every((t) => !has(t))) done(new Error("待っていた remote が削除された"));
        };
        const timer = setTimeout(() => {
          const v = check();
          const alive = targets.find((t) => has(t));
          if (v) done(v);
          else if (alive) done(viewOf(alive));
          else done(new Error("待っていた remote が削除された"));
        }, sec * 1000);
        waiters.add(w);
      });
    },
  };
}
