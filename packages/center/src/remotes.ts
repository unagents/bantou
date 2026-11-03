import { randomBytes } from "node:crypto";
import { z } from "zod";
import { AGENT_ID_PATTERN, MODEL_PATTERN, type CapResultReply, type ErrorReply } from "@agent-hand/bantou-protocol";
import type { ActivityStore, RemoteActivity } from "./activity.js";
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

export type RemoteState = "running" | "done" | "failed";

/** center が保持する remote（server 上の remote-cap）の記録。メモリ + 状態ファイル。 */
export interface RemoteRecord {
  remote_id: string;
  owner: string;
  /** 作成時に選んだ server の peer id（peer id は再登録で変わるので、削除時は serverName でも探す）。 */
  server: string;
  serverName: string;
  state: RemoteState;
  /** 指定された remote-cap のモデル（`claude --model`）。省略時は無い。 */
  model?: string;
  /** 指定された worker の既定モデル。省略時は無い。 */
  worker_model?: string;
  createdAt: string;
  finishedAt?: string;
  /** 結果の本文（cap_result.result_text）。RESULT_MAX で切る。後の turn（report 起因の再開）の cap_result で最新に更新される。 */
  result?: string;
  error?: string;
  /** 完了通知を owner の session へ送れた時刻。送れていなければ無い。 */
  notifiedAt?: string;
  /** 完了通知を送れなかった理由（送れた時は無い）。 */
  notifyError?: string;
  /** 最後に通知を試みた結果の識別子（state + result + error）。同じ結果で二重に送らないための照合用。 */
  notifiedKey?: string;
}

/** remote_list が返す 1 件。通知がまだ無ければ activity は無い。 */
export type RemoteView = Omit<RemoteRecord, "notifiedKey"> & { activity?: RemoteActivity };

/** 通知に載せる result の先頭の長さ。 */
export const NOTIFY_RESULT_MAX = 500;
/** remote_wait の既定・上限（秒）。 */
export const WAIT_DEFAULT_SEC = 600;
export const WAIT_MAX_SEC = 1800;

export const remoteWaitSchema = {
  remote_id: z.string().regex(AGENT_ID_PATTERN, "英数字と _ - のみ").optional().describe("待つ remote。省略時は owner の running 中のどれか（最初に終わったもの）"),
  timeout_sec: z.number().int().min(1).max(WAIT_MAX_SEC).optional().describe(`待つ秒数。既定 ${WAIT_DEFAULT_SEC}、上限 ${WAIT_MAX_SEC}。超えたら state=running のまま返す`),
};

/** 通知の本文を作る。 */
export function formatDoneNotice(r: { remote_id: string; state: string; result?: string; error?: string }): string {
  const head = r.result === undefined ? "" : r.result.length > NOTIFY_RESULT_MAX ? `${r.result.slice(0, NOTIFY_RESULT_MAX)}…(省略。全文は remote_list)` : r.result;
  return [`[bantou] remote 完了 remote_id=${r.remote_id} state=${r.state}`, `result: ${head}`, ...(r.error ? [`error: ${r.error}`] : [])].join("\n");
}

const modelSchema = z.string().regex(MODEL_PATTERN, { message: "model は英数字と . _ [ ] - のみ（先頭は - 不可）" });

export const remoteCreateSchema = {
  prompt: z.string().min(1).refine((s) => !s.includes("\0"), { message: "NUL 文字を含められない" }).describe("remote-cap への最初の指示"),
  server: z.string().min(1).optional().describe("server の peer id（一致しなければ名前）。省略時は protocol bantou で発見した先頭"),
  repo: z.string().min(1).refine((s) => !s.startsWith("-") && !s.includes("\0"), { message: "- で始められない / NUL 不可" }).optional(),
  branch: z.string().min(1).refine((s) => !s.startsWith("-") && !s.includes("\0"), { message: "- で始められない / NUL 不可" }).optional(),
  model: modelSchema.optional().describe("remote-cap 自身のモデル（claude --model にそのまま渡す。例: sonnet / opus / haiku / claude-sonnet-5-5）。省略時は指定しない"),
  worker_model: modelSchema.optional().describe("この remote-cap が起動する worker の既定モデル（worker_start に model が無い時に使う）。省略時は指定しない"),
};

