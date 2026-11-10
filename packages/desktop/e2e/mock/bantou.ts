import type { BrokerStatus, CenterSettings, Session, SessionList, Task, Thread } from "../../src/types";

export interface Seed {
  dir: string | null;
  tasks: Task[];
  threads: Thread[];
  statuses?: string[];
  /** Text the mocked bantou responder answers with on open. */
  supplement?: string;
  /** Names of the sessions the center lists (connected). */
  sessions?: string[];
  /** Merged into the mocked center settings. */
  center?: Partial<CenterSettings>;
  /** When set, `plugin:updater|check` reports this release as available. */
  update?: { version: string; currentVersion?: string; body?: string };
  /** The first this-many `plugin:updater|check` calls fail (offline at launch). */
  updateCheckFailures?: number;
  /** Tauri window label reported to the app (default "main"; other labels skip the auto update check). */
  windowLabel?: string;
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
  update: Seed["update"];
  /** Remaining `plugin:updater|check` calls that fail; each failure counts down. */
  updateCheckFailures = 0;
  windowLabel = "main";
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
  /** `remote_list` result (center `RemoteView[]`): one remote-cap per server (`remote_id` = cap_id, `owners`, `pending`, latest `result`; no history). */
  centerRemotes: unknown[] = [];
  /** `worker_reply` calls received (arguments as sent). */
  centerWorkerReplies: unknown[] = [];
  /** When set, `worker_reply` fails with this message. */
  centerWorkerReplyError: string | null = null;
  /** `session_list` result (center `SessionInfo[]`); `session_create` appends to it. */
  centerSessions: Record<string, unknown>[] = [];
  /** The list as last fetched (memory on the Rust side, `SessionCache`). */
  sessionCache: SessionList = { sessions: [], reachable: true, reason: null, rev: 0 };
  /** When set, `session_create` fails with this message (center error). */
  centerSessionCreateError: string | null = null;
  /** `session_create` answers this many ms after it listed the session (the real center lists it, then starts and settles it). 0: at once. */
  centerSessionCreateDelayMs = 0;
  /** `session_update` answers this many ms after it renamed in the center's list (the real center lists, then settles). 0: at once. */
  centerSessionUpdateDelayMs = 0;
  /** When set, `session_update` fails with this message (center error). */
  centerSessionUpdateError: string | null = null;
  /** The center's `workspace` (`center_info`; `session_path_hints`). null: not set / an older center. */
  centerWorkspace: string | null = "/mock/ws";
  /** `session_path_hints.canPick`: this PC's folder dialog applies (own center on macOS / Windows). */
  centerCanPick = false;
  /** What the folder dialog (`pick_directory`) returns (null: cancelled). */
  pickedDirectory: string | null = null;
  /** When set, the folder dialog (`pick_directory`) fails with this message (no dialog on this OS). */
  pickError: string | null = null;
  /** Project settings the center keeps per session name (`session_settings_get` / `_update`, merged; `null` removes an item). */
  centerSettings: Record<string, Record<string, unknown>> = {};
  /** The center-wide settings (`center_settings_get` / `_update`, merged; `null` removes an item). */
  centerCommonSettings: Record<string, unknown> = {};
  /** When set, `center_settings_get` / `center_settings_update` fail with this message (center not reachable). */
  centerCommonSettingsError: string | null = null;
  /** When set, `session_settings_update` fails with this message (center isError / not reachable). */
  centerSettingsUpdateError: string | null = null;
  /** When set, center_set_settings fails with this message (a failed save). */
  centerSetSettingsError: string | null = null;
  /** sessionUrl `session_create` returns (null: not connected yet). */
  centerSessionUrl: string | null = "https://claude.ai/code/session_mock";
  calls: InvokeRecord[] = [];
  sent: { to: string; text: string }[] = [];
  /** Terminal: `session_output_start` / `session_output_stop` calls, keystrokes (base64) and size changes sent. */
  outputStarts: { session: string; after: number | null }[] = [];
  outputStops: string[] = [];
  inputs: { session: string; data: string }[] = [];
  resizes: { session: string; cols: number; rows: number }[] = [];
  /** Attachments: every `session_attach_*` call, what the pick dialog returns, and the paths "saved" so far. */
  attachCalls: { cmd: string; session: string; paths?: string[]; bytes?: number }[] = [];
  pickFiles: string[] = [];
  private attachSeq = 0;
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
    if (seed.center) Object.assign(this.center, seed.center);
    for (const name of seed.sessions ?? []) {
      const e = this.centerEntry(name, "connected", "https://claude.ai/code/session_" + name);
      this.centerSessions.push(e);
    }
    this.sessionCache = { sessions: this.centerSessions.map((e) => this.toSession(e)), reachable: true, reason: null, rev: 0 };
    this.update = seed.update;
    this.updateCheckFailures = seed.updateCheckFailures ?? 0;
    this.windowLabel = seed.windowLabel ?? "main";
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

