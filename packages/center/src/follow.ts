import {
  FOLLOW_MIN_PROTOCOL,
  MESSENGER_PROTOCOL,
  PROTOCOL_VERSION,
  type ErrorReply,
  type ServerCommandType,
  type UpdateRunning,
} from "@agent-hand/bantou-protocol";
import type { Logger } from "./log.js";
import type { Pair } from "./pair.js";
import type { ServerLink, ServerPeer } from "./server-link.js";

/**
 * 発見した server の版を確かめ、組の版と違えば protocol `bantou` で更新を指示する。
 * 状態:
 *   ok          版が揃っている
 *   unsupported hello を知らない版（protocol 1.3.0 未満）。自動更新できない（手動で起動し直す）
 *   updating    更新指示済み。実行中の cap / worker の終了待ち、または再起動中
 *   mismatch    server の版は組と同じなのに protocol の版が違う（ビルドの不整合）
 *   failed      更新指示が断られた・取得に失敗した（center が再起動するまで同じ版を再指示しない）
 *   lost        updating のまま一定時間 server が戻らない
 *   unknown     hello に答えない（一時的な通信失敗など）
 */
export type FollowState = "ok" | "unsupported" | "updating" | "mismatch" | "failed" | "lost" | "unknown";

export interface FollowEntry {
  /** server を指す key（peer の summary。無ければ peer id）。peer id は再登録で変わる。 */
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
  /** updating の時、更新先と待っている件数。 */
  update?: { to: string; running?: UpdateRunning };
  /** この state になった時刻（ISO 8601）。 */
  since: string;
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
  /** link の門に差し込む。更新待ちの server への kick_cap を送る前に断る。 */
  gate(peer: { id: string }, command: ServerCommandType): ErrorReply | undefined;
}

/** 更新中のまま server が戻らないと見なす時間。 */
export const LOST_AFTER_MS = 15 * 60_000;
/** 周期。 */
export const CHECK_INTERVAL_MS = 30_000;
/** 更新中の server がいる間の周期（再起動後に早く ok へ戻すため）。 */
export const UPDATING_INTERVAL_MS = 5_000;

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

/** 更新待ちの server に kick_cap を送る前に center が断る error（server 側の断りと同じ形）。 */
export function updatingError(
  entry: { server_version?: string; update?: { to: string } },
  pair: Pair,
  command: ServerCommandType,
): ErrorReply {
  const from = entry.server_version ?? "?";
  const to = entry.update?.to ?? pair.server ?? "?";
  return {
    bantou: PROTOCOL_VERSION,
    type: "error",
    ok: false,
    message: `server 更新待ち（${from}→${to}）。実行中の cap/worker の終了後に再起動する。再起動後に再送`,
    command,
    code: "updating",
    retryable: true,
  };
}

interface Rec {
  entry: FollowEntry;
  /** 更新指示を断られた版（同じ版を再指示しない）。 */
  latched?: string;
  /** updating になった時刻（lost 判定）。 */
  updatingSince?: number;
}

export function createFollow(opts: {
  link: ServerLink;
  pair: Pair;
  log: Logger;
  intervalMs?: number;
  lostAfterMs?: number;
  now?: () => number;
}): Follow {
  const { link, pair, log } = opts;
  const now = opts.now ?? Date.now;
  const lostAfterMs = opts.lostAfterMs ?? LOST_AFTER_MS;
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

  function set(rec: Rec, patch: Partial<FollowEntry> & { state: FollowState; detail: string }): void {
    const changed = rec.entry.state !== patch.state || rec.entry.detail !== patch.detail;
    const stateChanged = rec.entry.state !== patch.state;
    const next: FollowEntry = { ...rec.entry, ...patch };
    if (patch.update === undefined) delete next.update;
    if (stateChanged) next.since = new Date(now()).toISOString();
    if (patch.state === "updating") rec.updatingSince ??= now();
    else rec.updatingSince = undefined;
    rec.entry = next;
    if (changed) log(`server 版: ${next.name}(${next.id}) ${next.state} ${next.detail}`);
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
          state: "unknown",
          detail: "確認中",
          since: new Date(now()).toISOString(),
        },
      };
      recs.set(key, rec);
    }
    rec.entry.id = p.id;
    rec.entry.name = p.name;
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
    if (hello.type !== "hello_result") {
      if (rec.entry.state === "updating") return; // 再起動中の取りこぼしは更新中のまま
      set(rec, { state: "unknown", detail: `版を確認できない: ${hello.type === "error" ? hello.message : "不明な返信"}` });
      return;
    }
    rec.entry.server_version = hello.server_version;
    rec.entry.protocol_version = hello.protocol_version;
    const protocolOk = hello.protocol_version === MESSENGER_PROTOCOL.version;
    const sv = hello.server_version;
    const target = pair.server;

    if (hello.update) {
      set(rec, {
        state: "updating",
        detail: `更新中（${hello.update.from}→${hello.update.to}）: cap ${hello.update.running.caps} / worker ${hello.update.running.workers} の終了待ち`,
        update: { to: hello.update.to, running: hello.update.running },
      });
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
    // 版が違う: 更新を指示する（新旧は比べない）
    const failedTo = hello.last_update?.to === target ? hello.last_update : undefined;
    if (rec.latched === target || failedTo) {
      rec.latched = target;
      set(rec, { state: "failed", detail: `更新に失敗（→${target}）: ${failedTo?.error ?? "指示を断られた"}` });
      return;
    }
    const upd = await link.updateServer(p, target);
    if (upd.type === "update_result") {
      if (upd.state === "current") {
        set(rec, protocolOk ? { state: "ok", detail: "版が一致" } : { state: "mismatch", detail: `protocol の版が違う（server=${hello.protocol_version}）` });
      } else {
        set(rec, {
          state: "updating",
          detail: `更新中（${upd.from}→${upd.to}）: cap ${upd.running.caps} / worker ${upd.running.workers} の終了待ち`,
          update: { to: upd.to, running: upd.running },
        });
        log(`更新を指示: ${p.name}(${p.id}) ${upd.from}->${upd.to} state=${upd.state}`);
      }
      return;
    }
    if (upd.type === "error") {
      if (upd.code === "update_conflict") {
        set(rec, { state: "updating", detail: `別の更新が進行中: ${upd.message}` });
        return;
      }
      rec.latched = target;
      set(rec, { state: "failed", detail: `更新に失敗（→${target}）: ${upd.message}` });
      return;
    }
    set(rec, { state: "unknown", detail: "update_server に不明な返信" });
  }

  /** 見えない server のうち、更新中のまま一定時間戻らないものを lost にする。 */
  function lostCheck(present: Set<string>): void {
    for (const [key, rec] of recs) {
      if (present.has(key) || rec.entry.state !== "updating") continue;
      if (rec.updatingSince !== undefined && now() - rec.updatingSince > lostAfterMs) {
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
    gate(peer, command) {
      if (command !== "kick_cap") return undefined;
      const key = byId.get(peer.id);
      const rec = key ? recs.get(key) : undefined;
      if (rec?.entry.state !== "updating") return undefined;
      return updatingError(rec.entry, pair, command);
    },
  };
}
