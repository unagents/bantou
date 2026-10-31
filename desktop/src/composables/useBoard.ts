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
import type { Ping, SessionList, Task, Thread } from "~/types";

/** How often the remaining time of the ping timers is re-evaluated. */
const PING_TICK_MS = 5000;

export interface SessionGroup {
  name: string;
  /** The center could not be asked at the latest read (this row is from the last list that could be fetched). */
  unreachable: boolean;
  /** Why the center could not be asked. */
  reason: string | null;
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
  const centerList = ref<SessionList>({ sessions: [], reachable: true, reason: null });
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
      centerList.value = await listSessions();
      return;
    }
    const [t, s, th, cl, ps] = await Promise.all([
      listTasks(),
      getStatuses(),
      listThreads(),
      listSessions(),
      listPings(),
    ]);
    centerList.value = cl;
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
    const group = (name: string) => {
      let g = map.get(name);
      if (!g) {
        g = {
          name,
          unreachable: !centerList.value.reachable,
          reason: centerList.value.reason,
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
        if (t.status === last && statuses.value.length > 1) g.done.push(t);
        else if (t.status === first) g.queued.push(t);
        else g.working.push(t);
      }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
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
      centerList.value = await listSessions();
    });
  });
  onBeforeUnmount(() => {
    unlisten?.();
    unlistenPings?.();
    unlistenSessions?.();
  });

  return { tasks, statuses, threads, centerList, sessions, waitingCount, running, refresh };
}