  private centerEntry(name: string, state: string, sessionUrl: string | null): Record<string, unknown> {
    return { name, path: `/mock/.bantou/${name}`, state, pid: 4300, sessionUrl, startedAt: this.now(), source: "session" };
  }

  private toSession(e: Record<string, unknown>): Session {
    return {
      name: e.name as string,
      state: e.state as Session["state"],
      sessionUrl: (e.sessionUrl as string | null) ?? null,
      source: e.source as Session["source"],
      path: (e.path as string | undefined) ?? null,
      lastError: (e.lastError as string | undefined) ?? null,
      contextUsage: (e.contextUsage as Session["contextUsage"] | undefined) ?? null,
      instructions: (e.instructions as boolean | undefined) ?? false,
      activity: (e.activity as Session["activity"] | undefined) ?? null,
      activityAt: (e.activityAt as string | undefined) ?? null,
    };
  }

  /** The center no longer lists session `name` (it was stopped / removed there). */
  centerDrop(name: string) {
    this.centerSessions = this.centerSessions.filter((s) => s.name !== name);
  }

  /** The Rust SSE client delivers output chunk `id` of `session` (`text` is encoded as UTF-8, then base64). */
  /** Files released over the window (Tauri drag-drop event; position in physical pixels). */
  fileDrop(paths: string[], x: number, y: number) {
    this.emitter("tauri://drag-drop", { paths, position: { x, y } });
  }

  sessionOutput(session: string, id: number, text: string) {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    this.emitter("session-output", { session, id, data: btoa(bin), reset: false });
  }

  /** The center sent `reset` (the held position is too old): the view clears and repaints from what follows. */
  sessionReset(session: string) {
    this.emitter("session-output", { session, id: 0, data: "", reset: true });
  }

  /** Connection state of the output stream. */
  sessionOutputStatus(session: string, state: "connected" | "retrying" | "rejected", message: string | null = null) {
    this.emitter("session-output-status", { session, state, message });
  }

  /** The center's `GET /events` reported a session change (forwarded by the Rust side). */
  centerSessionsChanged(reason: string | null = "created", name: string | null = null) {
    this.emitter("center-sessions-changed", { reason, name });
  }

  /** The own sidecar center was started (Rust `center::CENTER_RUNNING_EVENT`). */
  centerRunning() {
    this.emitter("bantou://center-running", "running");
  }

  /** The machine woke from sleep. */
  osWake() {
    this.emitter("bantou://os-wake", null);
  }

  /** A network interface / address changed. */
  osNetworkChanged() {
    this.emitter("bantou://os-network-changed", null);
  }

  /** Where the mocked desktop would connect: the same rule as `select_target`. */
  private hasCenterTarget() {
    return this.center.enabled || !!this.center.remote;
  }

  /** `session_list` as the Rust side sees it: fails when there is no target or the center does not answer. */
  private fetchCenterList(): Record<string, unknown>[] {
    if (!this.hasCenterTarget()) throw new Error("接続先が無い（center を有効にするか、別ホストの接続設定を貼る）");
    if (!this.centerReachable) throw new Error("center に接続できない: mock");
    return this.centerSessions;
  }

  /** Mirror of `session.rs::read_list`: the center's list replaces the cache; when it cannot be asked the old list stays. */
  private readList(): SessionList {
    let next: SessionList;
    try {
      next = { sessions: this.fetchCenterList().map((e) => this.toSession(e)), reachable: true, reason: null, rev: this.sessionCache.rev };
    } catch (e) {
      next = { sessions: this.sessionCache.sessions, reachable: false, reason: e instanceof Error ? e.message : String(e), rev: this.sessionCache.rev };
    }
    if (JSON.stringify(next) !== JSON.stringify(this.sessionCache)) {
      next.rev += 1;
      this.sessionCache = next;
      this.emitter("bantou://sessions-changed", null);
    }
    return next;
  }

