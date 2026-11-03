import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  isValidAgentId,
  type ActivityNotice,
  type RunOutcome,
  type ServerNotice,
  type ServerReply,
  type WorkerReportNotice,
} from "@agent-hand/bantou-protocol";
import type { InvokeInput } from "./agents";
import { agentDir, runLogDir } from "./paths";
import { extractTaskResult } from "./prompts";

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
  /**
   * 今 messenger にいる、この名前の peer を返す（center の再起動で peer id が変わるので、送る時に名前から id を引く）。
   * 省略時・失敗時は、覚えている peer id へそのまま送る。
   */
  resolvePeers?: (name: string) => Promise<ReadonlyArray<{ id: string; registered_at?: string }>>;
  log: (msg: string) => void;
}

export interface ReportHub {
  /**
   * cap を依頼した center を記録する（メモリと logs/center.json。cap の dir が無ければ作る）。
   * name = center の peer 名。名前で覚えると、center の再起動で peer id が変わっても送る時に今の id へ引ける。
   */
  rememberCenter(capId: string, centerId: string, centerName?: string): Promise<void>;
  /**
   * 通知先の center を更新する（status / stop_cap / worker_reply など、cap を作らない命令の送信元）。
   * メモリは常に更新し、logs/center.json は cap の dir がある時だけ書く（無い cap の dir を作らない）。
   */
  noteCenter(capId: string, centerId: string, centerName?: string): Promise<void>;
  /** cap の最新の task_id を記録する（メモリと logs/task.json）。worker_report と report 起因の task_result に使う。 */
  rememberTask(capId: string, taskId: string): Promise<void>;
  /** worker の report を記録し、cap の resume を queue に積む。積んだ時点で戻る。 */
  report(capId: string, workerId: string, kind: ReportKind, text: string): Promise<void>;
  /** cap を依頼した center へ activity 通知を送る。center が不明なら何もしない。失敗は投げる。 */
  notify(capId: string, notice: ActivityNotice): Promise<void>;
  /** report 起因の実行がすべて終わる（返信を出し切る）のを待つ。 */
  drain(): Promise<void>;
  /** report 起因で処理中（cap の resume と返信の送信）の件数。 */
  pendingCount(): number;
  /** 以降の report を拒否する。 */
  close(): void;
}

const oneLine = (s: string, n: number): string => s.replace(/\s+/g, " ").trim().slice(0, n);

/** center の記録先。state.json は agents.ts が丸ごと書き換えるので別ファイルにする。 */
const centerFile = (capDir: string): string => join(runLogDir(capDir), "center.json");
const taskFile = (capDir: string): string => join(runLogDir(capDir), "task.json");
const reportsFile = (capDir: string): string => join(runLogDir(capDir), "reports.jsonl");

