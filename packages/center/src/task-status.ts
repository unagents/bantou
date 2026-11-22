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
  /** この session の cap のある server ごとの版の状態（1 行ずつ。版が揃っていても出す）。 */
  servers: string[];
  /** 行数・文字数の上限で落とした行があれば true。 */
  truncated: boolean;
  /** 落とした行の数。 */
  omitted: number;
}

const minutes = (ms: number): number => Math.max(0, Math.floor(ms / 60_000));

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** servers に載せる server の数・1 行の長さの上限（task の行数・文字数の上限の内側に収める）。 */
export const TASK_STATUS_MAX_SERVERS = 10;

/** 版の状態の 1 行。server の表示名 | center の protocol | server の版 | 状態 | 一言。 */
function versionLine(v: RemoteView): string | undefined {
  const i = v.server_version_state;
  if (!i) return undefined;
  const sv = `${i.server_version ?? "?"}${i.server_protocol !== undefined ? `（protocol ${i.server_protocol}）` : ""}`;
  return clip(`${v.server_label} | center protocol ${i.center_protocol} | server ${sv} | ${i.state} | ${i.detail}`, TASK_STATUS_LINE_MAX);
}

const stateLabel = (v: RemoteView, openAsks: number, p?: RemoteView["pending"][number]): string => {
  if (v.cap_state === "lost") return "lost";
  if (!v.reachability.reachable) return "不通";
  if (v.state === "unknown") return "不明";
  // task を並行に動かす server は task ごとの状態を知らせる。始まっていない task は待ち（理由付き）
  const t = p?.server_task;
  // 並行の上限は既定で無い。待ちになるのは、利用者が上限を置いた時（limit）と、cap の停止中（closing）。branch は旧 server だけ
  if (t?.state === "waiting") {
    return t.waiting_for === "branch"
      ? `待ち（同じ branch${t.branch !== undefined ? ` ${t.branch}` : ""} の前の task。旧 server）`
      : t.waiting_for === "limit"
        ? "待ち（利用者が置いた並行の上限）"
        : t.waiting_for === "closing"
          ? "待ち（cap の停止中）"
          : "待ち";
  }
  if (t?.state === "failed") return "失敗";
  if (t === undefined && v.state === "failed") return "失敗";
  if (openAsks > 0) return "返答待ち";
  if (t?.state === "done") return "完了";
  if (t === undefined && v.state === "done") return "完了";
  // server は同じ branch の task も待たせない。cap に知らせて cap が判断する
  if (t?.same_branch !== undefined && t.same_branch.length > 0) return `実行中（同じ branch の task ${t.same_branch.length} 本）`;
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
        stateLabel(v, openAsks, p),
        `経過 ${Number.isNaN(sentAt) ? "?" : minutes(now - sentAt)} 分`,
        last ? `最後の報告 ${last.kind} ${Number.isNaN(Date.parse(last.at)) ? "?" : minutes(now - Date.parse(last.at))} 分前` : "最後の報告 なし",
        `判断が要る ${openAsks}`,
      ];
      rows.push({ at: Number.isNaN(sentAt) ? 0 : sentAt, item: { task_id: p.task_id, remote_id: v.remote_id, line: clip(parts.join(" | "), TASK_STATUS_LINE_MAX) } });
    }
  }
  rows.sort((a, b) => a.at - b.at);
  const at = new Date(now).toISOString();
  // server ごとの版の状態（owner の cap のある server だけ。同じ server は 1 行）
  const servers: string[] = [];
  for (const v of views) {
    if (v.session !== owner || servers.length >= TASK_STATUS_MAX_SERVERS) continue;
    const l = versionLine(v);
    if (l !== undefined && !servers.includes(l)) servers.push(l);
  }
  const tasks: TaskStatusLine[] = [];
  for (const r of rows) {
    if (tasks.length >= TASK_STATUS_MAX_LINES) break;
    // 返り値全体（task_id・remote_id・構造・truncated / omitted も含む JSON）で測る。
    const candidate = { at, tasks: [...tasks, r.item], servers, truncated: true, omitted: rows.length };
    if (JSON.stringify(candidate, null, 2).length > TASK_STATUS_MAX_CHARS) break;
    tasks.push(r.item);
  }
  const omitted = rows.length - tasks.length;
  return { at, tasks, servers, truncated: omitted > 0, omitted };
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
  /** pending[].prompt を切ったか。 */
  pending_prompts_cut: boolean;
  /** conversation（last_error_text）を切ったか。 */
  conversation_cut: boolean;
  note: string;
}

/** cap の件数が上限で落ちた時に、配列の末尾へ足す 1 件。 */
export interface RemoteListOmitted {
  omitted_remotes: number;
  note: string;
}

export type RemoteListItem = RemoteView & { truncated?: RemoteListCut };

const REMOTE_LIST_PROMPT_MAX = 200;
const REMOTE_LIST_ERROR_TEXT_MAX = 300;

const cutNote = (total: number): string => `上限（1 回 ${total} 文字）で切った。report は古い順に落とす`;

const size = (v: unknown): number => JSON.stringify(v, null, 2).length;

