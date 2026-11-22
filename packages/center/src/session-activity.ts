import type { EventHub } from "./events.js";

/** session（claude）の作業状態。 */
export type SessionActivity = "working" | "needs-input" | "idle" | "unknown";

/** hook の stdin JSON に hook サブコマンドが足す、発火時刻（epoch ms）。到着順の入れ替わりで古い event が勝たないように使う。 */
export const HOOK_TS_FIELD = "bantou_ts";

/** claude の hooks に登録する event（center の `--settings` に入れる）。 */
export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
  "Notification",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
] as const;

/** async にしない event（turn の終わりは取りこぼしたくない。hook は常に exit 0 で POST も 2 秒で打ち切るので claude を長く止めない）。 */
export const SYNC_HOOK_EVENTS: ReadonlySet<string> = new Set(["Stop", "StopFailure"]);

/** 利用者の入力が無いと進まない tool。PreToolUse で needs-input にする。 */
const INPUT_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);
/** 利用者の入力待ちを表す Notification の notification_type。 */
const INPUT_NOTIFICATIONS = new Set(["permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"]);

/** tracker が見る event（HOOK_EVENTS と同じ）。 */
const TRACKED_EVENTS: ReadonlySet<string> = new Set(HOOK_EVENTS);

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * hook の stdin JSON から状態を決める。状態を変えない event（未対応・compact の SessionStart など）は null。
 */
export function activityFromHook(payload: unknown): Exclude<SessionActivity, "unknown"> | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  switch (str(p.hook_event_name)) {
    case "SessionStart":
      return str(p.source) === "compact" ? null : "idle";
    case "UserPromptSubmit":
    case "PostToolUse":
    case "PostToolUseFailure":
    case "PermissionDenied":
      return "working";
    case "PreToolUse":
      return INPUT_TOOLS.has(str(p.tool_name) ?? "") ? "needs-input" : "working";
    case "PermissionRequest":
      return "needs-input";
    case "Notification": {
      const t = str(p.notification_type) ?? "";
      if (INPUT_NOTIFICATIONS.has(t)) return "needs-input";
      return t === "idle_prompt" ? "idle" : null;
    }
    case "Stop":
    case "StopFailure":
      return "idle";
    default:
      return null;
  }
}

/** Stop の hook payload から、turn の終わりの最後の応答の文を取る。Stop 以外・空の時は null。 */
export function lastMessageFromHook(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (str(p.hook_event_name) !== "Stop") return null;
  const text = str(p.last_assistant_message);
  return text !== undefined && text.trim() !== "" ? text : null;
}

/** Stop の最後の応答があれば、届いた時刻を付けて hub に流す（GET /events の session-message）。 */
export function publishLastMessage(hub: Pick<EventHub, "publishMessage">, session: string, payload: unknown, now: () => number = Date.now): void {
  const text = lastMessageFromHook(payload);
  if (text !== null) hub.publishMessage({ session, text, at: new Date(now()).toISOString() });
}

/** session の中で続いている作業（claude 本体の turn とは別）。subagents = 動いている subagent の数、tasks = background の shell / monitor / workflow などの数。 */
export interface SessionBackground {
  subagents: number;
  tasks: number;
}

export interface SessionActivityView {
  /** cap（session の claude 本体）の状態。working = 本体が turn の実行中で利用者の入力に反応できない / needs-input = 利用者の返答待ち / idle = 待機（subagent や background が動いていても idle）。 */
  activity: SessionActivity;
  /** 最後に状態が変わった時刻（ISO）。unknown の時は null。 */
  activityAt: string | null;
  /** claude 本体とは別に続いている作業（subagent・background の実行）。unknown の時は 0 / 0。 */
  background: SessionBackground;
}

export interface SessionActivityTracker {
  /**
   * hook の payload を反映する。startedAt = その session の今回の起動時刻（起動し直したら前の状態は捨てる）。
   * 見える状態（activity・background）が変わったら true。
   */
  apply(name: string, payload: unknown, startedAt: string | null): boolean;
  /** running でない・起動し直した・まだ hook が来ていない時は unknown。 */
  get(name: string, startedAt: string | null, running: boolean): SessionActivityView;
  forget(name: string): void;
}

const NO_BACKGROUND: SessionBackground = { subagents: 0, tasks: 0 };
const UNKNOWN: SessionActivityView = { activity: "unknown", activityAt: null, background: NO_BACKGROUND };

interface Held {
  startedAt: string;
  /** 本体が turn の実行中か（UserPromptSubmit / PreToolUse… で true、Stop で false）。 */
  turn: boolean;
  /** 利用者の返答待ちか。 */
  needsInput: boolean;
  /** SubagentStart で見えた、まだ SubagentStop が来ていない subagent の agent_id。 */
  subagents: Set<string>;
  /** 最後の Stop の background_tasks にいた subagent の数（Stop より前に始まった物。SubagentStop で 1 つずつ減らす）。 */
  stopSubagents: number;
  /** background_tasks の subagent 以外（shell / monitor / workflow …）の数。Stop / SubagentStop の payload で置き換える。 */
  tasks: number;
  at: string;
  /** 最後に反映した event の発火時刻。これより古い event は捨てる。 */
  ts: number;
}

