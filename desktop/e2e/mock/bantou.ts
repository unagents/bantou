import type { BrokerStatus, CenterSettings, Peer, Session, Task, Thread } from "../../src/types";

export interface Seed {
  dir: string | null;
  tasks: Task[];
  threads: Thread[];
  statuses?: string[];
  /** Text the mocked bantou responder answers with on open. */
  supplement?: string;
  peers?: Peer[];
  sessions?: Session[];
  /** When set, `plugin:updater|check` reports this release as available. */
  update?: { version: string; currentVersion?: string; body?: string };
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
  update: Seed["update"];
  /** bind "" = no IP saved: center_get_settings shows the default (first external IPv4). */
  center: CenterSettings = { enabled: false, port: 7910, bind: "", workspace: "~/.bantou", token: "mock-token-000000000000000000000001" };
  /** Number of tokens minted by center_regenerate_token (the next one is mock-token-<n>). */
  private tokenSeq = 1;
  /** This machine's addresses now (center_local_ips / center_ip_status); a spec can drop one to make a saved IP vanish. */
  localIps: string[] = [...MOCK_IPS];
  /** When set, center_status reports that the center could not listen. */
  centerBindFailed = false;
  /** Whether the mocked center answers (center_connection). */
  centerReachable = true;
  centerRc = [
    { project: "alpha", path: "/ws/alpha", state: "connected", pid: 4301, sessionUrl: "https://claude.ai/code/session_mock", restarts: 0 },
    { project: "beta", path: "/ws/beta", state: "stopped", pid: null, sessionUrl: null, restarts: 2 },
  ];
  centerServers = [{ name: "srv1", connected: true, reachable: true, peerId: "p1", serverPeer: "p2" }];
  centerAgents: Record<string, unknown> = {
    srv1: {
      ok: true,
      caps: [{ kind: "cap", id: "cap-a", state: "idle" }],
      workers: [{ kind: "worker", id: "w1", state: "running" }],
    },
  };
  /** `server_peers` result (center `Follow.snapshot()`). */
  centerVersions: unknown = {
    pair: { server: "0.3.0", protocol: "1.3.0" },
    peers: [
      { key: "mac200 /ws", id: "p2", name: "bantou-server", hostname: "mac200", server_version: "0.3.0", protocol_version: "1.3.0", state: "ok", detail: "版が一致", since: "2026-10-31T00:00:00.000Z" },
    ],
  };
  /** `remote_list` result (center `RemoteView[]`). */
  centerRemotes: unknown[] = [];
  /** `session_list` result (center `SessionInfo[]`); `session_create` appends to it. */
  centerSessions: Record<string, unknown>[] = [{ name: "workspace", path: "/mock/.bantou", state: "connected", pid: 1, sessionUrl: null, startedAt: null, source: "config" }];
  /** When set, `session_create` fails with this message (center error). */
  centerSessionCreateError: string | null = null;
  /** sessionUrl `session_create` returns (null: not connected yet). */
  centerSessionUrl: string | null = "https://claude.ai/code/session_mock";
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
    this.update = seed.update;
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

