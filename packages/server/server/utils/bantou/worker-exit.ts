import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isValidAgentId, type AgentKind } from "@agent-hand/bantou-protocol";
import type { RunObserver } from "./agents";
import { STOP_MSG } from "./agents";
import { agentDir, laneDir, runLogDir } from "./paths";
import { readState } from "./state";
import { readOwnerRecord } from "./workers";
import type { ReportKind } from "./reports";

/** worker の終わり方。 */
export type ExitCause = "failed" | "timeout" | "lost" | "no_report";

/** cap へ渡す、worker の終了の内容。 */
export interface WorkerExitInfo {
  worker_id: string;
  cause: ExitCause;
  error?: string;
  /** その run の間の最後の report。 */
  last_report?: { at: string; kind: ReportKind };
  /** その run の間の report の件数。 */
  report_count: number;
}

const oneLine = (s: string, n: number): string => s.replace(/\s+/g, " ").trim().slice(0, n);

const CAUSE_TEXT: Record<ExitCause, string> = {
  failed: "失敗で終了",
  timeout: "時間切れで終了（再試行を使い切った）",
  lost: "server 以外の signal で終了",
  no_report: "done の report を出さずに終了",
};

/** cap の resume prompt。先頭行 `[worker 終了通知]` は CAP_GUIDE が見分ける。 */
export function buildExitPrompt(info: WorkerExitInfo, n: number, max: number): string {
  return [
    "[worker 終了通知]",
    `worker_id: ${info.worker_id}`,
    `終わり方: ${info.cause}（${CAUSE_TEXT[info.cause]}）`,
    ...(info.error !== undefined ? [`error: ${oneLine(info.error, 300)}`] : []),
    `最後の report: ${info.last_report ? `${info.last_report.at} ${info.last_report.kind}` : "なし"}（この run の report ${info.report_count} 件）`,
    `この task での再開: ${n}/${max} 回目`,
    "",
    "（状態を確かめ、続けるなら worker_start に同じ worker_id を渡す。続けないなら最終返答に書いて終える）",
  ].join("\n");
}

/** task ごとの再開の回数。cap の logs/exit-resumes.json（task の lane の worker は lane の logs/exit-resumes.json）。 */
interface ResumeCount {
  task_id: string;
  count: number;
}

const countFile = (capDir: string): string => join(runLogDir(capDir), "exit-resumes.json");
/** 回数の記録の key と置き場。lane の worker は `<cap_id>/<task_id>` で、lane の dir に置く。 */
const countKey = (capId: string, lane: string | undefined): string => (lane === undefined ? capId : `${capId}/${lane}`);
/** その worker の、どの run まで通知の判断を済ませたか。worker の logs/exit-handled.json。 */
const handledFile = (workerDir: string): string => join(runLogDir(workerDir), "exit-handled.json");

export interface WorkerExitDeps {
  workspace: string;
  /** task ごとの再開の上限。 */
  maxResumes: number;
  /** 起動時に拾う、worker の終了からの経過の上限（ms）。0 は拾わない。 */
  recoverMs: number;
  /** cap の再開を同期で積む（hub.resumeCap）。taskId = worker を起動した task の lane（あればその lane を再開する）。 */
  resumeCap: (capId: string, prompt: string, reason: string, taskId?: string) => Promise<void>;
  /** 上限超過を task の結果として知らせる（hub.failTask）。taskId = worker の task（あればその task を失敗にする）。 */
  failTask: (capId: string, message: string, taskId?: string) => Promise<void>;
  /** cap の最新の task_id（同期。分からなければ undefined）。 */
  knownTask: (capId: string) => string | undefined;
  taskId: (capId: string) => Promise<string | undefined>;
  /** cap を running として activity に出す／取り消す（tracker.holdCap / releaseCap）。taskId = 再開する lane。 */
  holdCap: (capId: string, taskId?: string) => void;
  releaseCap: (capId: string, taskId?: string) => void;
  /** worker の持ち主 cap（tracker の記録。同期）。 */
  capOf: (workerId: string) => string | undefined;
  /** stop_cap で閉じた cap か（閉じた cap は worker の終了で再開しない）。 */
  isClosed?: (capId: string) => boolean;
  log: (msg: string) => void;
  now?: () => number;
}

