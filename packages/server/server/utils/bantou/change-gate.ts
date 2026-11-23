/**
 * step の終わりの確かめ（設計書 3.4）。server は openspec-mcp に聞いて、artifact の状態（done / ready / blocked）と
 * apply の進み（済んだ数・全体の数・complete）を読み、通った / 通らないを判定する。
 * step の参照（ref）の中身は解釈しない（決定 21）: そのまま openspec-mcp に渡す。
 * openspec-mcp を呼ぶ所は ChangeGate に閉じる（test は偽の相手で書く）。呼び出しの形は【openspec-mcp 待ち】。
 */

/** openspec-mcp が返す step の状態。どちらか（または両方）が付く。 */
export interface StepStatus {
  /** ref が指す artifact の状態。 */
  artifact?: "done" | "ready" | "blocked";
  /** ref が指す apply の進み。 */
  apply?: { done: number; total: number; complete: boolean };
}

export interface ChangeGate {
  /** 使えない理由（未設定など）。使えるなら undefined。register_change を受ける前に見る。 */
  unavailable(): string | undefined;
  /** step の今の状態を openspec-mcp に聞く。聞けなければ投げる。 */
  status(changeId: string, ref: string): Promise<StepStatus>;
}

export interface GateVerdict {
  passed: boolean;
  /** 通らなかった中身。worker に渡す。 */
  reason?: string;
}

/**
 * 通った / 通らないの判定。読むのは状態だけ（名前・種類は見ない）。
 * 通る = 付いている物が全部満たされている（artifact なら done、apply なら complete）。何も付いていなければ通らない。
 */
export function judgeStep(s: StepStatus): GateVerdict {
  if (s.artifact === undefined && s.apply === undefined) return { passed: false, reason: "openspec-mcp から step の状態が返らなかった" };
  const problems: string[] = [];
  if (s.artifact !== undefined && s.artifact !== "done") problems.push(`artifact の状態が ${s.artifact}（done でない）`);
  if (s.apply !== undefined && !s.apply.complete) problems.push(`apply の進みが ${s.apply.done}/${s.apply.total}（complete でない）`);
  return problems.length === 0 ? { passed: true } : { passed: false, reason: problems.join("、") };
}

/** schema の取り先（center の schema の MCP server）の指定。形は mcpServers の 1 件分（type は http だけ。決定 20）。 */
export interface SchemaDiscoverySpec {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

/** header `x-schema-discovery` の名前（決定 13・20）。 */
export const SCHEMA_DISCOVERY_HEADER = "x-schema-discovery";

/** openspec-mcp につなぐ時に付ける header 一式。x-schema-discovery の中身は JSON 1 本。 */
export function openspecHeaders(spec: SchemaDiscoverySpec, extra: Record<string, string> = {}): Record<string, string> {
  return { ...extra, [SCHEMA_DISCOVERY_HEADER]: JSON.stringify(spec) };
}

export interface OpenspecMcpOptions {
  /** 全 server が共有する 1 つの openspec-mcp の URL。 */
  url: string;
  schemaDiscovery: SchemaDiscoverySpec;
}

/**
 * 本物の openspec-mcp への口（決定 13）。接続先と header の組み立てまでで、問い合わせの形（resource か tool か・URI・応答の中身）は
 * openspec-mcp の project が決める【openspec-mcp 待ち】ので、status は未実装として投げる。実測はしていない。
 */
export function createOpenspecMcpGate(opts: OpenspecMcpOptions): ChangeGate & { headers: () => Record<string, string> } {
  return {
    unavailable: () => undefined,
    headers: () => openspecHeaders(opts.schemaDiscovery),
    status: async () => {
      throw new Error("openspec-mcp への問い合わせの形が未確定（プロトコル待ち）のため、step の終わりを確かめられない");
    },
  };
}

/** openspec-mcp が config に無い時の口。change を受けない。 */
export function createUnconfiguredGate(): ChangeGate {
  return {
    unavailable: () => "openspec-mcp が config に無い（openspecMcp）",
    status: async () => {
      throw new Error("openspec-mcp が config に無い");
    },
  };
}