  /** `session_create` on the center: validates, appends to its list and returns the new entry. */
  private createCenterSession(name: string, path?: string | null): Record<string, unknown> {
    this.fetchCenterList();
    if (this.centerSessionCreateError) throw new Error(this.centerSessionCreateError);
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("name は英数字と _ - のみ");
    if (this.centerSessions.some((s) => s.name === name)) throw new Error(`name が既に使われている: ${name}`);
    if (path && !path.startsWith("/")) throw new Error("path は絶対パスで指定する");
    const clash = path ? this.centerSessions.find((s) => s.path === path) : undefined;
    if (clash) throw new Error(`path が既に使われている: ${path}（${clash.name as string}）`);
    const e = this.centerEntry(name, this.centerSessionUrl ? "connected" : "starting", this.centerSessionUrl);
    if (path) e.path = path;
    else if (this.centerWorkspace) e.path = `${this.centerWorkspace}/${name}`;
    this.centerSessions.push(e);
    return e;
  }

  /** `session_update` on the center: renames and / or changes the folder; the settings key follows the name. */
  private updateCenterSession(name: string, newName?: string | null, path?: string | null): Record<string, unknown> {
    this.fetchCenterList();
    if (this.centerSessionUpdateError) throw new Error(this.centerSessionUpdateError);
    const e = this.centerSessions.find((s) => s.name === name);
    if (!e) throw new Error(`session が無い: ${name}`);
    if (newName && newName !== name) {
      if (!/^[A-Za-z0-9_-]+$/.test(newName)) throw new Error("newName は英数字と _ - のみ");
      if (this.centerSessions.some((s) => s.name === newName)) throw new Error(`name が既に使われている: ${newName}`);
    }
    if (path) {
      if (!path.startsWith("/")) throw new Error("path は絶対パスで指定する");
      const clash = this.centerSessions.find((s) => s.path === path && s !== e);
      if (clash) throw new Error(`path が既に使われている: ${path}（${clash.name as string}）`);
      e.path = path;
    }
    if (newName && newName !== name) {
      e.name = newName;
      if (this.centerSettings[name]) {
        this.centerSettings[newName] = this.centerSettings[name];
        delete this.centerSettings[name];
      }
    }
    return e;
  }

  listenerIds(event: string) {
    return this.listeners.get(event) ?? [];
  }

  /** Mirror of `attachment.rs`: type / size refusals, then "save" and type the path into the pty (inputs). */
  private attach(session: string, items: { name: string; ext: string | null; big?: boolean }[]) {
    const out: { saved: string[]; errors: string[] } = { saved: [], errors: [] };
    for (const it of items) {
      if (it.big) out.errors.push(`${it.name}: 20MB を超えている（1 枚 20MB まで）`);
      else if (!it.ext) out.errors.push(`${it.name}: 画像の型が違う（png / jpeg / gif / webp のみ）`);
      else out.saved.push(`/ws/${session}/attachments/20261104-024500-${String(++this.attachSeq).padStart(2, "0")}.${it.ext}`);
    }
    if (out.saved.length > 0) {
      const text = ` ${out.saved.join(" ")} `;
      this.inputs.push({ session, data: btoa(text) });
    }
    return out;
  }

  private fileItems(paths: string[]) {
    return paths.map((p) => {
      const name = p.split("/").pop() ?? p;
      const ext = /\.(png|jpe?g|gif|webp)$/i.exec(name)?.[1]?.toLowerCase().replace("jpeg", "jpg") ?? null;
      return { name, ext, big: name.includes("big") };
    });
  }

