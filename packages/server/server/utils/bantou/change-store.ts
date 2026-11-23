import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isChangeState, isStepState, isValidAgentId, type ChangeState, type StepState } from "@agent-hand/bantou-protocol";

/**
 * change の記録（新しい経路）。<workspace>/changes/<change_id>/change.json に change ごと 1 file。
 * server が再起動しても、step の位置・worker_id・session_id・queue の順番が残る（設計書 3.5 の 2、3.6 の 3）。
 * 今の cap / task の記録（caps/・workers/<id>/logs/owner.json）には触らない。
 */

/** 通知先の center（register_change / worker_reply / worker_stop を送ってきた peer）。名前で覚え、送る時に今の peer id へ引く。 */
export interface NotifyTarget {
  id: string;
  name?: string;
}

export interface StepRecord {
  /** scope の 1 件。server は読まない。 */
  ref: string;
  state: StepState;
  /** server が採番した worker_id。起こした時に付く。 */
  worker_id?: string;
  /** その worker の session。run が終わった時に残す（state.json の値と同じ）。 */
  session_id?: string;
  /** queued の時の、次の worker の起動に渡す指示文。 */
  prompt?: string;
  /** queued の時の、queue の順番（小さい方が先。M2: 来た順）。 */
  queued_seq?: number;
  /** 最後の report（progress / done は知らせず、記録に残すだけ）。 */
  last_report?: { kind: string; at: string };
  /** 起動の通し番号。run の終わりが古い起動の物かを見分ける。 */
  launches: number;
}

export interface ChangeRecord {
  change_id: string;
  state: ChangeState;
  repo: string;
  branch?: string;
  worker_model?: string;
  /** center が付けた通知先の鍵。 */
  notify_id: string;
  notify_to?: NotifyTarget;
  /** 最後に登録した scope の先頭の step の位置（steps は再登録のたびに後ろへ足す）。 */
  scope_start: number;
  steps: StepRecord[];
  reason?: string;
  updated_at: string;
}

const changesDir = (workspace: string): string => join(workspace, "changes");
const changeDir = (workspace: string, changeId: string): string => {
  if (!isValidAgentId(changeId)) throw new Error(`change_id が不正: ${changeId}`);
  return join(changesDir(workspace), changeId);
};
const recordFile = (workspace: string, changeId: string): string => join(changeDir(workspace, changeId), "change.json");

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const optStr = (v: unknown): boolean => v === undefined || typeof v === "string";

function isStepRecord(v: unknown): v is StepRecord {
  return (
    isRecord(v) &&
    typeof v.ref === "string" &&
    isStepState(v.state) &&
    optStr(v.worker_id) &&
    optStr(v.session_id) &&
    optStr(v.prompt) &&
    (v.last_report === undefined || (isRecord(v.last_report) && typeof v.last_report.kind === "string" && typeof v.last_report.at === "string")) &&
    (v.queued_seq === undefined || (typeof v.queued_seq === "number" && Number.isInteger(v.queued_seq))) &&
    typeof v.launches === "number" &&
    Number.isInteger(v.launches)
  );
}

export function isChangeRecord(v: unknown): v is ChangeRecord {
  return (
    isRecord(v) &&
    isValidAgentId(v.change_id) &&
    isChangeState(v.state) &&
    typeof v.repo === "string" &&
    optStr(v.branch) &&
    optStr(v.worker_model) &&
    isValidAgentId(v.notify_id) &&
    (v.notify_to === undefined || (isRecord(v.notify_to) && typeof v.notify_to.id === "string" && optStr(v.notify_to.name))) &&
    typeof v.scope_start === "number" &&
    Array.isArray(v.steps) &&
    v.steps.every(isStepRecord) &&
    optStr(v.reason) &&
    typeof v.updated_at === "string"
  );
}

export interface ChangeStore {
  /** 全ての change を読む（壊れた file は log に出して飛ばす）。 */
  loadAll(): Promise<ChangeRecord[]>;
  /** 書く（tmp に書いて rename）。同じ change への書き込みは順に行う。 */
  save(rec: ChangeRecord): Promise<void>;
  /** 書き込みが済むのを待つ。 */
  flush(): Promise<void>;
}

export function createChangeStore(workspace: string, log: (msg: string) => void): ChangeStore {
  const chains = new Map<string, Promise<void>>();

  async function write(rec: ChangeRecord): Promise<void> {
    const dir = changeDir(workspace, rec.change_id);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.change.json.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
    try {
      await writeFile(tmp, JSON.stringify(rec, null, 2) + "\n");
      await rename(tmp, recordFile(workspace, rec.change_id));
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
  }

  return {
    async loadAll() {
      let names: string[];
      try {
        names = (await readdir(changesDir(workspace), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
      } catch {
        return [];
      }
      const out: ChangeRecord[] = [];
      for (const name of names.sort()) {
        if (!isValidAgentId(name)) continue;
        try {
          const d: unknown = JSON.parse(await readFile(recordFile(workspace, name), "utf8"));
          if (isChangeRecord(d) && d.change_id === name) out.push(d);
          else log(`change の記録の形が不正（飛ばす）: ${name}`);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") log(`change の記録を読めない（飛ばす）: ${name} ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return out;
    },
    save(rec) {
      // 後の値が先に書かれないよう、同じ change は順に書く。書く内容は呼んだ時点の写し
      const snapshot = structuredClone(rec);
      const prev = chains.get(rec.change_id) ?? Promise.resolve();
      const next = prev.then(() => write(snapshot)).catch((e: unknown) => log(`change の記録を書けない: ${rec.change_id} ${e instanceof Error ? e.message : String(e)}`));
      chains.set(rec.change_id, next);
      return next;
    },
    async flush() {
      await Promise.all([...chains.values()]);
    },
  };
}
