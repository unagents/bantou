import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  isValidAgentId,
  type ActivityNotice,
  type RunOutcome,
  type ServerNotice,
  type ServerReply,
} from "@agent-hand/bantou-protocol";
import type { InvokeInput } from "./agents";
import { agentDir, runLogDir } from "./paths";

export const REPORT_KINDS = ["progress", "ask", "approve", "done"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const isReportKind = (v: unknown): v is ReportKind =>
  typeof v === "string" && (REPORT_KINDS as readonly string[]).includes(v);

/** report の本文の上限（文字数）。 */
export const MAX_REPORT_TEXT = 20_000;

/** worker から受けた report を cap の resume prompt にする。 */
export function buildReportPrompt(
  workerId: string,
  kind: ReportKind,
  text: string,
): string {
  return [
    `worker ${workerId} から ${kind}: ${text}`,
    "",
    "（worker へ返す時は worker_start に同じ worker_id を渡す）",
  ].join("\n");
}

export interface ReportHubDeps {
  workspace: string;
  /** cap を起動する。同一 cap の直列化は呼び出し先（manager）の queue が担う。 */
  invoke: (capId: string, input: InvokeInput) => Promise<RunOutcome>;
  /** center（messenger の peer id）へ返信・通知を送る。 */
  send: (centerId: string, reply: ServerReply | ServerNotice) => Promise<void>;
  log: (msg: string) => void;
}

export interface ReportHub {
  /** cap を依頼した center を記録する（メモリと logs/center.json）。 */
  rememberCenter(capId: string, centerId: string): Promise<void>;
  /** worker の report を記録し、cap の resume を queue に積む。積んだ時点で戻る。 */
  report(capId: string, workerId: string, kind: ReportKind, text: string): Promise<void>;
  /** cap を依頼した center へ activity 通知を送る。center が不明なら何もしない。失敗は投げる。 */
  notify(capId: string, notice: ActivityNotice): Promise<void>;
  /** report 起因の実行がすべて終わる（返信を出し切る）のを待つ。 */
  drain(): Promise<void>;
  /** 以降の report を拒否する。 */
  close(): void;
}

const oneLine = (s: string, n: number): string => s.replace(/\s+/g, " ").trim().slice(0, n);

/** center の記録先。state.json は agents.ts が丸ごと書き換えるので別ファイルにする。 */
const centerFile = (capDir: string): string => join(runLogDir(capDir), "center.json");
const reportsFile = (capDir: string): string => join(runLogDir(capDir), "reports.jsonl");

export function createReportHub(deps: ReportHubDeps): ReportHub {
  const { log } = deps;
  const centers = new Map<string, string>();
  const pending = new Set<Promise<void>>();
  let closed = false;

  async function centerOf(capId: string): Promise<string | undefined> {
    const known = centers.get(capId);
    if (known) return known;
    try {
      const d = JSON.parse(await readFile(centerFile(agentDir(deps.workspace, "cap", capId)), "utf8")) as {
        center_id?: unknown;
      };
      if (typeof d.center_id === "string" && d.center_id !== "") {
        centers.set(capId, d.center_id);
        return d.center_id;
      }
    } catch {
      // 記録が無い・壊れている場合は返信先なし
    }
    return undefined;
  }

  async function rememberCenter(capId: string, centerId: string): Promise<void> {
    centers.set(capId, centerId);
    const dir = runLogDir(agentDir(deps.workspace, "cap", capId));
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(centerFile(agentDir(deps.workspace, "cap", capId)), JSON.stringify({ center_id: centerId }) + "\n");
    } catch (e) {
      log(`center 記録失敗: cap_id=${capId} ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function route(capId: string, reply: ServerReply): Promise<void> {
    const to = await centerOf(capId);
    if (!to) {
      log(`返信先 center が不明: cap_id=${capId} type=${reply.type}`);
      return;
    }
    try {
      await deps.send(to, reply);
      log(`返信: to=${to} type=${reply.type} (report 起因) cap_id=${capId}`);
    } catch (e) {
      log(`返信失敗: to=${to} ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function notify(capId: string, notice: ActivityNotice): Promise<void> {
    const to = await centerOf(capId);
    if (!to) return;
    await deps.send(to, notice);
    log(`activity 通知: to=${to} cap_id=${capId} ${notice.agents.map((a) => `${a.id}=${a.state}`).join(" ")}`);
  }

  async function report(capId: string, workerId: string, kind: ReportKind, text: string): Promise<void> {
    if (closed) throw new Error("server 終了中");
    if (!isValidAgentId(capId)) throw new Error(`cap_id が不正: ${capId}`);
    if (!isValidAgentId(workerId)) throw new Error(`worker_id が不正: ${workerId}`);
    if (!isReportKind(kind)) throw new Error(`kind が不正: ${String(kind)}`);
    if (text.length === 0 || text.length > MAX_REPORT_TEXT) {
      throw new Error(`text は 1..${MAX_REPORT_TEXT} 文字`);
    }
    const capDir = agentDir(deps.workspace, "cap", capId);
    try {
      await stat(capDir);
    } catch {
      throw new Error(`cap が存在しない: ${capId}`);
    }
    await mkdir(runLogDir(capDir), { recursive: true });
    await appendFile(
      reportsFile(capDir),
      JSON.stringify({ at: new Date().toISOString(), worker_id: workerId, kind, text }) + "\n",
    );
    log(`report 受信: cap_id=${capId} worker_id=${workerId} kind=${kind} text=${oneLine(text, 80)}`);

    const prompt = buildReportPrompt(workerId, kind, text);
    const p: Promise<void> = deps
      .invoke(capId, { prompt, reason: `report from worker ${workerId}`, keepTask: true })
      .then(
        (r) => route(capId, { bantou: PROTOCOL_VERSION, type: "cap_result", cap_id: capId, ...r }),
        (e: unknown) => {
          const message = e instanceof Error ? e.message : String(e);
          log(`エラー: report 起因の resume: cap_id=${capId} ${message}`);
          return route(capId, {
            bantou: PROTOCOL_VERSION,
            type: "error",
            ok: false,
            message,
            command: "kick_cap",
            cap_id: capId,
          });
        },
      )
      .finally(() => pending.delete(p));
    pending.add(p);
  }

  return {
    rememberCenter,
    report,
    notify,
    drain: async () => {
      await Promise.allSettled([...pending]);
    },
    close: () => {
      closed = true;
    },
  };
}

// -- /mcp route との橋渡し -------------------------------------------------------

export type ReportHandler = (capId: string, workerId: string, kind: ReportKind, text: string) => Promise<void>;

let handler: ReportHandler | undefined;

/** daemon が起動後に設定する。未設定の間の /mcp は report を拒否する。 */
export function setReportHandler(h: ReportHandler | undefined): void {
  handler = h;
}

export function getReportHandler(): ReportHandler | undefined {
  return handler;
}
