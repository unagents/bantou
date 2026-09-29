import type { BrokerStatus, Peer, Session, Task, Thread } from "../../app/types";

export interface Seed {
  dir: string | null;
  tasks: Task[];
  threads: Thread[];
  statuses?: string[];
  /** Text the mocked bantou responder answers with on open. */
  supplement?: string;
  peers?: Peer[];
  sessions?: Session[];
}

export interface InvokeRecord {
  cmd: string;
  args: Record<string, unknown>;
}

type Emit = (event: string, payload: unknown) => void;

/**
 * In-browser stand-in for the Rust backend. The responder (claude) is
 * replaced by canned replies so the UI flow can be driven without a process.
 */
export class MockBantou {
  dir: string | null;
  tasks: Task[];
  threads: Map<string, Thread>;
  statuses: string[];
  supplement: string;
  peers: Peer[];
  sessionsList: Session[];
  calls: InvokeRecord[] = [];
  sent: { to: string; text: string }[] = [];
  /** Ping timers: task id → expiry (ISO). */
  pings = new Map<string, string>();
  private listeners = new Map<string, number[]>();
  private nextEventId = 1;
  emitter: Emit = () => {};

  constructor(seed: Seed) {
    this.dir = seed.dir;
    this.tasks = structuredClone(seed.tasks);
    this.threads = new Map(seed.threads.map((t) => [t.task_id, structuredClone(t)]));
    this.statuses = seed.statuses ?? ["Todo", "Doing", "Done"];
    this.supplement = seed.supplement ?? "補足: 判断材料のモック。";
    this.peers = seed.peers ?? [];
    this.sessionsList = seed.sessions ?? [];
  }

  private now() {
    return new Date().toISOString();
  }

  private push(taskId: string, role: Thread["timeline"][number]["role"], text: string) {
    const t = this.threads.get(taskId);
    if (!t) throw new Error(`No thread for task ${taskId}`);
    t.timeline.push({ role, text, at: this.now() });
  }

  private changed() {
    this.emitter("bantou://threads-changed", this.dir);
  }

  private agentReply(taskId: string, text: string, instruction?: string) {
    this.emitter("bantou://agent", { workspace: this.dir, task_id: taskId, state: "busy", message: null });
    setTimeout(() => {
      this.push(taskId, "bantou", text);
      if (instruction !== undefined) {
        const t = this.threads.get(taskId)!;
        const body = `【ユーザー回答（原文）】\n${t.answer}\n\n【bantou 指示】\n${instruction}`;
        this.sent.push({ to: t.request.from_name, text: body });
        this.push(taskId, "system", `${t.request.from_name} へ送信済み`);
        t.status = "answered";
      }
      this.changed();
      this.emitter("bantou://agent", { workspace: this.dir, task_id: taskId, state: "idle", message: null });
    }, 150);
  }

  /** A ping for `taskId` arrives: its timer is set to `ttlMs` from now. */
  ping(taskId: string, ttlMs = 5 * 60_000) {
    this.pings.set(taskId, new Date(Date.now() + ttlMs).toISOString());
    this.emitter("bantou://pings-changed", this.dir);
  }

  listenerIds(event: string) {
    return this.listeners.get(event) ?? [];
  }

  invoke(cmd: string, raw: unknown): unknown {
    const args = (raw ?? {}) as Record<string, unknown>;
    this.calls.push({ cmd, args: JSON.parse(JSON.stringify(args)) });
    switch (cmd) {
      case "get_workspace_directory":
        return this.dir;
      case "set_workspace_directory":
        this.dir = args.path as string;
        return null;
      case "pick_directory":
        return null;
      case "list_workspace_history":
        return this.dir ? [this.dir] : [];
      case "list_tasks":
        return structuredClone(this.tasks);
      case "get_statuses":
        return this.statuses;
      case "create_task": {
        const t: Task = {
          id: `t-new${this.tasks.length}`,
          path: `${this.dir}/${args.title}.md`,
          title: args.title as string,
          status: args.status as string,
          order: 99,
          tags: args.tags as string[],
          date: null,
          body: "",
        };
        this.tasks.push(t);
        return t;
      }
      case "list_sessions":
        return structuredClone(this.sessionsList);
      case "list_peers":
        return structuredClone(this.peers);
      case "register_sessions": {
        const ps = args.peers as Peer[];
        return ps.map((p) => {
          const name = p.name || p.assign_name || "";
          this.sessionsList.push({ name, hostname: p.hostname, cwd: p.cwd, registered_at: this.now() });
          const prefix = p.name ? "" : `【最初にやること】set_name「${name}」\n`;
          this.sent.push({ to: p.id, text: `${prefix}【bantou 登録通知】${name}` });
          return { name, delivered: true, error: null };
        });
      }
      case "instruct_add_task":
        this.sent.push({
          to: args.session as string,
          text: `【bantou タスク追加指示】\nタスク名: ${args.title as string}\n作業内容:\n${args.body as string}`,
        });
        return null;
      case "list_threads":
        return [...this.threads.values()].map((t) => structuredClone(t));
      case "get_thread":
        return structuredClone(this.threads.get(args.taskId as string) ?? null);
      case "broker_connect":
      case "broker_status":
        return {
          connected: true,
          peer_id: "mock0001",
          broker_url: "http://mock:7901",
          name: "bantou-core",
          error: null,
        } satisfies BrokerStatus;
      case "list_pings":
        return [...this.pings]
          .filter(([, at]) => Date.parse(at) > Date.now())
          .map(([task_id, expires_at]) => ({ task_id, expires_at }));
      case "agent_open": {
        const id = args.taskId as string;
        const t = this.threads.get(id)!;
        if (!t.timeline.some((e) => e.role === "bantou")) this.agentReply(id, this.supplement);
        return null;
      }
      case "agent_close":
        return null;
      case "agent_say": {
        const id = args.taskId as string;
        this.push(id, "user", args.text as string);
        this.changed();
        this.agentReply(id, `「${args.text}」への回答（モック）`);
        return null;
      }
      case "agent_answer": {
        const id = args.taskId as string;
        const t = this.threads.get(id)!;
        t.answer = args.answer as string;
        this.push(id, "user", `【回答】${t.answer}`);
        this.changed();
        this.agentReply(id, "【作業セッションへの指示】\n回答どおり進めよ", "回答どおり進めよ");
        return null;
      }
      case "plugin:fs|watch":
        return 1;
      case "plugin:resources|close":
      case "plugin:event|unlisten":
        return null;
      case "plugin:event|listen": {
        const a = args as { event: string; handler: number };
        this.listeners.set(a.event, [...(this.listeners.get(a.event) ?? []), a.handler]);
        return this.nextEventId++;
      }
      default:
        return null;
    }
  }
}
