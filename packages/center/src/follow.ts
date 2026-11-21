import {
  FOLLOW_MIN_PROTOCOL,
  MESSENGER_PROTOCOL,
  PROTOCOL_VERSION,
  type ErrorReply,
  type ServerCommandType,
  type UpdateProgress,
  type UpdateRunning,
  type UpdateWaitRun,
} from "@agent-hand/bantou-protocol";
import type { Logger } from "./log.js";
import type { Pair } from "./pair.js";
import { isTransportError, type ServerLink, type ServerPeer } from "./server-link.js";
import { describeServer, identityOfReply, type ServerIdentity } from "./server-identity.js";

/**
 * 発見した server の版を確かめ、組の版と違えば protocol `bantou` で更新を指示する。
 * 状態:
 *   ok          版が揃っている
 *   unsupported hello を知らない版（protocol 1.3.0 未満）。自動更新できない（手動で起動し直す）
 *   updating    更新指示済み。実行中の cap / worker の終了待ち、または再起動中
 *   mismatch    server の版は組と同じなのに protocol の版が違う（ビルドの不整合）
 *   failed      更新指示が断られた・取得に失敗した（失敗から一定時間おいて同じ版を再指示する。npm への反映待ちなど）
 *   lost        updating のまま一定時間 server が戻らない
 *   unknown     hello に答えない（一時的な通信失敗など）
 */
export type FollowState = "ok" | "unsupported" | "updating" | "mismatch" | "failed" | "lost" | "unknown";

/** 更新が待っている run（server の UpdateWaitRun に、この center の cap なら session 名を足したもの）。 */
export interface WaitRun extends UpdateWaitRun {
  /** cap が この center の session の cap なら、その session 名（cap_id `<center の cap_id>-<session>` から）。 */
  session?: string;
}

/** updating の時の更新の中身。since / deadline / runs は新しい server だけが返す。 */
export interface UpdateInfo {
  to: string;
  running?: UpdateRunning;
  /** ISO 8601。server が待ち始めた時刻。 */
  since?: string;
  /** ISO 8601。server が残りを止めて再起動する時刻（待ちの上限）。 */
  deadline?: string;
  runs?: WaitRun[];
}

/** 待っている run を文に並べる上限。 */
const WAIT_RUNS_IN_TEXT = 5;

const minutesSince = (iso: string | undefined, nowMs: number): number | undefined => {
  if (iso === undefined) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : Math.max(0, Math.floor((nowMs - t) / 60_000));
};

/**
 * 更新が何を待っているかの一文。例:
 * 「待機 12 分、2026-11-21T05:40:00.000Z（上限）に残りを止めて再起動。待っている run: cap 1 / worker 1（session mflow の cap 実行 8 分、session mflow の worker w-1 実行 3 分）」
 * 経過と上限を先に置く（detail は 200 字で切るので、run の列が長くても残るように）。件数しか無い（旧 server）なら件数だけ。
 */
export function describeWait(u: { running?: UpdateRunning; since?: string; deadline?: string; runs?: WaitRun[] }, nowMs: number): string {
  const parts: string[] = [];
  const runs = u.runs ?? [];
  const items = runs.slice(0, WAIT_RUNS_IN_TEXT).map((x) => {
    const owner = x.session !== undefined ? `session ${x.session} の ` : x.kind === "worker" && x.cap_id ? `cap ${x.cap_id} の ` : "";
    const what = x.kind === "cap" ? (x.session !== undefined ? "cap" : `cap ${x.id}`) : `worker ${x.id}`;
    const m = minutesSince(x.started_at, nowMs);
    return `${owner}${what} ${x.phase === "running" ? "実行" : x.phase === "queued" ? "待ち" : "準備"}${m !== undefined ? ` ${m} 分` : ""}`;
  });
  const more = runs.length > WAIT_RUNS_IN_TEXT ? ` ほか ${runs.length - WAIT_RUNS_IN_TEXT} 件` : "";
  const waited = minutesSince(u.since, nowMs);
  const tail = [
    waited !== undefined ? `待機 ${waited} 分` : undefined,
    u.deadline !== undefined ? `${u.deadline}（上限）に残りを止めて再起動` : undefined,
  ].filter((x): x is string => x !== undefined);
  if (tail.length > 0) parts.push(tail.join("、"));
  if (u.running) parts.push(`待っている run: cap ${u.running.caps} / worker ${u.running.workers}${items.length > 0 ? `（${items.join("、")}${more}）` : ""}`);
  return parts.join("。");
}