const clipTo = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…(${s.length} 文字中)` : s);

/**
 * session 向け remote_list の返り値に大きさの上限を付ける（外向けの口では使わない）。返り値全体（JSON）は必ず total 文字以内。
 * 段階: (0) report の本文 300 文字、result・summary 2000 文字、pending の prompt 200 文字、conversation の error 文 300 文字で切る →
 * (1) 古い report から落とす → (2) result を 200 文字、prompt を 20 文字、error 文を消す → (3) cap を古い順（createdAt）に落とす（末尾に omitted_remotes の 1 件を足す）。
 * 各段の後に note を含めた全体を測り直し、収まった所で止める。切った cap には truncated を付ける。
 */
export function limitRemoteList(views: RemoteView[], total: number = REMOTE_LIST_TOTAL_MAX): (RemoteListItem | RemoteListOmitted)[] {
  const out: RemoteListItem[] = views.map((v) => {
    const next: RemoteListItem = { ...v };
    const t: RemoteListCut = { reports_total: v.worker_reports.length, reports_dropped: 0, report_texts_cut: 0, result_cut: false, pending_prompts_cut: false, conversation_cut: false, note: cutNote(total) };
    next.worker_reports = v.worker_reports.map((w) => {
      if (w.text.length <= REMOTE_LIST_REPORT_TEXT_MAX) return w;
      t.report_texts_cut++;
      return { ...w, text: clipTo(w.text, REMOTE_LIST_REPORT_TEXT_MAX) };
    });
    const cutResult = (str: string, max: number): string => {
      if (str.length <= max) return str;
      t.result_cut = true;
      return clipTo(str, max);
    };
    if (v.result !== undefined) next.result = cutResult(v.result, REMOTE_LIST_RESULT_MAX);
    if (v.task_result !== undefined) next.task_result = { ...v.task_result, summary: cutResult(v.task_result.summary, REMOTE_LIST_RESULT_MAX) };
    next.pending = v.pending.map((p) => {
      if (p.prompt.length <= REMOTE_LIST_PROMPT_MAX) return p;
      t.pending_prompts_cut = true;
      return { ...p, prompt: clipTo(p.prompt, REMOTE_LIST_PROMPT_MAX) };
    });
    if (v.conversation?.last_error_text !== undefined && v.conversation.last_error_text.length > REMOTE_LIST_ERROR_TEXT_MAX) {
      t.conversation_cut = true;
      next.conversation = { ...v.conversation, last_error_text: clipTo(v.conversation.last_error_text, REMOTE_LIST_ERROR_TEXT_MAX) };
    }
    if (t.report_texts_cut > 0 || t.result_cut || t.pending_prompts_cut || t.conversation_cut) next.truncated = t;
    return next;
  });
  const cutOf = (v: RemoteListItem): RemoteListCut =>
    (v.truncated ??= { reports_total: v.worker_reports.length, reports_dropped: 0, report_texts_cut: 0, result_cut: false, pending_prompts_cut: false, conversation_cut: false, note: cutNote(total) });
  let result: (RemoteListItem | RemoteListOmitted)[] = out;
  const fits = (): boolean => size(result) <= total;
  // (1) 古い report から 1 件ずつ（いちばん多く持つ cap から）。
  while (!fits()) {
    const biggest = out.reduce<RemoteListItem | undefined>((a, b) => (a === undefined || b.worker_reports.length > a.worker_reports.length ? b : a), undefined);
    if (biggest === undefined || biggest.worker_reports.length === 0) break;
    biggest.worker_reports = biggest.worker_reports.slice(1);
    cutOf(biggest).reports_dropped++;
  }
  // (2) result・prompt・error 文をさらに縮める。
  if (!fits()) {
    for (const v of out) {
      const t = cutOf(v);
      if (v.result !== undefined && v.result.length > 200) { v.result = clipTo(v.result, 200); t.result_cut = true; }
      if (v.task_result !== undefined && v.task_result.summary.length > 200) { v.task_result = { ...v.task_result, summary: clipTo(v.task_result.summary, 200) }; t.result_cut = true; }
      if (v.pending.some((p) => p.prompt.length > 20)) t.pending_prompts_cut = true;
      v.pending = v.pending.map((p) => (p.prompt.length > 20 ? { ...p, prompt: clipTo(p.prompt, 20) } : p));
      if (v.conversation?.last_error_text !== undefined) { const { last_error_text: _drop, ...rest } = v.conversation; v.conversation = rest; t.conversation_cut = true; }
    }
  }
  // (3) cap の数。古い順（createdAt）に落とし、落とした数を末尾の 1 件で知らせる。残りは必ず上限に収める。
  if (!fits()) {
    const byAge = [...out].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const kept = new Set(out);
    let omitted = 0;
    const build = (): void => {
      const list: (RemoteListItem | RemoteListOmitted)[] = out.filter((v) => kept.has(v));
      if (omitted > 0) list.push({ omitted_remotes: omitted, note: `上限（1 回 ${total} 文字）で cap ${omitted} 件を落とした（古い順）。remote_id を task_status で確かめる` });
      result = list;
    };
    for (const v of byAge) {
      if (fits()) break;
      kept.delete(v);
      omitted++;
      build();
    }
  }
  return result;
}
