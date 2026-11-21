import type { WithModel } from "./model";
import type { ActivityNotice, ActivityState, AgentActivity, AgentKind, CapTaskInfo } from "@agent-hand/bantou-protocol";
import { PROTOCOL_VERSION } from "@agent-hand/bantou-protocol";
import type { InvokeInput, RunObserver } from "./agents";
import type { ReportKind } from "./reports";

export const ACTIVITY_INTERVAL_MS = 5_000;
export const STALLED_MS = 300_000;
/** task の文字数。 */
export const TASK_MAX = 200;
/** last_activity の文字数。 */
export const ACTIVITY_MAX = 120;
export const ERROR_MAX = 200;

const oneLine = (s: string, n: number): string => s.replace(/\s+/g, " ").trim().slice(0, n);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const HINT_KEYS = ["description", "command", "file_path", "pattern", "prompt"] as const;

function toolHint(input: unknown): string {
  if (!isRecord(input)) return "";
  for (const k of HINT_KEYS) {
    const v = input[k];
    if (typeof v === "string" && v.trim() !== "") return oneLine(v, ACTIVITY_MAX);
  }
  return "";
}

/** assistant メッセージの最後の block を要約する。 */
function summarizeAssistant(o: Record<string, unknown>): string | null {
  const msg = o.message;
  if (!isRecord(msg) || !Array.isArray(msg.content)) return null;
  for (let i = msg.content.length - 1; i >= 0; i--) {
    const b: unknown = msg.content[i];
    if (!isRecord(b)) continue;
    if (b.type === "tool_use" && typeof b.name === "string") {
      const hint = toolHint(b.input);
      return oneLine(hint ? `${b.name}: ${hint}` : b.name, ACTIVITY_MAX);
    }
    if (b.type === "text" && typeof b.text === "string") return oneLine(`text: ${b.text}`, ACTIVITY_MAX);
    if (b.type === "thinking") return "thinking";
  }
  return null;
}

/**
 * stream-json の 1 行を要約する。JSON でない行は null。
 * activity が null の行は「出力あり」だけ数える（last_output_at の更新のみ）。
 */
export function summarizeLine(line: string): { activity: string | null } | null {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(o)) return null;
  switch (o.type) {
    case "assistant":
      return { activity: summarizeAssistant(o) };
    case "tool_progress": {
      if (typeof o.tool_name !== "string") return { activity: null };
      const sec = typeof o.elapsed_time_seconds === "number" ? ` ${Math.floor(o.elapsed_time_seconds)}s` : "";
      return { activity: oneLine(`${o.tool_name} 実行中${sec}`, ACTIVITY_MAX) };
    }
    case "system":
      if (o.subtype === "task_started" && typeof o.description === "string") {
        return { activity: oneLine(`task: ${o.description}`, ACTIVITY_MAX) };
      }
      if (o.subtype === "init") return { activity: "start" };
      return { activity: null };
    case "result":
      return { activity: oneLine(`result: ${typeof o.subtype === "string" ? o.subtype : "?"}`, ACTIVITY_MAX) };
    default:
      return { activity: null };
  }
}

export interface ActivityTracker extends RunObserver {
  /** worker の report（kind=done で done 判定に使う）。 */
  reported(workerId: string, kind: ReportKind): void;
  /**
   * cap が再開される（queue に積まれた）ことを、cap の run が実際に始まる前から activity に出す。
   * worker の終了を知らせる activity より前に呼ぶ（center が cap idle と見て完了にしないため）。taskId = 再開する task の lane。
   */
  holdCap(capId: string, taskId?: string): void;
  /** holdCap の取り消し（run が始まらず終わった時）。run が始まっていれば何もしない。 */
  releaseCap(capId: string, taskId?: string): void;
  /** 掃除した worker を snapshot（activity の agents[]）から外す。 */
  forget(kind: AgentKind, id: string): void;
  /** 起動時の孤児回収で見つけた running を lost で登録する。taskId = cap の task の lane。 */
  seedLost(kind: AgentKind, id: string, capId: string, error: string, taskId?: string): void;
  /**
   * agent ごとの activity。cap は本体と task の lane を 1 件にまとめる（1 つでも running なら running。tasks に cap の task の状態）。
   * worker には task_id（起動した task）が付く。
   */
  snapshot(capId?: string): Array<WithModel<AgentActivity>>;
  /** cap の本体か task の lane の 1 件（まとめる前）。worker の掃除で、その worker の task の指揮が動いているかを見る。 */
  capEntry(capId: string, taskId?: string): WithModel<AgentActivity> | undefined;
  /** cap の task の状態が変わった（activity を送り直す）。 */
  touch(capId: string): void;
  /** 終わった task の lane の記録を外す（lane を片付けた時）。動いている lane は外さない。 */
  forgetLane(capId: string, taskId: string): void;
  close(): void;
}

