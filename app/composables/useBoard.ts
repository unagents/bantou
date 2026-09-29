import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getStatuses, listSessions, listTasks, listThreads, THREADS_CHANGED_EVENT } from "~/api";
import type { Session, Task, Thread } from "~/types";

export interface SessionGroup {
  name: string;
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
  /** Sessions registered from the peer list (in-memory roster on the Rust side). */
  const registered = ref<Session[]>([]);

  async function refresh() {
    if (!dir.value) {
      tasks.value = [];
      threads.value = {};
      return;
    }
    const [t, s, th, rs] = await Promise.all([listTasks(), getStatuses(), listThreads(), listSessions()]);
    registered.value = rs;
    tasks.value = t;
    statuses.value = s;
    threads.value = Object.fromEntries(th.map((x) => [x.task_id, x]));
  }

  const sessions = computed<SessionGroup[]>(() => {
    const first = statuses.value[0];
    const last = statuses.value[statuses.value.length - 1];
    const map = new Map<string, SessionGroup>();
    const group = (name: string) => {
      let g = map.get(name);
      if (!g) {
        g = { name, working: [], queued: [], done: [] };
        map.set(name, g);
      }
      return g;
    };
    // Registered sessions are listed even without tasks.
    for (const r of registered.value) group(r.name);
    const reg = new Set(registered.value.map((r) => r.name));
    // Only registered sessions are rows; tags of other tasks are not sessions.
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
  onMounted(async () => {
    unlisten = await listen<string>(THREADS_CHANGED_EVENT, (e) => {
      if (e.payload === dir.value) void refresh();
    });
  });
  onBeforeUnmount(() => unlisten?.());

  return { tasks, statuses, threads, registered, sessions, waitingCount, refresh };
}