  invoke(cmd: string, raw: unknown, options?: { headers?: Record<string, string> }): unknown {
    const args = (raw ?? {}) as Record<string, unknown>;
    this.calls.push({ cmd, args: raw instanceof Uint8Array ? { bytes: raw.length } : JSON.parse(JSON.stringify(args)) });
    switch (cmd) {
      case "get_workspace_directory":
        return this.dir;
      case "set_workspace_directory":
        this.dir = args.path as string;
        return null;
      case "pick_directory":
        if (this.pickError) throw new Error(this.pickError);
        return this.pickedDirectory;
      case "session_path_hints":
        return { workspace: this.centerWorkspace, canPick: this.centerCanPick };
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
        return structuredClone(this.sessionCache);
      case "refresh_sessions":
        return structuredClone(this.readList());
      case "create_session": {
        const name = (args.name as string).trim();
        const s = this.toSession(this.createCenterSession(name, args.path as string | null | undefined));
        const settings = (args.settings as Record<string, unknown> | null | undefined) ?? {};
        const kept = Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== null && v !== ""));
        if (Object.keys(kept).length) this.centerSettings[name] = kept;
        this.readList();
        if (this.centerSessionCreateDelayMs > 0) {
          return new Promise((done) => setTimeout(() => done(structuredClone(s)), this.centerSessionCreateDelayMs));
        }
        return structuredClone(s);
      }
      case "session_update": {
        const e = this.updateCenterSession(
          (args.name as string).trim(),
          args.newName as string | null | undefined,
          args.path as string | null | undefined,
        );
        const s = this.toSession(e);
        this.readList();
        if (this.centerSessionUpdateDelayMs > 0) {
          return new Promise((done) => setTimeout(() => done(structuredClone(s)), this.centerSessionUpdateDelayMs));
        }
        return structuredClone(s);
      }
      case "session_get_settings":
        return structuredClone(this.centerSettings[(args.name as string).trim()] ?? {});
      case "session_update_settings": {
        if (this.centerSettingsUpdateError) throw new Error(this.centerSettingsUpdateError);
        const name = (args.name as string).trim();
        const next = { ...(this.centerSettings[name] ?? {}) };
        for (const [k, v] of Object.entries(args.settings as Record<string, unknown>)) {
          if (v === null || v === "") delete next[k];
          else next[k] = v;
        }
        if (Object.keys(next).length) this.centerSettings[name] = next;
        else delete this.centerSettings[name];
        return structuredClone(next);
      }
      case "session_output_start":
        this.outputStarts.push({ session: args.session as string, after: (args.after as number | null) ?? null });
        return null;
      case "session_output_stop":
        this.outputStops.push(args.session as string);
        return null;
      case "session_input":
        this.inputs.push({ session: args.session as string, data: args.dataB64 as string });
        return null;
      case "session_attach_bytes": {
        const bytes = raw as Uint8Array;
        const session = options?.headers?.["x-bantou-session"] ?? "";
        this.attachCalls.push({ cmd, session, bytes: bytes.length });
        const png = bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50;
        return this.attach(session, [{ name: "クリップボードの画像", ext: png ? "png" : null }]);
      }
      case "session_attach_paths": {
        const session = args.session as string;
        const paths = args.paths as string[];
        this.attachCalls.push({ cmd, session, paths });
        return this.attach(session, this.fileItems(paths));
      }
      case "session_attach_pick": {
        const session = args.session as string;
        const paths = this.pickFiles;
        this.pickFiles = [];
        this.attachCalls.push({ cmd, session, paths });
        return paths.length > 0 ? this.attach(session, this.fileItems(paths)) : { saved: [], errors: [] };
      }
      case "session_resize":
        this.resizes.push({ session: args.session as string, cols: args.cols as number, rows: args.rows as number });
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
        if (this.centerSetSettingsError) throw this.centerSetSettingsError;
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
          case "worker_reply":
            if (this.centerWorkerReplyError) throw new Error(this.centerWorkerReplyError);
            this.centerWorkerReplies.push(args.arguments);
            return text({ ok: true, accepted: true });
          case "session_list":
            return text(this.fetchCenterList());
          case "center_settings_get":
            if (this.centerCommonSettingsError) throw new Error(this.centerCommonSettingsError);
            return text({ settings: structuredClone(this.centerCommonSettings) });
          case "center_settings_update": {
            if (this.centerCommonSettingsError) throw new Error(this.centerCommonSettingsError);
            const next = { ...this.centerCommonSettings };
            for (const [k, v] of Object.entries((args.arguments as { settings: Record<string, unknown> }).settings)) {
              if (v === null || v === "") delete next[k];
              else next[k] = v;
            }
            this.centerCommonSettings = next;
            return text({ settings: structuredClone(next) });
          }
          case "session_create":
            return text(this.createCenterSession((args.arguments as { name: string }).name));
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
        if (this.updateCheckFailures > 0) {
          this.updateCheckFailures--;
          throw new Error("error sending request for url (https://example.invalid/latest.json)");
        }
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