export interface FollowEntry extends ServerIdentity {
  /** server を指す key（peer の summary。無ければ peer id）。peer id は再登録で変わる。server の識別は server_id（旧 server は無い）。host / user / workspace は server が名乗ったもの。 */
  key: string;
  id: string;
  name: string;
  hostname?: string;
  summary?: string;
  server_version?: string;
  protocol_version?: string;
  state: FollowState;
  /** 画面に出す一言（日本語）。 */
  detail: string;
  /** updating の時、更新先と待っているもの（件数・run・待機の開始と上限）。 */
  update?: UpdateInfo;
  /** この state になった時刻（ISO 8601）。 */
  since: string;
}

/** session 向けの道具（remote_list / task_status）に載せる、server ごとの版の状態。server の事実だけで、他の session の情報は入らない。 */
export interface ServerVersionInfo {
  /** center の protocol の版。 */
  center_protocol: string;
  /** server が名乗った protocol の版（不明なら無い）。 */
  server_protocol?: string;
  /** server の版（hello に答えるまで無い）。 */
  server_version?: string;
  state: FollowState;
  /** 更新の状態の一言（待っている cap / worker の件数・直近の失敗の内容を含む。長いものは切る）。 */
  detail: string;
  /** 更新先と待っているもの（updating の時）。runs[].session = その run の cap の session 名（この center の cap の時）。 */
  update?: UpdateInfo;
  /** この state になった時刻（ISO 8601）。 */
  since: string;
}

/** 版の状態の一言の長さの上限（server の error 文が長くても返り値を膨らませない）。 */
export const VERSION_DETAIL_MAX = 200;

const clipDetail = (s: string): string => (s.length > VERSION_DETAIL_MAX ? `${s.slice(0, VERSION_DETAIL_MAX - 1)}…` : s);

/** state を人に読める語にする（error 文に載せる）。 */
const STATE_WORD: Record<FollowState, string> = {
  ok: "版は一致",
  unsupported: "自動更新できない版",
  updating: "更新を指示済み（実行中の cap / worker の終了待ち、または再起動中）",
  mismatch: "ビルドの不整合",
  failed: "更新に失敗（再指示待ち）",
  lost: "更新後に戻らない",
  unknown: "更新の状態を確認できない",
};

/** 版が合わず断る時に error の文へ足す、その server の更新の状態。 */
export function versionNoteOf(info: ServerVersionInfo | undefined): string {
  if (!info) return "更新の状態: 未確認（center はまだこの server の版を確かめていない）";
  const word = STATE_WORD[info.state];
  return `更新の状態: ${word}（${info.since} から）。${info.detail}`;
}

export interface FollowSnapshot {
  pair: { server: string | null; protocol: string };
  peers: FollowEntry[];
}

export interface Follow {
  start(): void;
  stop(): void;
  /** 1 周する（発見 → hello → 必要なら update_server）。同時に 2 周は走らない。 */
  check(): Promise<void>;
  snapshot(): FollowSnapshot;
  /** server の版の状態。server_id（無い旧 server は peer id）で引く。無ければ undefined。 */
  versionOf(ref: { server_id?: string; peer?: string }): ServerVersionInfo | undefined;
  /** 版が合わず断る error に足す一文（peer id で引く）。 */
  noteOf(peer: { id: string }): string;
  /** link の門に差し込む。更新待ちの server への kick_cap / task を送る前に断る。 */
  gate(peer: { id: string }, command: ServerCommandType): ErrorReply | undefined;
}

/** 更新中のまま server が戻らないと見なす時間。 */
export const LOST_AFTER_MS = 15 * 60_000;
/** 周期。 */
export const CHECK_INTERVAL_MS = 30_000;
/** 更新中の server がいる間の周期（再起動後に早く ok へ戻すため）。 */
export const UPDATING_INTERVAL_MS = 5_000;
/** 更新に失敗してから同じ版を再指示するまでの間隔。 */
export const RETRY_AFTER_MS = 5 * 60_000;