export interface WorkerExitWatcher {
  /** worker の report を数える（setReportHandler から）。 */
  reported(workerId: string, kind: ReportKind, at: string): void;
  /**
   * observer.finished に差し込む。worker の終了を判定し、cap の再開を積み（または上限超過を知らせ）、
   * その後で inner（activity の更新）を呼ぶ。同期で済ませる: 積むのは inner（activity の送信）より前。
   */
  wrap(inner: RunObserver): RunObserver;
  /** server 起動時に、保存してある状態から、通知していない終了を 1 回だけ拾う。 */
  recover(): Promise<number>;
  /** 終わった task の lane の再開の回数（メモリ）を外す（lane を片付けた時）。 */
  forgetLane(capId: string, taskId: string): void;
}

const isReportKind = (k: unknown): k is ReportKind => k === "progress" || k === "ask" || k === "approve" || k === "done";

export function createWorkerExitWatcher(deps: WorkerExitDeps): WorkerExitWatcher {
  const { log } = deps;
  const now = deps.now ?? Date.now;
  /** worker → 受けた report（server 起動後のもの）。 */
  const seen = new Map<string, Array<{ at: string; kind: ReportKind }>>();
  /** cap → task ごとの再開の回数（メモリが正。ファイルは再起動用）。 */
  const counts = new Map<string, ResumeCount>();

  function reported(workerId: string, kind: ReportKind, at: string): void {
    const l = seen.get(workerId) ?? [];
    l.push({ at, kind });
    if (l.length > 200) l.splice(0, l.length - 200);
    seen.set(workerId, l);
  }

  const countDir = (capId: string, lane: string | undefined): string =>
    lane === undefined ? agentDir(deps.workspace, "cap", capId) : laneDir(deps.workspace, capId, lane);

  async function loadCount(capId: string, lane?: string): Promise<void> {
    const key = countKey(capId, lane);
    if (counts.has(key)) return;
    try {
      const d = JSON.parse(await readFile(countFile(countDir(capId, lane)), "utf8")) as Partial<ResumeCount>;
      if (typeof d.task_id === "string" && typeof d.count === "number" && Number.isInteger(d.count) && d.count >= 0) {
        if (!counts.has(key)) counts.set(key, { task_id: d.task_id, count: d.count });
      }
    } catch {
      // 記録なし
    }
  }

  async function persistCount(capId: string, lane?: string): Promise<void> {
    const c = counts.get(countKey(capId, lane));
    if (!c) return;
    try {
      const dir = countDir(capId, lane);
      await mkdir(runLogDir(dir), { recursive: true });
      await writeFile(countFile(dir), JSON.stringify(c) + "\n");
    } catch (e) {
      log(`exit-resumes 記録失敗: cap_id=${capId}${lane !== undefined ? ` task_id=${lane}` : ""} ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function markHandled(workerId: string, startedAt: string | undefined): Promise<void> {
    if (startedAt === undefined) return;
    try {
      const dir = agentDir(deps.workspace, "worker", workerId);
      await mkdir(runLogDir(dir), { recursive: true });
      await writeFile(handledFile(dir), JSON.stringify({ started_at: startedAt }) + "\n");
    } catch (e) {
      log(`exit-handled 記録失敗: worker_id=${workerId} ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function readHandled(workerId: string): Promise<string | undefined> {
    try {
      const d = JSON.parse(await readFile(handledFile(agentDir(deps.workspace, "worker", workerId)), "utf8")) as { started_at?: unknown };
      return typeof d.started_at === "string" ? d.started_at : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 再開するか決めて実行する（同期）。上限内なら cap を running にして再開を積み、超えたら task の結果に error を載せる。
   * lane = worker を起動した task。あれば、その task の指揮（lane）を再開し、回数もその task で数える。
   * 戻り値は「再開を積んだ」。
   */
  function dispatch(capId: string, lane: string | undefined, info: WorkerExitInfo, startedAt: string | undefined): boolean {
    const key = countKey(capId, lane);
    const task = lane ?? deps.knownTask(capId) ?? counts.get(key)?.task_id ?? "-";
    let c = counts.get(key);
    if (!c || c.task_id !== task) {
      c = { task_id: task, count: 0 };
      counts.set(key, c);
    }
    void markHandled(info.worker_id, startedAt);
    if (c.count >= deps.maxResumes) {
      const msg =
        `worker ${info.worker_id} が ${CAUSE_TEXT[info.cause]}したが、この task での cap の再開が上限（${deps.maxResumes} 回）に達したため再開しない` +
        `${info.error !== undefined ? `（error: ${oneLine(info.error, 200)}）` : ""}`;
      log(`worker 終了の再開を打ち切り: cap_id=${capId} worker_id=${info.worker_id} cause=${info.cause} count=${c.count}/${deps.maxResumes} task=${task}`);
      // 順序: cap を running にする → task_result(failed) を先に送る → 送り終えたら idle に戻す（worker の activity はその間に出る。center が成功扱いで先に完了にしない）
      deps.holdCap(capId, lane);
      void deps
        .failTask(capId, msg, lane)
        .catch((e: unknown) => log(`上限超過の通知失敗: cap_id=${capId} ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => deps.releaseCap(capId, lane));
      return false;
    }
    c.count++;
    void persistCount(capId, lane);
    log(`worker 終了で cap を再開: cap_id=${capId} worker_id=${info.worker_id} cause=${info.cause} count=${c.count}/${deps.maxResumes} task=${task}`);
    // 順序: cap を running にする → 再開を積む（manager の queue。cap が turn の途中なら順番待ち）。worker の activity はこの後
    deps.holdCap(capId, lane);
    void deps
      .resumeCap(capId, buildExitPrompt(info, c.count, deps.maxResumes), `worker ${info.worker_id} exit (${info.cause})`, lane)
      .finally(() => deps.releaseCap(capId, lane));
    return true;
  }

  /** その run の間の report。 */
  const reportsDuring = (workerId: string, startedAt: string | undefined): Array<{ at: string; kind: ReportKind }> =>
    (seen.get(workerId) ?? []).filter((r) => startedAt === undefined || r.at >= startedAt);

  const answered = (rs: Array<{ kind: ReportKind }>): boolean => rs.some((r) => r.kind === "done");

  function onFinished(kind: AgentKind, id: string, o: Parameters<RunObserver["finished"]>[2]): void {
    if (kind !== "worker" || o.stopped === true || o.error === STOP_MSG) return;
    const capId = deps.capOf(id);
    if (capId === undefined || capId === "") return;
    if (deps.isClosed?.(capId) === true) {
      // 閉じた cap は起こさない。回収（recover）でも拾わないよう済みにする
      log(`閉じた cap の worker の終了は再開しない: cap_id=${capId} worker_id=${id}`);
      void markHandled(id, o.startedAt);
      return;
    }
    const rs = reportsDuring(id, o.startedAt);
    let cause: ExitCause;
    if (!o.ok) cause = o.timedOut === true ? "timeout" : o.lost ? "lost" : "failed";
    else if (!answered(rs)) cause = "no_report";
    else {
      void markHandled(id, o.startedAt);
      return;
    }
    const last = rs[rs.length - 1];
    dispatch(
      capId,
      o.taskId,
      {
        worker_id: id,
        cause,
        ...(o.error !== undefined ? { error: o.error } : {}),
        ...(last ? { last_report: last } : {}),
        report_count: rs.length,
      },
      o.startedAt,
    );
  }

  function wrap(inner: RunObserver): RunObserver {
    return {
      started: (k, id, input, pid) => inner.started(k, id, input, pid),
      // taskId（cap の task の lane）を落とさない: 落とすと lane の出力が lane の activity に届かず、出力していても stalled に見える
      line: (k, id, line, taskId) => inner.line(k, id, line, taskId),
      finished: (k, id, o) => {
        try {
          onFinished(k, id, o);
        } catch (e) {
          log(`worker 終了の判定に失敗: worker_id=${id} ${e instanceof Error ? e.message : String(e)}`);
        }
        inner.finished(k, id, o);
      },
    };
  }

  async function reportsOnDisk(capId: string, workerId: string): Promise<Array<{ at: string; kind: ReportKind }>> {
    try {
      const raw = await readFile(join(runLogDir(agentDir(deps.workspace, "cap", capId)), "reports.jsonl"), "utf8");
      const out: Array<{ at: string; kind: ReportKind }> = [];
      for (const line of raw.split("\n")) {
        if (line === "") continue;
        try {
          const d = JSON.parse(line) as { at?: unknown; worker_id?: unknown; kind?: unknown };
          if (d.worker_id === workerId && typeof d.at === "string" && isReportKind(d.kind)) out.push({ at: d.at, kind: d.kind });
        } catch {
          // 壊れた行は無視
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  async function recover(): Promise<number> {
    if (deps.recoverMs <= 0) return 0;
    let ids: string[];
    try {
      ids = (await readdir(join(deps.workspace, "workers"), { withFileTypes: true })).filter((d) => d.isDirectory() && isValidAgentId(d.name)).map((d) => d.name).sort();
    } catch {
      return 0;
    }
    let resumed = 0;
    for (const id of ids) {
      try {
        const dir = agentDir(deps.workspace, "worker", id);
        const st = await readState(dir).catch(() => null);
        if (st === null || st.state === "running" || st.last_started_at === null || st.last_finished_at === null) continue;
        if (st.state !== "idle" && st.state !== "failed") continue;
        if (st.last_error === STOP_MSG) continue;
        if (now() - Date.parse(st.last_finished_at) > deps.recoverMs) continue;
        if ((await readHandled(id)) === st.last_started_at) continue;
        const owner = await readOwnerRecord(deps.workspace, id);
        if (owner === undefined) continue;
        const { capId, taskId: lane } = owner;
        if (deps.isClosed?.(capId) === true) {
          log(`回収: 閉じた cap の worker の終了は再開しない: cap_id=${capId} worker_id=${id}`);
          await markHandled(id, st.last_started_at);
          continue;
        }
        // cap（task の worker はその task の lane）が無い・会話が閉じている
        const capSt = await readState(lane === undefined ? agentDir(deps.workspace, "cap", capId) : laneDir(deps.workspace, capId, lane)).catch(() => null);
        if (capSt === null || capSt.session_id === null) continue;
        await loadCount(capId, lane);
        await deps.taskId(capId);
        const rs = (await reportsOnDisk(capId, id)).filter((r) => r.at >= st.last_started_at!);
        if (st.state === "idle" && answered(rs)) {
          await markHandled(id, st.last_started_at);
          continue;
        }
        const last = rs[rs.length - 1];
        const info: WorkerExitInfo = {
          worker_id: id,
          cause: st.state === "idle" ? "no_report" : "failed",
          ...(st.state === "failed" && st.last_error !== undefined ? { error: st.last_error } : {}),
          ...(last ? { last_report: last } : {}),
          report_count: rs.length,
        };
        if (dispatch(capId, lane, info, st.last_started_at)) resumed++;
      } catch (e) {
        log(`終了した worker の回収に失敗: worker_id=${id} ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return resumed;
  }

  return { reported, wrap, recover, forgetLane: (capId, taskId) => void counts.delete(countKey(capId, taskId)) };
}
