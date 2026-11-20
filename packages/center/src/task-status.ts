import type { RemoteView } from "./remotes.js";

/** task_status: 1 回の行数・全体の文字数・1 行の文字数の上限（設計書 3.12）。 */
export const TASK_STATUS_MAX_LINES = 40;
export const TASK_STATUS_MAX_CHARS = 6000;
export const TASK_STATUS_LINE_MAX = 200;

/** session 向け remote_list の既定の上限。worker の report の本文 / result の長さ（1 件）と、返り値全体の文字数。 */
export const REMOTE_LIST_REPORT_TEXT_MAX = 300;
export const REMOTE_LIST_RESULT_MAX = 2000;
export const REMOTE_LIST_TOTAL_MAX = 20000;

export interface TaskStatusLine {
  task_id: string;
  remote_id: string;
  line: string;
}

export interface TaskStatusResult {
  at: string;
  tasks: TaskStatusLine[];
  /** 行数・文字数の上限で落とした行があれば true。 */
  truncated: boolean;
  /** 落とした行の数。 */
  omitted: number;
}

const minutes = (ms: number): number => Math.max(0, Math.floor(ms / 60_000));

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

const stateLabel = (v: RemoteView, openAsks: number): string => {
  if (v.cap_state === "lost") return "lost";
  if (!v.reachability.reachable) return "不通";
  if (v.state === "unknown") return "不明";
  if (v.state === "failed") return "失敗";
  if (openAsks > 0) return "返答待ち";
  if (v.state === "done") return "完了";
  return "実行中";
};

/**
 * 呼んだ session の cap（views は owner で絞り済みの物）の未完了の task を、task ごとに 1 行にする。
 * 本文（report・result・summary・prompt）は入れない。件数・kind・時刻だけ。
 * 入力に他の session の cap が混ざっても出さない（owner の pending だけを数える）。
 */
export function buildTaskStatus(views: RemoteView[], owner: string, now: number, filter?: { remote_id?: string }): TaskStatusResult {
  const rows: { at: number; item: TaskStatusLine }[] = [];
  for (const v of views) {
    if (filter?.remote_id !== undefined && v.remote_id !== filter.remote_id) continue;
    if (v.session !== owner) continue;
    for (const p of v.pending) {
      if (p.owner !== owner || p.task_id === undefined) continue;
      const mine = v.worker_reports.filter((w) => w.task_id === p.task_id);
      const openAsks = mine.filter((w) => (w.kind === "ask" || w.kind === "approve") && w.replied_at === undefined && w.superseded_at === undefined).length;
      const last = mine.length > 0 ? mine[mine.length - 1]! : undefined;
      const sentAt = Date.parse(p.at);
      const parts = [
        p.task_id,
        v.server_label,
        stateLabel(v, openAsks),
        `経過 ${Number.isNaN(sentAt) ? "?" : minutes(now - sentAt)} 分`,
        last ? `最後の報告 ${last.kind} ${Number.isNaN(Date.parse(last.at)) ? "?" : minutes(now - Date.parse(last.at))} 分前` : "最後の報告 なし",
        `判断が要る ${openAsks}`,
      ];
      rows.push({ at: Number.isNaN(sentAt) ? 0 : sentAt, item: { task_id: p.task_id, remote_id: v.remote_id, line: clip(parts.join(" | "), TASK_STATUS_LINE_MAX) } });
    }
  }
  rows.sort((a, b) => a.at - b.at);
  const tasks: TaskStatusLine[] = [];
  let chars = 0;
  for (const r of rows) {
    if (tasks.length >= TASK_STATUS_MAX_LINES || chars + r.item.line.length > TASK_STATUS_MAX_CHARS) break;
    tasks.push(r.item);
    chars += r.item.line.length;
  }
  const omitted = rows.length - tasks.length;
  return { at: new Date(now).toISOString(), tasks, truncated: omitted > 0, omitted };
}

