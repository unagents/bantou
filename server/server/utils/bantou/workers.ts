import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isValidAgentId, type AgentActivity } from "@agent-hand/bantou-protocol";
import type { AgentManager } from "./agents";
import type { ActivityTracker } from "./activity";
import { agentDir, runLogDir } from "./paths";
import { readState } from "./state";

export interface WorkerStartInput {
  worker_id?: string;
  prompt: string;
  repo?: string;
  branch?: string;
}

export interface WorkerHub {
  start(capId: string, input: WorkerStartInput): Promise<{ worker_id: string; accepted: true }>;
  status(capId: string, workerId?: string): Promise<{ workers: AgentActivity[] }>;
  stop(capId: string, workerId: string): Promise<{ worker_id: string; stopped: boolean }>;
}

export interface WorkerHubDeps {
  workspace: string;
  manager: Pick<AgentManager, "invoke" | "stop">;
  activity: Pick<ActivityTracker, "snapshot">;
  log: (msg: string) => void;
  /** worker_id の採番（テスト用）。 */
  newId?: () => string;
}

/** 持ち主の記録先。state.json は agents.ts が丸ごと書き換えるので別ファイルにする（center.json と同じ流儀）。 */
const ownerFile = (workerDir: string): string => join(runLogDir(workerDir), "owner.json");

export async function readOwner(workspace: string, workerId: string): Promise<string | undefined> {
  try {
    const d = JSON.parse(await readFile(ownerFile(agentDir(workspace, "worker", workerId)), "utf8")) as { cap_id?: unknown };
    return typeof d.cap_id === "string" && d.cap_id !== "" ? d.cap_id : undefined;
  } catch {
    return undefined;
  }
}