/** "1.3.0" 形式の比較（a < b で負）。pre-release 部は無視する。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 更新待ちの server に kick_cap / task を送る前に center が断る error（server 側の断りと同じ形）。何を待っているか（件数・run・経過・上限）を文に足す。 */
export function updatingError(
  entry: { server_version?: string; update?: UpdateInfo; detail?: string; since?: string },
  pair: Pair,
  command: ServerCommandType,
  nowMs: number = Date.now(),
): ErrorReply {
  const from = entry.server_version ?? "?";
  const to = entry.update?.to ?? pair.server ?? "?";
  const wait = entry.update ? describeWait(entry.update, nowMs) : "";
  // 待っているものが分からない（旧 server・update_conflict）時は、center が updating にした理由（detail）と時刻を出す
  const note = wait !== "" ? wait : entry.detail !== undefined ? `${entry.detail}${entry.since !== undefined ? `（${entry.since} から）` : ""}` : "";
  const progress: UpdateProgress | undefined =
    entry.update?.running !== undefined
      ? {
          state: "waiting",
          from,
          to,
          running: entry.update.running,
          ...(entry.update.since !== undefined ? { since: entry.update.since } : {}),
          ...(entry.update.deadline !== undefined ? { deadline: entry.update.deadline } : {}),
          ...(entry.update.runs !== undefined ? { runs: entry.update.runs } : {}),
        }
      : undefined;
  return {
    bantou: PROTOCOL_VERSION,
    type: "error",
    ok: false,
    message: `server 更新待ち（${from}→${to}）。実行中の cap/worker の終了後に再起動する。再起動後に再送${note !== "" ? `。${note}` : ""}`,
    command,
    code: "updating",
    retryable: true,
    ...(progress ? { update: progress } : {}),
  };
}

interface Rec {
  entry: FollowEntry;
  /** 更新に失敗した後、次に同じ版を再指示してよい時刻（ms）。 */
  retryAt?: number;
  /** updating になった時刻。 */
  updatingSince?: number;
  /** 最後に hello に答えた時刻（lost 判定はここから測る。長く正常に待った server を、再起動の間の無応答 1 回で lost にしない）。 */
  lastAnswerAt?: number;
}

