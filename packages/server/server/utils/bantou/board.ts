import { createHash } from "node:crypto";
import type { AgentActivity, AgentStatus, ResourceSample, ServerBoard } from "@agent-hand/bantou-protocol";

/**
 * server の掲示板。自分が管理する cap と稼働中の worker の数・host の資源・予約の件数を載せる（数と資源だけ。task の中身・branch は載せない = U6 A）。
 * 足りるかの判定はしない（閾値を持たない。判断は cap）。
 */

export interface BoardSource {
  /** cap の AgentStatus（manager.status().caps。tasks を載せる前でよい）。 */
  caps: Array<Pick<AgentStatus, "id" | "state">>;
  /** 稼働中の worker の activity（tracker.snapshot()）。 */
  activity: Array<Pick<AgentActivity, "kind" | "cap_id" | "state">>;
  /** 稼働中の worker の本数（manager.activeCount().workers）。 */
  workers: number;
  /** cap の task の状態（scheduler.snapshot）。 */
  taskCounts: (capId: string) => { running: number; waiting: number };
  /** cap の予約の件数。 */
  reservedOf: (capId: string) => number;
  reservedTotal: number;
  resources: ResourceSample | null;
  maxParallelTasks: number | undefined;
  now?: () => number;
}

export function buildBoard(s: BoardSource): ServerBoard {
  const now = s.now ?? Date.now;
  const workersOf = (capId: string): number => s.activity.filter((a) => a.kind === "worker" && a.cap_id === capId && (a.state === "running" || a.state === "stalled")).length;
  return {
    at: new Date(now()).toISOString(),
    caps: s.caps.map((c) => {
      const t = s.taskCounts(c.id);
      return { cap_id: c.id, state: c.state, running_tasks: t.running, waiting_tasks: t.waiting, workers: workersOf(c.id), reserved: s.reservedOf(c.id) };
    }),
    workers: s.workers,
    reserved: s.reservedTotal,
    resources: s.resources,
    max_parallel_tasks: s.maxParallelTasks ?? null,
  };
}

/** 他の cap への不透明な参照（cap_id は session 名を含むので、そのままは返さない）。 */
export function capRef(capId: string): string {
  return `cap-${createHash("sha256").update(capId).digest("hex").slice(0, 8)}`;
}

/** cap が見る他の cap の様子（peer_status）。 */
export interface PeerCapInfo {
  cap_ref: string;
  running_workers: number;
  waiting_tasks: number;
  reserved_workers: number;
  /** 後続なし = 待ち task が 0 件・予約が 0 件・指揮の run が動いていない（server が持つ事実だけで決める。U9 A）。 */
  no_followers: boolean;
}

export interface PeerStatus {
  /** 自分の cap。 */
  self: PeerCapInfo & { running_tasks: number };
  /** 同じ server の他の cap（数だけ。中身は返さない）。 */
  peers: PeerCapInfo[];
  /** server 全体（資源・worker 数・予約の件数。閾値は無く、足りるかは cap が判断する）。 */
  host: Pick<ServerBoard, "workers" | "reserved" | "resources" | "max_parallel_tasks">;
}

export function buildPeerStatus(
  selfCapId: string,
  board: ServerBoard,
  isRunning: (capId: string) => boolean,
): PeerStatus {
  const info = (capId: string): PeerCapInfo & { running_tasks: number } => {
    const c = board.caps.find((x) => x.cap_id === capId);
    const running_workers = c?.workers ?? 0;
    const waiting_tasks = c?.waiting_tasks ?? 0;
    const reserved_workers = c?.reserved ?? 0;
    return {
      cap_ref: capRef(capId),
      running_workers,
      waiting_tasks,
      reserved_workers,
      no_followers: waiting_tasks === 0 && reserved_workers === 0 && !isRunning(capId),
      running_tasks: c?.running_tasks ?? 0,
    };
  };
  return {
    self: info(selfCapId),
    peers: board.caps.filter((c) => c.cap_id !== selfCapId).map((c) => {
      const { running_tasks: _r, ...rest } = info(c.cap_id);
      return rest;
    }),
    host: { workers: board.workers, reserved: board.reserved, resources: board.resources, max_parallel_tasks: board.max_parallel_tasks },
  };
}