  /** Session `name` has been gone for the absence TTL: bantou drops it from the roster. */
  dropAbsent(name: string) {
    this.sessionsList = this.sessionsList.filter((s) => s.name !== name);
    this.emitter("bantou://sessions-changed", this.dir);
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
      case "center_get_settings":
        return { ...structuredClone(this.center), bind: this.center.bind || defaultIp(this.localIps) };
      case "center_set_settings":
        this.center = JSON.parse(JSON.stringify(args.settings)) as CenterSettings;
        return structuredClone(this.center);
      case "center_status":
        return {
          state: this.center.enabled ? "running" : "stopped",
          pid: this.center.enabled ? 4242 : undefined,
          restartCount: 0,
          bindFailed: this.centerBindFailed,
          logs: [],
        };
      case "center_regenerate_token": {
        this.tokenSeq += 1;
        this.center.token = `mock-token-${String(this.tokenSeq).padStart(32, "0")}`;
        return this.center.token;
      }
      case "center_local_ips":
        return [...this.localIps];
      case "center_ip_status": {
        const saved = this.center.bind;
        return {
          ips: [...this.localIps],
          ...(saved ? { saved } : {}),
          defaultIp: defaultIp(this.localIps),
          missing: !!saved && !this.localIps.includes(saved),
        };
      }
      case "center_connect_snippets": {
        const { bind, port, token } = args as { bind: string; port: number; token: string };
        const host = bind.replace(/^\[|\]$/g, "");
        const url = `http://${host.includes(":") ? `[${host}]` : host}:${port}/mcp`;
        const auth = `Bearer ${token}`;
        return {
          url,
          mcpJson: JSON.stringify({ mcpServers: { "bantou-center": { type: "http", url, headers: { Authorization: auth } } } }, null, 2),
          claudeCode: `claude mcp add --transport http bantou-center ${url} \\\n  --header 'Authorization: ${auth}'`,
        };
      }
      case "center_parse_connect":
        return parseConnect((args as { text: string }).text);
      case "center_connection": {
        const remote = this.center.enabled ? undefined : this.center.remote;
        const url = remote
          ? remote.url.replace(/\/?$/, "/mcp").replace(/\/mcp\/mcp$/, "/mcp")
          : this.center.enabled
            ? `http://127.0.0.1:${this.center.port}/mcp`
            : undefined;
        if (!url) return { connected: false, lastError: "接続先が無い（center を有効にするか、別ホストの接続設定を貼る）" };
        const source = remote ? "remote" : "sidecar";
        return this.centerReachable
          ? { url, source, connected: true }
          : { url, source, connected: false, lastError: `${url} に接続できない: mock` };
      }
      case "center_call": {
        const text = (v: unknown) => ({ content: [{ type: "text", text: JSON.stringify(v, null, 2) }] });
        switch (args.name) {
          case "rc_list":
            return text(this.centerRc);
          case "remote_list":
            return text(this.centerRemotes);
          case "session_list":
            return text(this.centerSessions);
          case "session_create": {
            const name = (args.arguments as { name: string }).name;
            if (this.centerSessionCreateError) throw new Error(this.centerSessionCreateError);
            if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("name は英数字と _ - のみ");
            if (this.centerSessions.some((s) => s.name === name)) throw new Error(`name が既に使われている: ${name}`);
            const s = {
              name,
              path: `/mock/.bantou/${name}`,
              state: this.centerSessionUrl ? "connected" : "starting",
              pid: 4300,
              sessionUrl: this.centerSessionUrl,
              startedAt: this.now(),
              source: "session",
            };
            this.centerSessions.push(s);
            return text(s);
          }
          case "server_list":
            return text(this.centerServers);
          case "server_peers":
            return text(this.centerVersions);
          case "server_status": {
            const name = (args.arguments as { server: string }).server;
            return text(this.centerAgents[name] ?? { ok: true, caps: [], workers: [] });
          }
          default:
            throw new Error(`unknown tool: ${String(args.name)}`);
        }
      }
      case "plugin:updater|check":
        return this.update
          ? {
              rid: 4242,
              currentVersion: this.update.currentVersion ?? "0.0.0",
              version: this.update.version,
              date: null,
              body: this.update.body ?? null,
              rawJson: {},
            }
          : null;
      case "plugin:updater|download_and_install":
      case "plugin:process|restart":
        return null;
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

/** This machine's addresses as `center_local_ips` returns them (IPv4 first, then IPv6). */
/** Default IP as the backend picks it: first external IPv4 (private/LAN first), else 127.0.0.1. */
function defaultIp(ips: string[]): string {
  const ext = ips.filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip) && !ip.startsWith("127."));
  const lan = ext.find((ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip));
  return lan ?? ext[0] ?? "127.0.0.1";
}

const MOCK_IPS = ["192.168.1.204", "100.64.0.9", "127.0.0.1", "fd7a::5"];

/** Mock of `center_parse_connect`: mcp.json or `claude mcp add`; rejects with a message like the Rust side. */
function parseConnect(text: string): { url: string; token?: string } {
  const t = text.trim();
  if (!t) throw "接続設定が空";
  const bearer = (v: unknown) => {
    const m = /^bearer\s+(.+)$/i.exec(String(v ?? "").trim());
    return m ? m[1].trim() : undefined;
  };
  const url = (u: string) => {
    if (!/^https?:\/\/[^/]+/.test(u)) throw `url は http(s):// で始まるホスト付きのものだけ: ${u}`;
    return /^https?:\/\/[^/]+\/?$/.test(u) ? u.replace(/\/?$/, "/mcp") : u;
  };
  if (t.startsWith("{")) {
    let v: Record<string, any>;
    try {
      v = JSON.parse(t);
    } catch (e) {
      throw `JSON として読めない: ${String(e)}`;
    }
    const servers = (v.mcpServers ?? v.servers ?? {}) as Record<string, any>;
    const entry = servers["bantou-center"] ?? Object.values(servers).find((e) => e?.url) ?? (v.url ? v : undefined);
    if (!entry?.url) throw "接続設定に url を持つサーバーが見つからない";
    const h = Object.entries((entry.headers ?? {}) as Record<string, unknown>).find(([k]) => k.toLowerCase() === "authorization");
    return { url: url(String(entry.url)), token: bearer(h?.[1]) };
  }
  if (t.startsWith("claude") || t.includes("mcp add")) {
    const u = /https?:\/\/[^\s'"]+/.exec(t)?.[0];
    if (!u) throw "コマンドに url（http:// か https://）が見つからない";
    const a = /Authorization:\s*Bearer\s+([^'"\s]+)/i.exec(t);
    return { url: url(u), token: a?.[1] };
  }
  throw "mcp.json 形式（{ \"mcpServers\": ... }）か claude mcp add コマンドを貼る";
}