const activityOf = (h: Held): Exclude<SessionActivity, "unknown"> => (h.needsInput ? "needs-input" : h.turn ? "working" : "idle");
const backgroundOf = (h: Held): SessionBackground => ({ subagents: Math.max(h.subagents.size, h.stopSubagents), tasks: h.tasks });
const sameBackground = (a: SessionBackground, b: SessionBackground): boolean => a.subagents === b.subagents && a.tasks === b.tasks;

/** Stop / SubagentStop の background_tasks（公式: 在る時は配列。type = shell / subagent / monitor / workflow …）。無い・壊れた時は null。 */
function backgroundTasksOf(p: Record<string, unknown>): { subagents: number; tasks: number } | null {
  const list = p.background_tasks;
  if (!Array.isArray(list)) return null;
  let subagents = 0;
  let tasks = 0;
  for (const t of list) {
    if (typeof t === "object" && t !== null && (t as Record<string, unknown>).type === "subagent") subagents++;
    else tasks++;
  }
  return { subagents, tasks };
}

/** 保持はメモリのみ。center が再起動したら unknown から始まる。 */
export function createSessionActivityTracker(opts: { now?: () => number } = {}): SessionActivityTracker {
  const now = opts.now ?? Date.now;
  const held = new Map<string, Held>();
  return {
    apply(name, payload, startedAt) {
      if (!startedAt) return false;
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
      const p = payload as Record<string, unknown>;
      const event = str(p.hook_event_name);
      if (!event || !TRACKED_EVENTS.has(event)) return false;
      const rawTs = p[HOOK_TS_FIELD];
      const ts = typeof rawTs === "number" && Number.isFinite(rawTs) ? rawTs : now();
      const prev = held.get(name);
      const sameRun = prev?.startedAt === startedAt;
      if (sameRun && ts < prev!.ts) return false;
      // compact の SessionStart など、状態を変えない event は何も保持しない（ts も進めない）
      const base = activityFromHook(p);
      const agentId = str(p.agent_id);
      const h: Held = sameRun
        ? { ...prev!, subagents: new Set(prev!.subagents), ts }
        : { startedAt, turn: false, needsInput: false, subagents: new Set(), stopSubagents: 0, tasks: 0, at: new Date(now()).toISOString(), ts };
      const before = sameRun ? { activity: activityOf(prev!), background: backgroundOf(prev!) } : null;
      switch (event) {
        case "SessionStart":
          if (base === null) return false; // compact
          h.turn = false;
          h.needsInput = false;
          h.subagents.clear();
          h.stopSubagents = 0;
          h.tasks = 0;
          break;
        case "SubagentStart":
          if (agentId) h.subagents.add(agentId);
          break;
        case "SubagentStop": {
          if (agentId) h.subagents.delete(agentId);
          h.stopSubagents = Math.max(0, h.stopSubagents - 1);
          const bg = backgroundTasksOf(p);
          if (bg) h.tasks = bg.tasks; // subagent の数は Start / Stop の対で数える（この snapshot に終わる subagent 自身が残る可能性があるため）
          break;
        }
        case "Stop":
        case "StopFailure": {
          h.turn = false;
          h.needsInput = false;
          const bg = backgroundTasksOf(p);
          if (bg) {
            // 公式: Stop の background_tasks は「今 in-flight の物」。foreground の subagent は Stop の時点で居ないので、ここで数え直す
            h.subagents.clear();
            h.stopSubagents = bg.subagents;
            h.tasks = bg.tasks;
          }
          break;
        }
        default:
          // subagent の中の hook（agent_id 付き）は、claude 本体の turn の状態を変えない。
          // 本体が待機の間に subagent が tool を使っても、cap は待機のまま（入力に反応できる）。返答待ち（permission）だけは本体と同じ扱い
          if (agentId && base !== "needs-input") {
            if (base === "working") h.needsInput = false; // subagent の許可の返答が済んで tool が動いた
            break;
          }
          if (base === null) return false;
          if (base === "needs-input") h.needsInput = true;
          else if (base === "working") {
            h.turn = true;
            h.needsInput = false;
          } else {
            h.turn = false;
            h.needsInput = false;
          }
      }
      const changed = !before || before.activity !== activityOf(h) || !sameBackground(before.background, backgroundOf(h));
      if (before && before.activity !== activityOf(h)) h.at = new Date(now()).toISOString();
      held.set(name, h);
      return changed;
    },
    get(name, startedAt, running) {
      const h = held.get(name);
      if (!running || !h || h.startedAt !== startedAt) return UNKNOWN;
      return { activity: activityOf(h), activityAt: h.at, background: backgroundOf(h) };
    },
    forget: (name) => void held.delete(name),
  };
}
