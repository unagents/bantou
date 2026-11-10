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
] as const;

/** async にしない event（turn の終わりは取りこぼしたくない。hook は常に exit 0 で POST も 2 秒で打ち切るので claude を長く止めない）。 */
export const SYNC_HOOK_EVENTS: ReadonlySet<string> = new Set(["Stop", "StopFailure"]);

/** 利用者の入力が無いと進まない tool。PreToolUse で needs-input にする。 */
const INPUT_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);
/** 利用者の入力待ちを表す Notification の notification_type。 */
const INPUT_NOTIFICATIONS = new Set(["permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"]);

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

export interface SessionActivityView {
  activity: SessionActivity;
  /** 最後に状態が変わった時刻（ISO）。unknown の時は null。 */
  activityAt: string | null;
}

export interface SessionActivityTracker {
  /**
   * hook の payload を反映する。startedAt = その session の今回の起動時刻（起動し直したら前の状態は捨てる）。
   * 状態が変わったら true。
   */
  apply(name: string, payload: unknown, startedAt: string | null): boolean;
  /** running でない・起動し直した・まだ hook が来ていない時は unknown。 */
  get(name: string, startedAt: string | null, running: boolean): SessionActivityView;
  forget(name: string): void;
}

interface Held {
  startedAt: string;
  activity: Exclude<SessionActivity, "unknown">;
  at: string;
  /** 最後に反映した event の発火時刻。これより古い event は捨てる。 */
  ts: number;
}

/** 保持はメモリのみ。center が再起動したら unknown から始まる。 */
export function createSessionActivityTracker(opts: { now?: () => number } = {}): SessionActivityTracker {
  const now = opts.now ?? Date.now;
  const held = new Map<string, Held>();
  return {
    apply(name, payload, startedAt) {
      if (!startedAt) return false;
      const next = activityFromHook(payload);
      if (!next) return false;
      const rawTs = (payload as Record<string, unknown>)[HOOK_TS_FIELD];
      const ts = typeof rawTs === "number" && Number.isFinite(rawTs) ? rawTs : now();
      const cur = held.get(name);
      const sameRun = cur?.startedAt === startedAt;
      if (sameRun && ts < cur!.ts) return false;
      const changed = !sameRun || cur!.activity !== next;
      held.set(name, { startedAt, activity: next, at: changed ? new Date(now()).toISOString() : cur!.at, ts });
      return changed;
    },
    get(name, startedAt, running) {
      const h = held.get(name);
      if (!running || !h || h.startedAt !== startedAt) return { activity: "unknown", activityAt: null };
      return { activity: h.activity, activityAt: h.at };
    },
    forget: (name) => void held.delete(name),
  };
}
