import type { ActivityNotice, ActivityState, AgentActivity, AgentKind } from "@agent-hand/bantou-protocol";
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
  /** 起動時の孤児回収で見つけた running を lost で登録する。 */
  seedLost(kind: AgentKind, id: string, capId: string, error: string): void;
  snapshot(capId?: string): AgentActivity[];
  close(): void;
}

export interface ActivityTrackerDeps {
  notify: (capId: string, notice: ActivityNotice) => Promise<void>;
  log: (msg: string) => void;
  /** テスト用。 */
  now?: () => number;
  intervalMs?: number;
  stalledMs?: number;
}

interface Entry {
  kind: AgentKind;
  id: string;
  capId: string;
  state: ActivityState;
  task: string;
  lastActivity: string | null;
  lastOutputAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  error?: string;
  /** 今の実行中に report kind=done を受けたか。 */
  reportedDone: boolean;
}

const isLive = (s: ActivityState): boolean => s === "running" || s === "stalled";

export function createActivityTracker(deps: ActivityTrackerDeps): ActivityTracker {
  const now = deps.now ?? Date.now;
  const stalledMs = deps.stalledMs ?? STALLED_MS;
  const entries = new Map<string, Entry>();
  const dirty = new Set<string>();
  let flushScheduled = false;
  let closed = false;

  const keyOf = (kind: AgentKind, id: string): string => `${kind}:${id}`;
  const iso = (t: number | null): string | null => (t === null ? null : new Date(t).toISOString());

  const toActivity = (e: Entry): AgentActivity => {
    const base = e.lastOutputAt ?? e.startedAt;
    const a: AgentActivity = {
      kind: e.kind,
      id: e.id,
      cap_id: e.capId,
      state: e.state,
      task: e.task,
      last_activity: e.lastActivity,
      last_output_at: iso(e.lastOutputAt),
      silent_ms: base === null ? 0 : Math.max(0, now() - base),
      started_at: iso(e.startedAt),
      finished_at: iso(e.finishedAt),
    };
    if (e.error !== undefined) a.error = e.error;
    return a;
  };

  const snapshot = (capId?: string): AgentActivity[] =>
    [...entries.values()]
      .filter((e) => capId === undefined || e.capId === capId)
      .sort((a, b) => {
        if (a.capId !== b.capId) return a.capId < b.capId ? -1 : 1;
        if (a.kind !== b.kind) return a.kind === "cap" ? -1 : 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      })
      .map(toActivity);

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

  const get = (kind: AgentKind, id: string): Entry | undefined => entries.get(keyOf(kind, id));

  return {
    started(kind, id, input: InvokeInput, _pid) {
      const capId = kind === "cap" ? id : (input.capId ?? get(kind, id)?.capId ?? "");
      const prev = get(kind, id);
      const e: Entry = prev ?? {
        kind,
        id,
        capId,
        state: "running",
        task: "",
        lastActivity: null,
        lastOutputAt: null,
        startedAt: null,
        finishedAt: null,
        reportedDone: false,
      };
      if (capId !== "") e.capId = capId;
      if (!input.keepTask || prev === undefined) e.task = oneLine(input.prompt, TASK_MAX);
      e.state = "running";
      e.lastActivity = null;
      e.lastOutputAt = null;
      e.startedAt = now();
      e.finishedAt = null;
      delete e.error;
      e.reportedDone = false;
      entries.set(keyOf(kind, id), e);
      if (e.capId !== "") markDirty(e.capId);
    },

    line(kind, id, line) {
      const e = get(kind, id);
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
      const e = get(kind, id);
      if (!e) return;
      if (outcome.ok) e.state = kind === "worker" && e.reportedDone ? "done" : "idle";
      else e.state = outcome.lost ? "lost" : "failed";
      if (outcome.ok) delete e.error;
      else e.error = oneLine(outcome.error ?? "失敗", ERROR_MAX);
      e.finishedAt = now();
      if (e.capId !== "") markDirty(e.capId);
    },

    reported(workerId, kind) {
      if (kind !== "done") return;
      const e = get("worker", workerId);
      if (e) e.reportedDone = true;
    },

    seedLost(kind, id, capId, error) {
      const t = now();
      entries.set(keyOf(kind, id), {
        kind,
        id,
        capId,
        state: "lost",
        task: "",
        lastActivity: null,
        lastOutputAt: null,
        startedAt: null,
        finishedAt: t,
        error: oneLine(error, ERROR_MAX),
        reportedDone: false,
      });
      markDirty(capId);
    },

    snapshot,

    close() {
      closed = true;
      clearInterval(timer);
    },
  };
}
