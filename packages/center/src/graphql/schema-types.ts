/**
 * GraphQL schema: 共有の型（docs/design/center-graphql-server.md 2.3）。
 * 形は `packages/ui/types/index.ts`（今の画面が使う型）に合わせる（名前も snake_case のまま。画面側の写しをなくすため）。
 * null は「古い center が送らない」の意味を含む（ui の注記と同じ）。field の追加だけを許す（#13 案 A）。
 * 配置: Query / Mutation / Subscription は schema-query.ts / schema-mutation.ts / schema-subscription.ts。
 */
export const typeDefs = /* GraphQL */ `
  """ 任意の JSON 値（mcpServers・memory のような開いた形の設定、ui の Record<string, unknown>）。 """
  scalar JSON

  enum SessionState { stopped starting connected error }
  enum SessionSource { config session }
  """ needs-input は GraphQL の名前に使えないので needs_input（内部の値は resolvers/enums.ts で写す）。 """
  enum SessionActivityState { working needs_input idle unknown }
  enum AuthState { ok login_required keychain_locked }
  enum FollowState { ok unsupported updating mismatch failed lost unknown }
  enum ActivityState { running stalled idle done failed lost }
  enum RemoteState { running done failed unknown }
  enum AgentKind { cap worker }
  enum WorkerReportKind { progress ask approve done }
  enum RemoteIssueKind { failed no_result }
  enum RetireState { retiring already_retiring }
  enum ReviewSeverity { high medium low }
  enum ReviewVerdict { ok issues unknown }
  enum TaskResultState { done failed }
  enum RcState { stopped starting connected error }
  enum CenterRunState { stopped running restarting error }

  # ---- session ----

  type ContextUsage {
    usedTokens: Int!
    windowTokens: Int
    percent: Float
    updatedAt: String
  }

  type SessionBackground {
    subagents: Int!
    tasks: Int!
  }

  type RemoteIssue {
    server: String!
    remoteId: String!
    lastOkAt: String
    at: String
    kind: RemoteIssueKind
    taskId: String
    detail: String
  }

  type SessionRemote {
    running: Int!
    waitingReply: Int!
    unreachable: [RemoteIssue!]
    lost: [RemoteIssue!]
    stopped: [RemoteIssue!]
  }

  type Session {
    name: String!
    state: SessionState
    sessionUrl: String
    source: SessionSource
    lastError: String
    path: String
    contextUsage: ContextUsage
    instructions: Boolean!
    activity: SessionActivityState
    activityAt: String
    background: SessionBackground
    remote: SessionRemote
    auth: AuthState
    loginUrl: String
    loginError: String
    sleeping: Boolean!
  }

  type SessionList {
    sessions: [Session!]!
    """ false: center に聞けなかった（sessions は古い一覧）。 """
    reachable: Boolean!
    reason: String
  }

  """ session_sleep の応答の形（{ name, state, accepted, sleeping, pending }）。pending: true は引継ぎを頼んだ段階で、まだ眠っていない（眠った事は sessionsChanged の reason sleep と Session.sleeping で分かる）。すでに眠っていれば sleeping: true・pending: false。 """
  type SleepSessionResult {
    name: String!
    state: String
    accepted: Boolean
    sleeping: Boolean
    pending: Boolean
  }

  # ---- 設定 ----

  """
  project（= session）の設定。決定 6: launcher 鍵で守っていた 7 項目（memory / mcpServers / projectMemory / mcp / mcpConnections / mcpSecrets / coordinator）も client の画面から変えられる。
  7 項目の field の形・値を画面に出すか入れるかは実装の task が決める（#6）。ここでは開いた JSON で置く。
  """
  type ProjectSettings {
    instructions: String
    addDirs: [String!]
    outputStyle: String
    servers: [String!]
    mcpServers: JSON
    memory: JSON
    projectMemory: JSON
    mcp: JSON
    mcpConnections: JSON
    mcpSecrets: JSON
    coordinator: JSON
  }

  """ 更新の入力。null = その項目を消す。入力に出さない項目は変えない。 """
  input ProjectSettingsInput {
    instructions: String
    addDirs: [String!]
    outputStyle: String
    servers: [String!]
    mcpServers: JSON
    memory: JSON
    projectMemory: JSON
    mcp: JSON
    mcpConnections: JSON
    mcpSecrets: JSON
    coordinator: JSON
  }

  """ center 共通の設定（ProjectSettings から servers を除いた物）。 """
  type CenterSettings {
    instructions: String
    addDirs: [String!]
    outputStyle: String
    """ guardrail の schema 定義: 名前 → { schema（schema.yaml の文字列）, templates（templates/ からの相対 path → 中身） }。center 共通の設定だけ。 """
    guardrailSchemas: JSON
    mcpServers: JSON
    memory: JSON
    projectMemory: JSON
    mcp: JSON
    mcpConnections: JSON
    mcpSecrets: JSON
    coordinator: JSON
  }

  input CenterSettingsInput {
    instructions: String
    addDirs: [String!]
    outputStyle: String
    """ 名前ごとにマージ（定義は丸ごと置き換え）。名前の値 null でその schema を消し、guardrailSchemas 自体が null で全部消す。 """
    guardrailSchemas: JSON
    mcpServers: JSON
    memory: JSON
    projectMemory: JSON
    mcp: JSON
    mcpConnections: JSON
    mcpSecrets: JSON
    coordinator: JSON
  }

  type SystemInstructionPart {
    id: String!
    version: Int
    title: String
  }

  type CenterInfo {
    workspace: String
    systemInstructions: [SystemInstructionPart!]!
  }

  """ client が center の版を取って、自分の版と比べる（#13 案 A）。 """
  type CenterVersion {
    version: String
  }

  # ---- remote / server / rc ----

  type PendingInstruction {
    at: String!
    owner: String!
    prompt: String!
  }

  type AgentActivity {
    kind: AgentKind!
    id: String!
    cap_id: String!
    state: ActivityState!
    task: String!
    last_activity: String
    last_output_at: String
    silent_ms: Float!
    started_at: String
    finished_at: String
    error: String
    model: String
  }

  type RemoteActivity {
    at: String!
    received_ms_ago: Float!
    stale: Boolean!
    agents: [AgentActivity!]!
  }

  type ResourceSample {
    at: String!
    load1: Float!
    load5: Float!
    load15: Float!
    cpus: Int!
    mem_total: Float!
    mem_free: Float!
    disk_total: Float
    disk_free: Float
    workers: Int!
  }

  type ServerBoard {
    at: String!
    caps: Int!
    workers: Int!
    reserved: Int!
    max_parallel_tasks: Int
    resources: ResourceSample
  }

  type TaskResultWorker {
    worker_id: String!
    role: String!
    state: ActivityState!
    branch: String
    commit: String
    tests: String
    report_path: String
    result: String!
  }

  type ReviewItem {
    severity: ReviewSeverity!
    text: String!
    resolved: Boolean!
  }

  type TaskReview {
    verdict: ReviewVerdict!
    items: [ReviewItem!]!
    rounds: Int!
  }

  type TaskResult {
    cap_id: String!
    task_id: String!
    state: TaskResultState!
    summary: String!
    workers: [TaskResultWorker!]!
    review: TaskReview!
    remaining: [String!]!
    error: String
  }

  type WorkerReport {
    cap_id: String!
    task_id: String
    worker_id: String!
    kind: WorkerReportKind!
    text: String!
    at: String!
  }

  type RemoteRecord {
    remote_id: String!
    session: String
    owners: [String!]!
    server: String!
    server_id: String
    peer: String
    serverName: String
    serverHost: String
    serverUser: String
    serverWorkspace: String
    server_label: String
    state: RemoteState!
    model: String
    worker_model: String
    createdAt: String!
    finishedAt: String
    result: String
    result_at: String
    error: String
    error_at: String
    pending: [PendingInstruction!]
    activity: RemoteActivity
    server_board: ServerBoard
    task_result: TaskResult
    worker_reports: [WorkerReport!]
  }

  type ServerInfo {
    name: String!
    connected: Boolean!
    reachable: Boolean!
    peerId: String
    serverPeer: String
    server_id: String
    host: String
    user: String
    workspace: String
  }

  type ServerPeerUpdate {
    to: String!
    running: ServerPeerUpdateRunning
  }

  type ServerPeerUpdateRunning {
    caps: Int!
    workers: Int!
    reports: Int!
  }

  type ServerPeer {
    key: String!
    id: String!
    name: String!
    hostname: String
    server_id: String
    host: String
    user: String
    workspace: String
    server_version: String
    protocol_version: String
    state: FollowState!
    detail: String!
    update: ServerPeerUpdate
    since: String!
  }

  type ServerPair {
    server: String
    protocol: String!
  }

  type ServerPeers {
    pair: ServerPair!
    peers: [ServerPeer!]!
  }

  type RcStatus {
    project: String!
    path: String!
    state: RcState!
    pid: Int
    sessionUrl: String
    restarts: Int!
    lastError: String
  }

  # ---- mutation の結果 ----

  type LoginStart {
    name: String!
    loginUrl: String!
  }

  type LoginCodeResult {
    name: String!
    ok: Boolean!
    auth: AuthState!
    error: String
  }

  type RetireStopped {
    caps: Int!
    workers: Int!
  }

  type RetireService {
    manager: String!
    name: String
    detected: Boolean
  }

  type RetireResult {
    ok: Boolean!
    state: RetireState!
    server_id: String!
    host: String
    user: String
    workspace: String
    peer: String!
    stopped: RetireStopped
    exit_at: String
    exit_code: Int
    host_steps: [String!]
    service: RetireService
    records_removed: Int!
    sessions: [String!]!
    message: String!
  }

  """ 添付の保存結果（POST /sessions/<n>/attachments の 201。#7 の形が決まるまでの仮の形）。 """
  type AttachmentResult {
    path: String!
    bytes: Int!
  }

  # ---- subscription の payload ----

  """ center の session 増減・状態変化（reason は events.ts の 10 種）。client は取り直す。 """
  enum SessionsChangeReason { created deleted restored updated context activity remote changed sleep restarted }

  type SessionsChanged {
    reason: SessionsChangeReason!
    name: String!
  }

  type SessionMessage {
    session: String!
    text: String!
    at: String!
  }

  enum TerminalEventType { output reset status }

  """ 端末の出力。output = id + data（base64）、reset = queue を捨てて積み直す、status = end を含む状態。 """
  type TerminalEvent {
    type: TerminalEventType!
    id: Int
    data: String
    status: String
  }

  """ 端末の取り直し（after 以降のチャンク）。 """
  type TerminalChunk {
    id: Int!
    data: String!
  }

  type TerminalOutputSince {
    chunks: [TerminalChunk!]!
    reset: Boolean!
  }

  """ center 自身の状態。 """
  type CenterStatus {
    version: String
    running: Boolean!
    authRequired: Boolean
  }
`;