/** 持ち主を記録する（冪等）。 */
export async function writeOwner(workspace: string, workerId: string, capId: string): Promise<void> {
  const dir = agentDir(workspace, "worker", workerId);
  await mkdir(runLogDir(dir), { recursive: true });
  await writeFile(ownerFile(dir), JSON.stringify({ cap_id: capId }) + "\n");
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const oneLine = (s: string, n: number): string => s.replace(/\s+/g, " ").trim().slice(0, n);

export function createWorkerHub(deps: WorkerHubDeps): WorkerHub {
  const { workspace, log } = deps;
  const newId = deps.newId ?? ((): string => `w-${randomBytes(5).toString("hex")}`);

  async function requireCap(capId: string): Promise<void> {
    if (!isValidAgentId(capId)) throw new Error(`cap_id が不正: ${capId}`);
    try {
      await stat(agentDir(workspace, "cap", capId));
    } catch {
      throw new Error(`cap が存在しない: ${capId}`);
    }
  }

  /** worker の持ち主が capId であることを確かめる。別の cap のものなら投げる。 */
  async function requireOwned(capId: string, workerId: string): Promise<void> {
    const owner = await readOwner(workspace, workerId);
    if (owner === undefined) throw new Error(`worker が存在しない: ${workerId}`);
    if (owner !== capId) throw new Error(`別の cap の worker: ${workerId}`);
  }

  async function exists(p: string): Promise<boolean> {
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  }

  async function start(capId: string, input: WorkerStartInput): Promise<{ worker_id: string; accepted: true }> {
    await requireCap(capId);
    const workerId = input.worker_id ?? newId();
    if (!isValidAgentId(workerId)) throw new Error(`worker_id が不正: ${workerId}`);
    if (typeof input.prompt !== "string" || input.prompt === "" || input.prompt.includes("\0")) {
      throw new Error("prompt は空でない文字列（NUL 不可）");
    }
    const owner = await readOwner(workspace, workerId);
    if (owner !== undefined && owner !== capId) throw new Error(`別の cap の worker: ${workerId}`);
    const dir = agentDir(workspace, "worker", workerId);
    // repo 付きの初回は clone 先が存在してはいけないので、持ち主の記録は clone の後（runExtras）に任せる
    if (!(input.repo && !(await exists(dir)))) await writeOwner(workspace, workerId, capId);
    log(`worker_start: cap_id=${capId} worker_id=${workerId} prompt=${oneLine(input.prompt, 80)}`);
    // 完了は待たない。失敗は activity と state.json に出る
    deps.manager
      .invoke("worker", workerId, {
        prompt: input.prompt,
        ...(input.repo ? { repo: input.repo } : {}),
        ...(input.branch ? { branch: input.branch } : {}),
        reason: `worker_start from cap ${capId}`,
        capId,
      })
      .then(
        (r) => log(`worker 終了: worker_id=${workerId} ok=${r.ok}`),
        (e: unknown) => log(`エラー: worker 起動: worker_id=${workerId} ${errMsg(e)}`),
      );
    return { worker_id: workerId, accepted: true };
  }

  /** tracker に無い worker（server 再起動前のもの等）を state.json から補う。 */
  async function fromState(capId: string, workerId: string): Promise<AgentActivity | undefined> {
    const dir = agentDir(workspace, "worker", workerId);
    const st = await readState(dir).catch(() => null);
    if (st === null) return undefined;
    const fresh = st.session_id === null && st.state === "idle";
    const state = fresh || st.state === "running" ? "running" : st.state === "idle" ? "idle" : "failed";
    const base = st.last_finished_at ?? st.last_started_at;
    const a: AgentActivity = {
      kind: "worker",
      id: workerId,
      cap_id: capId,
      state,
      task: "",
      last_activity: fresh ? "starting" : null,
      last_output_at: null,
      silent_ms: base ? Math.max(0, Date.now() - Date.parse(base)) : 0,
      started_at: st.last_started_at,
      finished_at: st.state === "running" ? null : st.last_finished_at,
    };
    if (st.last_error !== undefined && state === "failed") a.error = oneLine(st.last_error, 200);
    return a;
  }

  async function status(capId: string, workerId?: string): Promise<{ workers: AgentActivity[] }> {
    await requireCap(capId);
    if (workerId !== undefined) {
      if (!isValidAgentId(workerId)) throw new Error(`worker_id が不正: ${workerId}`);
      await requireOwned(capId, workerId);
    }
    const tracked = deps.activity.snapshot(capId).filter((a) => a.kind === "worker" && (workerId === undefined || a.id === workerId));
    const seen = new Set(tracked.map((a) => a.id));
    const ids: string[] = [];
    if (workerId !== undefined) ids.push(workerId);
    else {
      let entries: Dirent[];
      try {
        entries = await readdir(join(workspace, "workers"), { withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const d of entries) if (d.isDirectory() && isValidAgentId(d.name)) ids.push(d.name);
    }
    const extra: AgentActivity[] = [];
    for (const id of ids.sort()) {
      if (seen.has(id)) continue;
      if ((await readOwner(workspace, id)) !== capId) continue;
      const a = await fromState(capId, id);
      if (a) extra.push(a);
    }
    return { workers: [...tracked, ...extra].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };
  }

  async function stop(capId: string, workerId: string): Promise<{ worker_id: string; stopped: boolean }> {
    await requireCap(capId);
    if (!isValidAgentId(workerId)) throw new Error(`worker_id が不正: ${workerId}`);
    await requireOwned(capId, workerId);
    const r = await deps.manager.stop("worker", workerId);
    log(`worker_stop: cap_id=${capId} worker_id=${workerId} stopped=${r.stopped}`);
    return { worker_id: workerId, stopped: r.stopped };
  }

  return { start, status, stop };
}

// -- /mcp route との橋渡し -------------------------------------------------------

let handler: WorkerHub | undefined;

/** daemon が起動後に設定する。未設定の間の /mcp は worker tool を拒否する。 */
export function setWorkerHandler(h: WorkerHub | undefined): void {
  handler = h;
}

export function getWorkerHandler(): WorkerHub | undefined {
  return handler;
}
