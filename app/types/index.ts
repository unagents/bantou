/** Mirror of `src-tauri/src/task.rs::Task`. */
export interface Task {
  /** frontmatter `id` (stable across title renames). Empty when absent. */
  id: string;
  /** Absolute path of the `.md` file. */
  path: string;
  title: string;
  status: string;
  order: number | null;
  /** Session names. */
  tags: string[];
  date: string | null;
  body: string;
}

export interface AskOption {
  label: string;
  description: string;
}

/** Mirror of `src-tauri/src/thread.rs::TimelineEntry`. */
export interface TimelineEntry {
  role: "session" | "bantou" | "user" | "system";
  text: string;
  at: string;
}

/** Mirror of `src-tauri/src/thread.rs::Thread`. */
export interface Thread {
  task_id: string;
  status: "waiting" | "answered";
  request: {
    from_name: string;
    from_id: string;
    question: string;
    options: AskOption[];
    received_at: string;
  };
  timeline: TimelineEntry[];
  agent_session_id: string | null;
  answer: string | null;
}

/** Mirror of `src-tauri/src/broker.rs::BrokerStatus`. */
export interface BrokerStatus {
  connected: boolean;
  peer_id: string | null;
  broker_url: string;
  name: string;
  error: string | null;
}

export interface AgentEvent {
  workspace: string;
  task_id: string;
  state: "busy" | "idle" | "exited" | "error";
  message: string | null;
}

/** Mirror of `src-tauri/src/session.rs::Session`. */
export interface Session {
  name: string;
  hostname: string;
  cwd: string;
  registered_at: string;
}

/** Mirror of `src-tauri/src/session.rs::Peer`. */
export interface Peer {
  id: string;
  name: string;
  hostname: string;
  cwd: string;
  tty: string | null;
  summary: string;
  last_seen: string;
  /** Name chosen in bantou for an unnamed peer. */
  assign_name?: string | null;
}

export interface RegisterResult {
  name: string;
  delivered: boolean;
  error: string | null;
}
