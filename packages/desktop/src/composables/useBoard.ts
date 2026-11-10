import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useIntervalFn } from "@vueuse/core";
import {
  getStatuses,
  listPings,
  listSessions,
  listTasks,
  listThreads,
  PINGS_CHANGED_EVENT,
  SESSIONS_CHANGED_EVENT,
  THREADS_CHANGED_EVENT,
} from "~/api";
import type { ContextUsage, Ping, SessionActivity, SessionList, Task, Thread } from "~/types";

/** How often the remaining time of the ping timers is re-evaluated. */
const PING_TICK_MS = 5000;

export interface SessionGroup {
  name: string;
  /** The center could not be asked at the latest read (this row is from the last list that could be fetched). */
  unreachable: boolean;
  /** Why the center could not be asked. */
  reason: string | null;
  /** The session's context usage from the center (null: none). */
  contextUsage: ContextUsage | null;
  /** The session was started with the center's session instructions. */
  instructions: boolean;
  /**
   * Work state shown on the side row (null: show nothing). A waiting thread on one of the session's tasks
   * is always "needs-input"; otherwise the center's `activity` (unknown → null), and only while the center
   * could be asked and the session is connected (stopped / starting / error keep their own display).
   */
  activity: SessionActivity | null;
  /** In-progress tasks (statuses between the first and the last). */
  working: Task[];
  /** Queued tasks (the first status, Cork's "Todo"). */
  queued: Task[];
  /** Finished tasks (the last status, Cork's "Done"). */
  done: Task[];
}

/**
 * Board state: Cork-format tasks grouped by session (= tag), plus the
 * waiting-reply threads keyed by task id.
 */
export function useBoard(dir: Ref<string | null>) {
  const tasks = ref<Task[]>([]);
  const statuses = ref<string[]>(["Todo", "Doing", "Done"]);
  const threads = ref<Record<string, Thread>>({});
  /** The connected center's `session_list` as last fetched (cached on the Rust side). */
  const centerList = ref<SessionList>({ sessions: [], reachable: true, reason: null, rev: -1 });
  /**
   * The list arrives from several places in no fixed order (start-up read, the change event,
   * the workspace refresh). Keep the highest `rev`: a late older read must not bring back a list
   * that was already replaced (the Rust side only emits the event when the content changes, so
   * a stale list would stay).
   */
  function setCenterList(next: SessionList) {
    if (next.rev >= centerList.value.rev) centerList.value = next;
  }
  /** Ping timers: task id → expiry (epoch ms). */
  const pings = ref<Record<string, number>>({});
  const now = ref(Date.now());
  useIntervalFn(() => {
    now.value = Date.now();
  }, PING_TICK_MS);

  function setPings(list: Ping[]) {
    now.value = Date.now();
    pings.value = Object.fromEntries(list.map((p) => [p.task_id, Date.parse(p.expires_at)]));
  }

  async function refresh() {
    if (!dir.value) {
      tasks.value = [];
      threads.value = {};
      pings.value = {};
      setCenterList(await listSessions());
      return;
    }
    const [t, s, th, cl, ps] = await Promise.all([
      listTasks(),
      getStatuses(),
      listThreads(),
      listSessions(),
      listPings(),
    ]);
    setCenterList(cl);
    tasks.value = t;
    statuses.value = s;
    threads.value = Object.fromEntries(th.map((x) => [x.task_id, x]));
    setPings(ps);
  }

  /** Task ids whose ping timer has time left. */
  const running = computed<Record<string, boolean>>(() =>
    Object.fromEntries(Object.entries(pings.value).map(([id, at]) => [id, at > now.value])),
  );

  const sessions = computed<SessionGroup[]>(() => {
    const first = statuses.value[0];
    const last = statuses.value[statuses.value.length - 1];
    const map = new Map<string, SessionGroup>();
    const centerActivity = (name: string): SessionActivity | null => {
      if (!centerList.value.reachable) return null;
      const r = centerList.value.sessions.find((x) => x.name === name);
      if (!r || r.state !== "connected") return null;
      return r.activity === "working" || r.activity === "needs-input" || r.activity === "idle" ? r.activity : null;
    };
    const group = (name: string) => {
      let g = map.get(name);
      if (!g) {
        g = {
          name,
          unreachable: !centerList.value.reachable,
          reason: centerList.value.reason,
          contextUsage: centerList.value.sessions.find((r) => r.name === name)?.contextUsage ?? null,
          instructions: centerList.value.sessions.find((r) => r.name === name)?.instructions ?? false,
          activity: centerActivity(name),
          working: [],
          queued: [],
          done: [],
        };
        map.set(name, g);
      }
      return g;
    };
    // The center's sessions are listed even without tasks.
    for (const r of centerList.value.sessions) group(r.name);
    const reg = new Set(centerList.value.sessions.map((r) => r.name));
    // Only the center's sessions are rows; tags of other tasks are not sessions.
    for (const t of tasks.value) {
      for (const n of t.tags) {
        if (!reg.has(n)) continue;
        const g = group(n);
        // The thread ask (waiting) is not known to the center: it makes the session "needs-input" whatever the center says.
        if (threads.value[t.id]?.status === "waiting") g.activity = "needs-input";
        if (t.status === last && statuses.value.length > 1) g.done.push(t);
        else if (t.status === first) g.queued.push(t);
        else g.working.push(t);
      }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  });

  /** Sessions per work state (the side menu summary). */
  const activityCounts = computed<Record<SessionActivity, number>>(() => {
    const c = { working: 0, "needs-input": 0, idle: 0 };
    for (const g of sessions.value) if (g.activity) c[g.activity]++;
    return c;
  });

  const waitingCount = computed(
    () => Object.values(threads.value).filter((t) => t.status === "waiting").length,
  );

  let unlisten: UnlistenFn | null = null;
  let unlistenPings: UnlistenFn | null = null;
  let unlistenSessions: UnlistenFn | null = null;
  onMounted(async () => {
    unlisten = await listen<string>(THREADS_CHANGED_EVENT, (e) => {
      if (e.payload === dir.value) void refresh();
    });
    unlistenPings = await listen<string>(PINGS_CHANGED_EVENT, async (e) => {
      if (e.payload === dir.value) setPings(await listPings());
    });
    unlistenSessions = await listen(SESSIONS_CHANGED_EVENT, async () => {
      setCenterList(await listSessions());
    });
    // A change before the listener was registered has no event: read once more now.
    setCenterList(await listSessions());
  });
  onBeforeUnmount(() => {
    unlisten?.();
    unlistenPings?.();
    unlistenSessions?.();
  });

  return { tasks, statuses, threads, centerList, sessions, activityCounts, waitingCount, running, refresh };
}