export function createFollow(opts: {
  link: ServerLink;
  pair: Pair;
  log: Logger;
  intervalMs?: number;
  lostAfterMs?: number;
  retryAfterMs?: number;
  now?: () => number;
  /** hello の応答の有無を知らせる（remote の到達性に使う）。ok=false は center の側の失敗（無返信・送信失敗）。server の返した error は ok=true。 */
  onReach?: (peer: ServerPeer, ok: boolean, message?: string) => void;
  /** cap_id がこの center の session の cap なら session 名（待っている run の表示に使う）。 */
  sessionOfCap?: (capId: string) => string | undefined;
}): Follow {
  const { link, pair, log } = opts;
  const now = opts.now ?? Date.now;
  const lostAfterMs = opts.lostAfterMs ?? LOST_AFTER_MS;
  const retryAfterMs = opts.retryAfterMs ?? RETRY_AFTER_MS;
  const recs = new Map<string, Rec>();
  /** peer id -> key（gate は peer id で引く）。 */
  const byId = new Map<string, string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | null = null;
  let stopped = false;
  let lastRun = 0;
  const intervalMs = opts.intervalMs ?? CHECK_INTERVAL_MS;
  const fastMs = Math.min(intervalMs, UPDATING_INTERVAL_MS);

  const keyOf = (p: ServerPeer): string => p.summary || p.id;
  /** updating の server が、最後に答えてから（答えた記録が無ければ updating になってから）lostAfterMs を越えて黙っているか。 */
  const silentTooLong = (rec: Rec): boolean => {
    const base = rec.lastAnswerAt ?? rec.updatingSince;
    return base !== undefined && now() - base > lostAfterMs;
  };

  /** server の更新の進行を、center の記録（session 名つき）にする。 */
  const infoOfProgress = (p: Pick<UpdateProgress, "to" | "running" | "since" | "deadline" | "runs">): UpdateInfo => ({
    to: p.to,
    running: p.running,
    ...(p.since !== undefined ? { since: p.since } : {}),
    ...(p.deadline !== undefined ? { deadline: p.deadline } : {}),
    ...(p.runs !== undefined
      ? {
          runs: p.runs.map((r) => {
            const session = opts.sessionOfCap?.(r.kind === "cap" ? r.id : (r.cap_id ?? ""));
            return session !== undefined ? { ...r, session } : { ...r };
          }),
        }
      : {}),
  });
  const updatingDetail = (from: string, u: UpdateInfo): string => `更新中（${from}→${u.to}）: ${describeWait(u, now())}`;

  function set(rec: Rec, patch: Partial<FollowEntry> & { state: FollowState; detail: string }): void {
    const changed = rec.entry.state !== patch.state || rec.entry.detail !== patch.detail;
    const stateChanged = rec.entry.state !== patch.state;
    const next: FollowEntry = { ...rec.entry, ...patch };
    if (patch.update === undefined) delete next.update;
    if (stateChanged) next.since = new Date(now()).toISOString();
    if (patch.state === "updating") rec.updatingSince ??= now();
    else rec.updatingSince = undefined;
    rec.entry = next;
    if (changed) log(`server 版: ${describeServer({ ...next, peerId: next.id })} ${next.state} ${next.detail}`);
  }

  const recFor = (p: ServerPeer): Rec => {
    const key = keyOf(p);
    let rec = recs.get(key);
    if (!rec) {
      rec = {
        entry: {
          key,
          id: p.id,
          name: p.name,
          ...(p.hostname ? { hostname: p.hostname } : {}),
          ...(p.summary ? { summary: p.summary } : {}),
          ...identityOfReply(p),
          state: "unknown",
          detail: "確認中",
          since: new Date(now()).toISOString(),
        },
      };
      recs.set(key, rec);
    }
    rec.entry.id = p.id;
    rec.entry.name = p.name;
    Object.assign(rec.entry, identityOfReply(p));
    return rec;
  };

  async function evaluate(p: ServerPeer): Promise<void> {
    const rec = recFor(p);
    const declared = p.version;
    if (declared !== undefined) rec.entry.protocol_version = declared;
    if (declared === undefined || compareVersions(declared, FOLLOW_MIN_PROTOCOL) < 0) {
      set(rec, {
        state: "unsupported",
        detail: `自動更新できない版（protocol ${declared ?? "不明"}）。server を手動で起動し直す`,
      });
      return;
    }
    const hello = await link.hello(p);
    if (hello.type === "error" && isTransportError(hello)) opts.onReach?.(p, false, hello.message);
    else opts.onReach?.(p, true);
    if (hello.type !== "hello_result") {
      if (rec.entry.state === "updating") {
        // 再起動中の取りこぼしは更新中のまま。ただし答えないまま一定時間（lost と同じ）過ぎたら、発見に残っていても lost にする（updating のままだと task を断り続ける）
        if (silentTooLong(rec)) {
          set(rec, { state: "lost", detail: `更新中のまま server が hello に答えない: ${hello.type === "error" ? hello.message : "不明な返信"}` });
        }
        return;
      }
      set(rec, { state: "unknown", detail: `版を確認できない: ${hello.type === "error" ? hello.message : "不明な返信"}` });
      return;
    }
    rec.lastAnswerAt = now();
    Object.assign(rec.entry, identityOfReply(hello));
    rec.entry.server_version = hello.server_version;
    rec.entry.protocol_version = hello.protocol_version;
    const protocolOk = hello.protocol_version === MESSENGER_PROTOCOL.version;
    const sv = hello.server_version;
    const target = pair.server;

    if (hello.update) {
      const u = infoOfProgress(hello.update);
      set(rec, { state: "updating", detail: updatingDetail(hello.update.from, u), update: u });
      return;
    }
    if (target === undefined || sv === target) {
      if (protocolOk) {
        set(rec, { state: "ok", detail: target === undefined ? "protocol の版が一致（組の server 版は不明）" : "版が一致" });
      } else {
        set(rec, { state: "mismatch", detail: `protocol の版が違う（server=${hello.protocol_version}, center=${MESSENGER_PROTOCOL.version}）` });
      }
      return;
    }
    // 版が違う: 更新を指示する（新旧は比べない）。
    // 失敗（指示を断られた・server が取得に失敗した）は一定時間おいて再指示する。publish 直後は npm に tarball が出るまで数分かかるため
    const failedTo = hello.last_update?.to === target ? hello.last_update : undefined;
    if (failedTo && rec.retryAt === undefined) {
      const at = Date.parse(failedTo.at);
      rec.retryAt = (Number.isNaN(at) ? now() : at) + retryAfterMs;
    }
    if (rec.retryAt !== undefined && now() < rec.retryAt) {
      const wait = Math.max(1, Math.ceil((rec.retryAt - now()) / 60_000));
      set(rec, { state: "failed", detail: `更新に失敗（→${target}）: ${failedTo?.error ?? "指示を断られた"}。${wait} 分後に再指示` });
      return;
    }
    rec.retryAt = undefined;
    const upd = await link.updateServer(p, target);
    if (upd.type === "update_result") {
      if (upd.state === "current") {
        set(rec, protocolOk ? { state: "ok", detail: "版が一致" } : { state: "mismatch", detail: `protocol の版が違う（server=${hello.protocol_version}）` });
      } else {
        const u = infoOfProgress(upd);
        set(rec, { state: "updating", detail: updatingDetail(upd.from, u), update: u });
        log(`更新を指示: ${p.name}(${p.id}) ${upd.from}->${upd.to} state=${upd.state}`);
      }
      return;
    }
    if (upd.type === "error") {
      // 退役中の server は update_server を断る（retiring:true）。再指示せず、止まるのを待つ（発見から消えれば一覧からも消える）
      if (upd.retiring === true) {
        set(rec, { state: "unknown", detail: "退役中（server は止まっていく途中。更新は指示しない）" });
        return;
      }
      if (upd.code === "update_conflict") {
        set(rec, { state: "updating", detail: `別の更新が進行中: ${upd.message}` });
        return;
      }
      rec.retryAt = now() + retryAfterMs;
      set(rec, { state: "failed", detail: `更新に失敗（→${target}）: ${upd.message}。${Math.ceil(retryAfterMs / 60_000)} 分後に再指示` });
      return;
    }
    set(rec, { state: "unknown", detail: "update_server に不明な返信" });
  }

  /** 見えない server のうち、更新中のまま一定時間戻らないものを lost にする。 */
  function lostCheck(present: Set<string>): void {
    for (const [key, rec] of recs) {
      if (present.has(key) || rec.entry.state !== "updating") continue;
      if (silentTooLong(rec)) {
        set(rec, { state: "lost", detail: "更新後に server が戻らない（応答なし）" });
      }
    }
  }

  async function runOnce(): Promise<void> {
    let peers: ServerPeer[];
    try {
      peers = await link.peers();
    } catch (e) {
      log(`server 版の確認: 発見に失敗 ${e instanceof Error ? e.message : String(e)}`);
      // 発見できない間は状態を変えない（lost 判定だけ進める）
      lostCheck(new Set());
      return;
    }
    const present = new Set<string>();
    byId.clear();
    for (const p of peers) {
      const key = keyOf(p);
      present.add(key);
      byId.set(p.id, key);
      try {
        await evaluate(p);
      } catch (e) {
        log(`server 版の確認に失敗: ${p.name}(${p.id}) ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // 見えなくなった server: 更新中・lost は再起動待ちとして残し、それ以外は消す
    for (const [key, rec] of recs) {
      if (present.has(key) || rec.entry.state === "updating" || rec.entry.state === "lost") continue;
      recs.delete(key);
    }
    lostCheck(present);
  }

  const infoOf = (e: FollowEntry): ServerVersionInfo => ({
    center_protocol: MESSENGER_PROTOCOL.version,
    ...(e.protocol_version !== undefined ? { server_protocol: e.protocol_version } : {}),
    ...(e.server_version !== undefined ? { server_version: e.server_version } : {}),
    state: e.state,
    detail: clipDetail(e.detail),
    ...(e.update ? { update: structuredClone(e.update) } : {}),
    since: e.since,
  });

  return {
    start() {
      stopped = false;
      // 更新中の server がいる間は短い周期で回す
      timer = setInterval(() => {
        const anyUpdating = [...recs.values()].some((r) => r.entry.state === "updating");
        if (anyUpdating || now() - lastRun >= intervalMs) void this.check();
      }, fastMs);
      timer.unref?.();
      void this.check();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    check() {
      if (stopped) return Promise.resolve();
      running ??= runOnce().finally(() => {
        lastRun = now();
        running = null;
      });
      return running;
    },
    snapshot() {
      return {
        pair: { server: pair.server ?? null, protocol: pair.protocol },
        peers: [...recs.values()].map((r) => ({ ...r.entry })),
      };
    },
    versionOf(ref) {
      for (const rec of recs.values()) {
        const e = rec.entry;
        const hit = ref.server_id !== undefined && e.server_id !== undefined ? ref.server_id === e.server_id : ref.peer !== undefined && ref.peer === e.id;
        if (hit) return infoOf(e);
      }
      return undefined;
    },
    noteOf(peer) {
      const key = byId.get(peer.id);
      const rec = key ? recs.get(key) : undefined;
      return versionNoteOf(rec ? infoOf(rec.entry) : undefined);
    },
    gate(peer, command) {
      if (command !== "kick_cap" && command !== "task") return undefined;
      const key = byId.get(peer.id);
      const rec = key ? recs.get(key) : undefined;
      if (rec?.entry.state !== "updating") return undefined;
      return updatingError(rec.entry, pair, command, now());
    },
  };
}