export interface RemoteManager {
  /** 保存済みの記録を読み込む。返信を待っていた running は center 再起動で返信を失うので failed にする。 */
  restore(): Promise<void>;
  /** remote-cap を作って kick_cap を送る。返信は待たず、running で返る。返信が来たら done / failed に更新。 */
  create(input: { owner: string; prompt: string; server?: string; repo?: string; branch?: string; model?: string; worker_model?: string }): Promise<RemoteRecord>;
  /** stop_cap を送って記録を外す。owner が分かっていて記録の owner と違えば拒否。 */
  delete(input: { remote_id: string; owner?: string; force?: boolean }): Promise<{ remote_id: string; deleted: true; stopped: boolean; warning?: string }>;
  /**
   * 最初の返信の後に server が送ってきた cap_result / error（kick_cap）を記録に反映する。
   * 記録が無い（delete 済み・cap_kick の cap）・まだ最初の返信待ちの時は何もしない。反映したら true。
   */
  applyLateReply(reply: CapResultReply | ErrorReply): boolean;
  list(filter?: { owner?: string }): RemoteView[];
  /** server から activity 通知を受けた時に呼ぶ。worker が全部終わって remote が完了したなら、完了通知を送る・待ちを起こす。 */
  onActivity(capId: string): void;
  /**
   * remote が終わる（list の state が done / failed）まで待って返す。remote_id 省略時は owner の running 中のどれかが終わるまで。
   * timeout なら state=running のまま返す。owner が分かっていて記録の owner と違えば拒否。
   */
  wait(input: { remote_id?: string; owner?: string; timeoutSec?: number }): Promise<RemoteView>;
}

const truncate = (s: string): string => (s.length > RESULT_MAX ? `${s.slice(0, RESULT_MAX)}…(省略)` : s);