export interface ActivityTrackerDeps {
  notify: (capId: string, notice: ActivityNotice) => Promise<void>;
  log: (msg: string) => void;
  /** cap の task の状態（task の待ち行列）。cap の activity に tasks として載せる。 */
  tasksOf?: (capId: string) => CapTaskInfo[];
  /** テスト用。 */
  now?: () => number;
  intervalMs?: number;
  stalledMs?: number;
}

interface Entry {
  kind: AgentKind;
  id: string;
  capId: string;
  /** cap: task の lane（無ければ本体）。worker: 起動した task。 */
  taskId?: string;
  state: ActivityState;
  task: string;
  model: string | null;
  lastActivity: string | null;
  lastOutputAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  error?: string;
  /** 今の実行中に report kind=done を受けたか。 */
  reportedDone: boolean;
  /** holdCap による running（run はまだ始まっていない）。started / finished で解く。 */
  held?: boolean;
}

const isLive = (s: ActivityState): boolean => s === "running" || s === "stalled";

export function createActivityTracker(deps: ActivityTrackerDeps): ActivityTracker {
  const now = deps.now ?? Date.now;
  const stalledMs = deps.stalledMs ?? STALLED_MS;
  const entries = new Map<string, Entry>();
  const dirty = new Set<string>();
  let flushScheduled = false;
  let closed = false;

  /** cap の lane は `cap:<cap_id>/<task_id>`。worker は task に関わらず `worker:<id>`。 */
  const keyOf = (kind: AgentKind, id: string, taskId?: string): string => (kind === "cap" && taskId !== undefined ? `cap:${id}/${taskId}` : `${kind}:${id}`);
  const iso = (t: number | null): string | null => (t === null ? null : new Date(t).toISOString());

  const toActivity = (e: Entry): WithModel<AgentActivity> => {
    const base = e.lastOutputAt ?? e.startedAt;
    const a: WithModel<AgentActivity> = {
      kind: e.kind,
      id: e.id,
      cap_id: e.capId,
      state: e.state,
      task: e.task,
      model: e.model,
      last_activity: e.lastActivity,
      last_output_at: iso(e.lastOutputAt),
      silent_ms: base === null ? 0 : Math.max(0, now() - base),
      started_at: iso(e.startedAt),
      finished_at: iso(e.finishedAt),
    };
    if (e.error !== undefined) a.error = e.error;
    if (e.kind === "worker" && e.taskId !== undefined) a.task_id = e.taskId;
    return a;
  };

  const tasksOf = (capId: string): CapTaskInfo[] | undefined => {
    if (!deps.tasksOf) return undefined;
    try {
      return deps.tasksOf(capId);
    } catch (e) {
      deps.log(`task の状態を取れない: cap_id=${capId} ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  };

  /**
   * cap の本体と lane を 1 件にまとめる。state は running > stalled > 最後に終わったものの state。
   * 中身（task・last_activity・model・error など）は、動いている中で最後に出力した（無ければ始めた）もの、無ければ最後に終わったもの。
   */
  const mergeCap = (capId: string, list: Entry[]): WithModel<AgentActivity> => {
    const live = list.filter((e) => isLive(e.state));
    const recent = (e: Entry): number => (isLive(e.state) ? (e.lastOutputAt ?? e.startedAt ?? 0) : (e.finishedAt ?? e.startedAt ?? 0));
    const pool = live.length > 0 ? live : list;
    const rep = pool.reduce((a, b) => (recent(b) > recent(a) ? b : a));
    const a = toActivity(rep);
    a.id = capId;
    a.cap_id = capId;
    if (live.length > 0) {
      a.state = live.some((e) => e.state === "running") ? "running" : "stalled";
      a.finished_at = null;
      delete a.error;
      // 動いている lane のどれかが出力していれば、cap は黙っていない
      a.silent_ms = Math.min(...live.map((e) => toActivity(e).silent_ms));
    }
    const tasks = tasksOf(capId);
    if (tasks !== undefined) a.tasks = tasks;
    return a;
  };

  const snapshot = (capId?: string): Array<WithModel<AgentActivity>> => {
    const caps = new Map<string, Entry[]>();
    const workers: Entry[] = [];
    for (const e of entries.values()) {
      if (capId !== undefined && e.capId !== capId) continue;
      if (e.kind === "cap") caps.set(e.id, [...(caps.get(e.id) ?? []), e]);
      else workers.push(e);
    }
    const out: Array<WithModel<AgentActivity>> = [...[...caps].map(([id, list]) => mergeCap(id, list)), ...workers.map(toActivity)];
    return out.sort((a, b) => {
      if (a.cap_id !== b.cap_id) return a.cap_id < b.cap_id ? -1 : 1;
      if (a.kind !== b.kind) return a.kind === "cap" ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  };

  async function send(capId: string): Promise<void> {
    const notice: ActivityNotice = {
      bantou: PROTOCOL_VERSION,
      type: "activity",
      cap_id: capId,
      at: new Date(now()).toISOString(),
      agents: snapshot(capId),
    };
    try {
      await deps.notify(capId, notice);
    } catch (e) {
      deps.log(`activity 送信失敗: cap_id=${capId} ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 状態遷移の通知。同じ同期区間の遷移は 1 通にまとめる。 */
  function markDirty(capId: string): void {
    if (closed) return;
    dirty.add(capId);
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      const caps = [...dirty];
      dirty.clear();
      for (const c of caps) void send(c);
    });
  }

  function tick(): void {
    const caps = new Set<string>();
    for (const e of entries.values()) {
      if (!isLive(e.state)) continue;
      caps.add(e.capId);
      const base = e.lastOutputAt ?? e.startedAt;
      if (e.state === "running" && base !== null && now() - base >= stalledMs) {
        e.state = "stalled";
        deps.log(`stalled: kind=${e.kind} id=${e.id} silent_ms=${now() - base}`);
      }
    }
    // 遷移は同じ tick の通常送信に含まれる。dirty 分も重ねて送らない
    for (const c of caps) dirty.delete(c);
    for (const c of caps) void send(c);
  }

  const timer = setInterval(tick, deps.intervalMs ?? ACTIVITY_INTERVAL_MS);
  timer.unref();

  const get = (kind: AgentKind, id: string, taskId?: string): Entry | undefined => entries.get(keyOf(kind, id, taskId));

  return {
    started(kind, id, input: InvokeInput, _pid) {
      const lane = kind === "cap" ? input.taskId : undefined;
      const capId = kind === "cap" ? id : (input.capId ?? get(kind, id)?.capId ?? "");
      const prev = get(kind, id, lane);
      const e: Entry = prev ?? {
        kind,
        id,
        capId,
        ...(lane !== undefined ? { taskId: lane } : {}),
        state: "running",
        task: "",
        model: null,
        lastActivity: null,
        lastOutputAt: null,
        startedAt: null,
        finishedAt: null,
        reportedDone: false,
      };
      if (capId !== "") e.capId = capId;
      if (kind === "worker" && input.taskId !== undefined) e.taskId = input.taskId;
      e.model = input.resolvedModel ?? null;
      if (!input.keepTask || prev === undefined) e.task = oneLine(input.prompt, TASK_MAX);
      e.state = "running";
      e.lastActivity = null;
      e.lastOutputAt = null;
      e.startedAt = now();
      e.finishedAt = null;
      delete e.error;
      e.reportedDone = false;
      delete e.held;
      entries.set(keyOf(kind, id, lane), e);
      if (e.capId !== "") markDirty(e.capId);
    },

    line(kind, id, line, taskId) {
      const e = get(kind, id, kind === "cap" ? taskId : undefined);
      if (!e) return;
      e.lastOutputAt = now();
      const s = summarizeLine(line);
      if (s?.activity) e.lastActivity = s.activity;
      if (e.state === "stalled") {
        e.state = "running";
        if (e.capId !== "") markDirty(e.capId);
      }
    },

    finished(kind, id, outcome) {
      const e = get(kind, id, kind === "cap" ? outcome.taskId : undefined);
      if (!e) return;
      delete e.held;
      if (outcome.ok) e.state = kind === "worker" && e.reportedDone ? "done" : "idle";
      else e.state = outcome.lost ? "lost" : "failed";
      if (outcome.ok) delete e.error;
      else e.error = oneLine(outcome.error ?? "失敗", ERROR_MAX);
      e.finishedAt = now();
      if (e.capId !== "") markDirty(e.capId);
    },

    holdCap(capId, taskId) {
      const k = keyOf("cap", capId, taskId);
      const e = entries.get(k);
      if (e && isLive(e.state)) return;
      if (e) {
        e.state = "running";
        e.held = true;
        e.finishedAt = null;
        e.startedAt = now();
        e.lastOutputAt = null;
        delete e.error;
      } else {
        entries.set(k, {
          kind: "cap",
          id: capId,
          capId,
          ...(taskId !== undefined ? { taskId } : {}),
          state: "running",
          task: "",
          model: null,
          lastActivity: null,
          lastOutputAt: null,
          startedAt: null,
          finishedAt: null,
          reportedDone: false,
          held: true,
        });
      }
      markDirty(capId);
    },

    releaseCap(capId, taskId) {
      const e = entries.get(keyOf("cap", capId, taskId));
      if (!e || e.held !== true) return;
      delete e.held;
      e.state = "idle";
      e.finishedAt = now();
      markDirty(capId);
    },

    reported(workerId, kind) {
      if (kind !== "done") return;
      const e = get("worker", workerId);
      if (e) e.reportedDone = true;
    },

    seedLost(kind, id, capId, error, taskId) {
      const t = now();
      entries.set(keyOf(kind, id, taskId), {
        kind,
        id,
        capId,
        ...(taskId !== undefined ? { taskId } : {}),
        state: "lost",
        task: "",
        model: null,
        lastActivity: null,
        lastOutputAt: null,
        startedAt: null,
        finishedAt: t,
        error: oneLine(error, ERROR_MAX),
        reportedDone: false,
      });
      markDirty(capId);
    },

    forget(kind, id) {
      const e = get(kind, id);
      if (!e) return;
      entries.delete(keyOf(kind, id));
      if (e.capId !== "") markDirty(e.capId);
    },

    snapshot,

    capEntry(capId, taskId) {
      const e = entries.get(keyOf("cap", capId, taskId));
      return e ? toActivity(e) : undefined;
    },

    forgetLane(capId, taskId) {
      const e = entries.get(keyOf("cap", capId, taskId));
      if (e && !isLive(e.state)) entries.delete(keyOf("cap", capId, taskId));
    },

    touch(capId) {
      // 1 度も動いていない cap（まだ待っている task だけ）には送らない（cap の agent が無く、tasks を載せる先が無い）
      for (const e of entries.values()) {
        if (e.capId === capId) {
          markDirty(capId);
          return;
        }
      }
    },

    close() {
      closed = true;
      clearInterval(timer);
    },
  };
}
