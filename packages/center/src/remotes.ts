import { randomBytes } from "node:crypto";
import { z } from "zod";
import { AGENT_ID_PATTERN } from "@agent-hand/bantou-protocol";
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
  createdAt: string;
  finishedAt?: string;
  /** 結果の本文（cap_result.result_text）。RESULT_MAX で切る。 */
  result?: string;
  error?: string;
}

export const remoteCreateSchema = {
  prompt: z.string().min(1).refine((s) => !s.includes("\0"), { message: "NUL 文字を含められない" }).describe("remote-cap への最初の指示"),
  server: z.string().min(1).optional().describe("server の peer id（一致しなければ名前）。省略時は protocol bantou で発見した先頭"),
  repo: z.string().min(1).refine((s) => !s.startsWith("-") && !s.includes("\0"), { message: "- で始められない / NUL 不可" }).optional(),
  branch: z.string().min(1).refine((s) => !s.startsWith("-") && !s.includes("\0"), { message: "- で始められない / NUL 不可" }).optional(),
};

export interface RemoteManager {
  /** 保存済みの記録を読み込む。返信を待っていた running は center 再起動で返信を失うので failed にする。 */
  restore(): Promise<void>;
  /** remote-cap を作って kick_cap を送る。返信は待たず、running で返る。返信が来たら done / failed に更新。 */
  create(input: { owner: string; prompt: string; server?: string; repo?: string; branch?: string }): Promise<RemoteRecord>;
  /** stop_cap を送って記録を外す。owner が分かっていて記録の owner と違えば拒否。 */
  delete(input: { remote_id: string; owner?: string; force?: boolean }): Promise<{ remote_id: string; deleted: true; stopped: boolean; warning?: string }>;
  list(filter?: { owner?: string }): RemoteRecord[];
}

const truncate = (s: string): string => (s.length > RESULT_MAX ? `${s.slice(0, RESULT_MAX)}…(省略)` : s);

export function createRemoteManager(opts: {
  link: ServerLink;
  store: JsonListStore<RemoteRecord>;
  log: Logger;
  /** remote_id の採番（テスト用）。 */
  newId?: () => string;
}): RemoteManager {
  const { link, store, log } = opts;
  const newId = opts.newId ?? ((): string => `r-${randomBytes(5).toString("hex")}`);
  const records = new Map<string, RemoteRecord>();

  const persist = (): Promise<void> =>
    store.save([...records.values()]).catch((e: unknown) => log(`remotes 保存失敗: ${e instanceof Error ? e.message : String(e)}`));

  const finish = (r: RemoteRecord, patch: Partial<RemoteRecord>): void => {
    // delete 済みの記録は更新しない
    if (records.get(r.remote_id) !== r) return;
    Object.assign(r, patch, { finishedAt: new Date().toISOString() });
    void persist();
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
      const remote_id = newId();
      const rec: RemoteRecord = {
        remote_id,
        owner: input.owner,
        server: peer.id,
        serverName: peer.name,
        state: "running",
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
      await persist();
      log(`remote 削除: ${remote_id} stopped=${stopped}${warning ? ` warning=${warning}` : ""}`);
      return { remote_id, deleted: true, stopped, ...(warning ? { warning } : {}) };
    },

    list: (filter) => [...records.values()].filter((r) => filter?.owner === undefined || r.owner === filter.owner).map((r) => ({ ...r })),
  };
}