export function createRemoteManager(opts: {
  link: ServerLink;
  store: JsonListStore<RemoteRecord>;
  log: Logger;
  /** server からの activity 通知の保持。省けば list に activity は付かない。 */
  activity?: ActivityStore;
  /** remote_id の採番（テスト用）。 */
  newId?: () => string;
  /** 完了通知の送り先。owner の session へ text を送る。省けば通知しない。 */
  notify?: (owner: string, text: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
}): RemoteManager {
  const { link, store, log } = opts;
  const newId = opts.newId ?? ((): string => `r-${randomBytes(5).toString("hex")}`);
  const records = new Map<string, RemoteRecord>();

  const persist = (): Promise<void> =>
    store.save([...records.values()]).catch((e: unknown) => log(`remotes 保存失敗: ${e instanceof Error ? e.message : String(e)}`));

  /** 完了通知待ちの remote_id（メモリのみ。center 再起動前に終わっていた記録を再通知しないため）。 */
  const awaiting = new Set<string>();
  const waiters = new Set<() => void>();

  const keyOf = (r: RemoteRecord): string => JSON.stringify([r.state, r.result ?? null, r.error ?? null]);

  /** list と同じ見え方。cap の turn が終わっていても、配下の worker か cap 自身が動いている間は running。 */
  const viewOf = (r: RemoteRecord): RemoteView => {
    const activity = opts.activity?.get(r.remote_id);
    const busy = r.state === "done" && activity?.agents.some((a) => (a.kind === "worker" || a.kind === "cap") && (a.state === "running" || a.state === "stalled"));
    const { notifiedKey: _k, ...rest } = r;
    const base: RemoteView = busy ? { ...rest, state: "running" } : { ...rest };
    if (busy) delete base.finishedAt;
    return { ...base, ...(activity ? { activity } : {}) };
  };

  const wake = (): void => {
    for (const w of [...waiters]) w();
  };

  /** 終わっていて通知待ちなら、owner の session へ 1 回送る。 */
  const maybeNotify = (r: RemoteRecord): void => {
    if (!awaiting.has(r.remote_id) || records.get(r.remote_id) !== r) return;
    // done は配下が動いている間は終わりでない。failed は見え方が変わらない
    if (viewOf(r).state === "running") return;
    awaiting.delete(r.remote_id);
    r.notifiedKey = keyOf(r);
    if (!opts.notify) return;
    const key = r.notifiedKey;
    void opts.notify(r.owner, formatDoneNotice(r)).then(
      (res) => res,
      (e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : String(e) }),
    ).then((res) => {
      // 送っている間に結果が更新された・消えた時は、この通知の結果を記録しない
      if (records.get(r.remote_id) !== r || r.notifiedKey !== key) return;
      if (res.ok) {
        r.notifiedAt = new Date().toISOString();
        delete r.notifyError;
        log(`remote 完了通知: ${r.remote_id} owner=${r.owner} state=${r.state}`);
      } else {
        delete r.notifiedAt;
        r.notifyError = res.reason;
        log(`remote 完了通知を送れない: ${r.remote_id} owner=${r.owner} ${res.reason}`);
      }
      void persist();
      wake();
    });
  };

  const finish = (r: RemoteRecord, patch: Partial<RemoteRecord>): void => {
    // delete 済みの記録は更新しない
    if (records.get(r.remote_id) !== r) return;
    Object.assign(r, patch, { finishedAt: new Date().toISOString() });
    // 同じ結果は二重に通知しない（通知済みの結果と同じなら待ちにしない）
    if (keyOf(r) !== r.notifiedKey) {
      awaiting.add(r.remote_id);
      delete r.notifiedAt;
      delete r.notifyError;
    }
    void persist();
    maybeNotify(r);
    wake();
  };

  /** 記録の server を今の peer から探す（id 一致 → 名前一致）。 */
  const findPeer = async (r: RemoteRecord): Promise<ServerPeer> => {
    const peers = await link.peers();
    const hit = peers.find((p) => p.id === r.server) ?? peers.find((p) => p.name === r.serverName);
    if (!hit) throw new Error(`server が見つからない: ${r.serverName}(${r.server})`);
    return hit;
  };

  return {
    async restore() {
      for (const r of await store.load()) {
        if (typeof r?.remote_id !== "string" || !AGENT_ID_PATTERN.test(r.remote_id)) continue;
        if (r.state === "running") {
          r.state = "failed";
          r.finishedAt = new Date().toISOString();
          r.error = "center 再起動で返信を受け取れなかった（server 側は実行を続けている可能性がある）";
        }
        records.set(r.remote_id, r);
      }
      if (records.size > 0) await persist();
      log(`remote 記録を読込: ${records.size} 件`);
    },

    async create(input) {
      if (!OWNER_PATTERN.test(input.owner)) throw new Error("owner は英数字と _ - のみ");
      const peer = await link.selectPeer(input.server);
      // protocol の版が合わない・更新待ちの server へは、記録を作らず isError で返す（master-cap が後で再送できる）
      const blocked = link.gate?.(peer, "kick_cap");
      if (blocked) throw new Error(blocked.message);
      const remote_id = newId();
      const rec: RemoteRecord = {
        remote_id,
        owner: input.owner,
        server: peer.id,
        serverName: peer.name,
        state: "running",
        ...(input.model ? { model: input.model } : {}),
        ...(input.worker_model ? { worker_model: input.worker_model } : {}),
        createdAt: new Date().toISOString(),
      };
      records.set(remote_id, rec);
      await persist();
      log(`remote 作成: ${remote_id} owner=${input.owner} server=${peer.name}(${peer.id})`);
      void link
        .kickCapOn(peer, {
          cap_id: remote_id,
          prompt: input.prompt,
          ...(input.repo ? { repo: input.repo } : {}),
          ...(input.branch ? { branch: input.branch } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.worker_model ? { worker_model: input.worker_model } : {}),
          reason: `remote_create owner=${input.owner}`,
        })
        .then(
          (reply) => {
            if (reply.type === "cap_result" && reply.ok) {
              finish(rec, { state: "done", result: truncate(reply.result_text) });
            } else {
              const error = reply.type === "cap_result" ? (reply.error ?? "失敗") : reply.type === "error" ? reply.message : "不明な返信";
              finish(rec, { state: "failed", error, ...(reply.type === "cap_result" ? { result: truncate(reply.result_text) } : {}) });
            }
            log(`remote 完了: ${remote_id} state=${rec.state}`);
          },
          (e: unknown) => finish(rec, { state: "failed", error: e instanceof Error ? e.message : String(e) }),
        );
      return { ...rec };
    },

    async delete({ remote_id, owner, force }) {
      const rec = records.get(remote_id);
      if (!rec) throw new Error(`未定義の remote: ${remote_id}`);
      if (owner !== undefined && owner !== rec.owner) throw new Error(`remote ${remote_id} は別の owner のもの`);
      let stopped = false;
      let warning: string | undefined;
      try {
        const peer = await findPeer(rec);
        const reply = await link.stopCapOn(peer, { cap_id: remote_id });
        if (reply.type === "stop_result") stopped = reply.stopped;
        else throw new Error(reply.type === "error" ? reply.message : "不明な返信");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // 実行中の記録を、止められないまま消さない。force か、既に終わっている記録なら消す
        if (rec.state === "running" && !force) throw new Error(`remote を止められない: ${msg}（force: true で記録だけ消せる）`);
        warning = `server へ stop_cap を送れなかった: ${msg}`;
      }
      records.delete(remote_id);
      awaiting.delete(remote_id);
      opts.activity?.forget(remote_id);
      wake();
      await persist();
      log(`remote 削除: ${remote_id} stopped=${stopped}${warning ? ` warning=${warning}` : ""}`);
      return { remote_id, deleted: true, stopped, ...(warning ? { warning } : {}) };
    },

    applyLateReply(reply) {
      const id = reply.cap_id;
      const rec = id === undefined ? undefined : records.get(id);
      // running は最初の返信待ち。ここへ来る返信は待ちに照合されるはずなので、取り違えを避けて触らない
      if (!rec || rec.state === "running") return false;
      if (reply.type === "cap_result" && reply.ok) {
        finish(rec, { state: "done", result: truncate(reply.result_text), error: undefined });
      } else if (reply.type === "cap_result") {
        finish(rec, { state: "failed", error: reply.error ?? "失敗", result: truncate(reply.result_text) });
      } else {
        finish(rec, { state: "failed", error: reply.message });
      }
      log(`remote 結果を更新: ${rec.remote_id} state=${rec.state}`);
      return true;
    },

    list: (filter) =>
      [...records.values()].filter((r) => filter?.owner === undefined || r.owner === filter.owner).map(viewOf),

    onActivity(capId) {
      const r = records.get(capId);
      if (r) maybeNotify(r);
      wake();
    },

    async wait({ remote_id, owner, timeoutSec }) {
      const sec = Math.min(Math.max(timeoutSec ?? WAIT_DEFAULT_SEC, 1), WAIT_MAX_SEC);
      let targets: RemoteRecord[];
      if (remote_id !== undefined) {
        const rec = records.get(remote_id);
        if (!rec) throw new Error(`未定義の remote: ${remote_id}`);
        if (owner !== undefined && owner !== rec.owner) throw new Error(`remote ${remote_id} は別の owner のもの`);
        targets = [rec];
      } else {
        if (owner === undefined) throw new Error("remote_id を省略するには owner（session）が必要");
        targets = [...records.values()].filter((r) => r.owner === owner && viewOf(r).state === "running");
        if (targets.length === 0) throw new Error("running の remote が無い");
      }
      const check = (): RemoteView | undefined => {
        for (const t of targets) {
          // 待っている間に delete された remote は、その時点で failed 扱いにはせず待ちから外す
          if (records.get(t.remote_id) !== t) continue;
          const v = viewOf(t);
          if (v.state !== "running") return v;
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
          else if (targets.every((t) => records.get(t.remote_id) !== t)) done(new Error("待っていた remote が削除された"));
        };
        const timer = setTimeout(() => {
          const v = check();
          const alive = targets.find((t) => records.get(t.remote_id) === t);
          if (v) done(v);
          else if (alive) done(viewOf(alive));
          else done(new Error("待っていた remote が削除された"));
        }, sec * 1000);
        waiters.add(w);
      });
    },
  };
}