/** remote_list（session 向け）で、どこを切ったかの印。 */
export interface RemoteListCut {
  /** 切る前の worker_reports の件数。 */
  reports_total: number;
  /** 総量の上限で落とした worker_reports（古い順）の件数。 */
  reports_dropped: number;
  /** 本文を 300 文字に切った report の件数。 */
  report_texts_cut: number;
  /** result / task_result.summary を切ったか。 */
  result_cut: boolean;
  note: string;
}

const size = (v: unknown): number => JSON.stringify(v, null, 2).length;

/**
 * session 向け remote_list の返り値に大きさの上限を付ける（外向けの口では使わない）。
 * 既定: report の本文を 1 件 300 文字、result・summary を 2000 文字で切る。越えたら古い report から落とし、
 * それでも全体が total を越える時は report を全部落とし、result を 200 文字にする。切った cap には truncated を付ける。
 */
export function limitRemoteList(views: RemoteView[], total: number = REMOTE_LIST_TOTAL_MAX): (RemoteView & { truncated?: RemoteListCut })[] {
  const out = views.map((v) => {
    let reportTextsCut = 0;
    const reports = v.worker_reports.map((w) => {
      if (w.text.length <= REMOTE_LIST_REPORT_TEXT_MAX) return w;
      reportTextsCut++;
      return { ...w, text: `${w.text.slice(0, REMOTE_LIST_REPORT_TEXT_MAX)}…(${w.text.length} 文字中)` };
    });
    let resultCut = false;
    const cutText = (s: string, max: number): string => {
      if (s.length <= max) return s;
      resultCut = true;
      return `${s.slice(0, max)}…(${s.length} 文字中)`;
    };
    const next: RemoteView & { truncated?: RemoteListCut } = { ...v, worker_reports: reports };
    if (v.result !== undefined) next.result = cutText(v.result, REMOTE_LIST_RESULT_MAX);
    if (v.task_result !== undefined) next.task_result = { ...v.task_result, summary: cutText(v.task_result.summary, REMOTE_LIST_RESULT_MAX) };
    if (reportTextsCut > 0 || resultCut) {
      next.truncated = { reports_total: v.worker_reports.length, reports_dropped: 0, report_texts_cut: reportTextsCut, result_cut: resultCut, note: "" };
    }
    return next;
  });
  const mark = (v: RemoteView & { truncated?: RemoteListCut }, dropped: number, resultCut: boolean): void => {
    const t = v.truncated ?? { reports_total: v.worker_reports.length + dropped, reports_dropped: 0, report_texts_cut: 0, result_cut: false, note: "" };
    t.reports_dropped += dropped;
    t.result_cut = t.result_cut || resultCut;
    v.truncated = t;
  };
  // 総量: 古い report から 1 件ずつ落とす（cap をまたいで、いちばん多く持つ cap から）。
  while (size(out) > total) {
    const biggest = out.reduce((a, b) => (b.worker_reports.length > a.worker_reports.length ? b : a), out[0]!);
    if (biggest === undefined || biggest.worker_reports.length === 0) break;
    biggest.worker_reports = biggest.worker_reports.slice(1);
    mark(biggest, 1, false);
  }
  // それでも越える時: result を 200 文字に。
  if (size(out) > total) {
    for (const v of out) {
      let cut = false;
      if (v.result !== undefined && v.result.length > 200) { v.result = `${v.result.slice(0, 200)}…`; cut = true; }
      if (v.task_result !== undefined && v.task_result.summary.length > 200) { v.task_result = { ...v.task_result, summary: `${v.task_result.summary.slice(0, 200)}…` }; cut = true; }
      if (cut) mark(v, 0, true);
    }
  }
  for (const v of out) {
    if (v.truncated) v.truncated.note = `大きさの上限（1 回 ${total} 文字、report の本文は ${REMOTE_LIST_REPORT_TEXT_MAX} 文字、result は ${REMOTE_LIST_RESULT_MAX} 文字）で切った。落とした report は古い順`;
  }
  return out;
}