export function createReportHub(deps: ReportHubDeps): ReportHub {
  const { log } = deps;
  /** cap → 通知先 center。id = 最後に命令を送ってきた peer id、name = その peer 名。 */
  const centers = new Map<string, { id: string; name?: string }>();
  const tasks = new Map<string, string>();
  const pending = new Set<Promise<void>>();
  /** worker_report 通知の送信中。更新の再起動待ち（pendingCount）には数えず、drain だけが待つ。 */
  const notices = new Set<Promise<void>>();
  let closed = false;

  async function taskOf(capId: string): Promise<string | undefined> {
    const known = tasks.get(capId);
    if (known) return known;
    try {
      const d = JSON.parse(await readFile(taskFile(agentDir(deps.workspace, "cap", capId)), "utf8")) as { task_id?: unknown };
      if (isValidAgentId(d.task_id)) {
        tasks.set(capId, d.task_id);
        return d.task_id;
      }
    } catch {
      // 記録が無い・壊れている場合は task 無し
    }
    return undefined;
  }

  async function rememberTask(capId: string, taskId: string): Promise<void> {
    tasks.set(capId, taskId);
    const capDir = agentDir(deps.workspace, "cap", capId);
    try {
      await mkdir(runLogDir(capDir), { recursive: true });
      await writeFile(taskFile(capDir), JSON.stringify({ task_id: taskId }) + "\n");
    } catch (e) {
      log(`task 記録失敗: cap_id=${capId} ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function sendReportNotice(capId: string, notice: WorkerReportNotice): Promise<void> {
    const to = await centerOf(capId);
    if (!to) {
      log(`通知先 center が不明: cap_id=${capId} type=${notice.type}`);
      return;
    }
    try {
      await deps.send(to, notice);
      log(`worker_report 通知: to=${to} cap_id=${capId} worker_id=${notice.worker_id} kind=${notice.kind}`);
    } catch (e) {
      log(`worker_report 通知失敗: to=${to} ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 覚えている center（メモリ → logs/center.json）。旧形式の記録は peer id のみで名前が無い。 */
  async function centerRecord(capId: string): Promise<{ id: string; name?: string } | undefined> {
    const known = centers.get(capId);
    if (known) return known;
    try {
      const d = JSON.parse(await readFile(centerFile(agentDir(deps.workspace, "cap", capId)), "utf8")) as {
        center_id?: unknown;
        center_name?: unknown;
      };
      if (typeof d.center_id === "string" && d.center_id !== "") {
        const rec = { id: d.center_id, ...(typeof d.center_name === "string" && d.center_name !== "" ? { name: d.center_name } : {}) };
        centers.set(capId, rec);
        return rec;
      }
    } catch {
      // 記録が無い・壊れている場合は返信先なし
    }
    return undefined;
  }

  /**
   * 送る時点の center の peer id。名前を覚えていれば messenger の今の peer から引く:
   * 覚えている id がまだいればそれ（同名が複数いる時に最後に命令を送ってきた id を優先）、いなければ最後に登録した同名の peer。
   * 名前が無い・引けない・同名が居ない時は覚えている id。
   */
  async function centerOf(capId: string): Promise<string | undefined> {
    const rec = await centerRecord(capId);
    if (!rec) return undefined;
    if (!rec.name || !deps.resolvePeers) return rec.id;
    let peers: ReadonlyArray<{ id: string; registered_at?: string }>;
    try {
      peers = await deps.resolvePeers(rec.name);
    } catch (e) {
      log(`center の peer を引けない（覚えている id へ送る）: name=${rec.name} ${e instanceof Error ? e.message : String(e)}`);
      return rec.id;
    }
    if (peers.length === 0 || peers.some((p) => p.id === rec.id)) return rec.id;
    const latest = [...peers].sort((x, y) => (y.registered_at ?? "").localeCompare(x.registered_at ?? ""))[0]!;
    log(`center の peer id が変わった: cap_id=${capId} name=${rec.name} ${rec.id} -> ${latest.id}`);
    centers.set(capId, { id: latest.id, name: rec.name });
    return latest.id;
  }

  async function writeCenter(capId: string, centerId: string, centerName: string | undefined, create: boolean): Promise<void> {
    centers.set(capId, { id: centerId, ...(centerName ? { name: centerName } : {}) });
    const capDir = agentDir(deps.workspace, "cap", capId);
    try {
      if (!create) await stat(capDir);
      await mkdir(runLogDir(capDir), { recursive: true });
      await writeFile(centerFile(capDir), JSON.stringify({ center_id: centerId, ...(centerName ? { center_name: centerName } : {}) }) + "\n");
    } catch (e) {
      // cap の dir が無い（noteCenter）時はメモリだけ。それ以外の失敗はログ
      if (!create && (e as NodeJS.ErrnoException).code === "ENOENT") return;
      log(`center 記録失敗: cap_id=${capId} ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const rememberCenter = (capId: string, centerId: string, centerName?: string): Promise<void> => writeCenter(capId, centerId, centerName, true);
  const noteCenter = (capId: string, centerId: string, centerName?: string): Promise<void> => writeCenter(capId, centerId, centerName, false);

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
    const at = new Date().toISOString();
    await appendFile(reportsFile(capDir), JSON.stringify({ at, worker_id: workerId, kind, text }) + "\n");
    log(`report 受信: cap_id=${capId} worker_id=${workerId} kind=${kind} text=${oneLine(text, 80)}`);

    // center へは cap の再開と並行して送る（worker_report 通知。失敗しても再開は止めない）
    const taskId = await taskOf(capId);
    const notice: WorkerReportNotice = {
      bantou: PROTOCOL_VERSION,
      type: "worker_report",
      cap_id: capId,
      ...(taskId !== undefined ? { task_id: taskId } : {}),
      worker_id: workerId,
      kind,
      text,
      at,
    };
    const n: Promise<void> = sendReportNotice(capId, notice).finally(() => notices.delete(n));
    notices.add(n);

    const prompt = buildReportPrompt(workerId, kind, text);
    const p: Promise<void> = deps
      .invoke(capId, { prompt, reason: `report from worker ${workerId}`, keepTask: true })
      .then(
        (r) => {
          // task 指示中の cap が task_result の JSON で答えたら task_result、そうでなければ従来どおり cap_result
          const tr = taskId !== undefined && r.ok ? extractTaskResult(capId, taskId, r.result_text) : undefined;
          return route(capId, tr ?? { bantou: PROTOCOL_VERSION, type: "cap_result", cap_id: capId, ...r });
        },
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
    noteCenter,
    rememberTask,
    report,
    notify,
    drain: async () => {
      await Promise.allSettled([...pending, ...notices]);
    },
    pendingCount: () => pending.size,
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
