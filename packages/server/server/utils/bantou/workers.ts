import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isValidAgentId, type AgentActivity } from "@agent-hand/bantou-protocol";
import type { AgentManager } from "./agents";
import type { ActivityTracker } from "./activity";
import type { WorkerCleaner } from "./cleanup";
import { agentDir, laneDir, runLogDir } from "./paths";
import { readState } from "./state";
import { assertModel, readModelRecord, type WithModel } from "./model";

export interface WorkerStartInput {
  worker_id?: string;
  prompt: string;
  repo?: string;
  branch?: string;
  /** この worker の claude --model。省略時は前回の記録、それも無ければ cap の worker_model、それも無ければ付けない。 */
  model?: string;
}

/**
 * taskId = 呼び出し元の指揮が受け持つ task（mcp の x-bantou-task-id）。指揮の run が task の lane なら付く。
 * start: 新しい worker はその task のものになる。既存の worker は、別の task（まだ動いている）のものなら断る。
 * status: worker_id を省くと、その task の worker だけを返す。stop: 別の task（まだ動いている）の worker は断る。
 */
export interface WorkerHub {
  start(capId: string, input: WorkerStartInput, taskId?: string): Promise<{ worker_id: string; accepted: true }>;
  status(capId: string, workerId?: string, taskId?: string): Promise<{ workers: Array<WithModel<AgentActivity>> }>;
  stop(capId: string, workerId: string, taskId?: string): Promise<{ worker_id: string; stopped: boolean }>;
}

export interface WorkerHubDeps {
  workspace: string;
  manager: Pick<AgentManager, "invoke" | "stop">;
  activity: Pick<ActivityTracker, "snapshot">;
  log: (msg: string) => void;
  /** 終わった worker の掃除。start の入口で待ち時間を数え直し、掃除中なら完了を待つ。 */
  cleaner?: Pick<WorkerCleaner, "begin">;
  /** worker_id の採番（テスト用）。 */
  newId?: () => string;
  /** その cap の task が待ちか実行中か（別の task の worker を触らせない判定）。省略時は常に false（task をまたいで触れる）。 */
  taskActive?: (capId: string, taskId: string) => boolean;
}

/** 持ち主の記録先。state.json は agents.ts が丸ごと書き換えるので別ファイルにする（center.json と同じ流儀）。 */
const ownerFile = (workerDir: string): string => join(runLogDir(workerDir), "owner.json");

/** 持ち主の記録。task_id = その worker を起動した task（cap の task の lane。kick_cap の worker・旧形式は無い）。 */
export interface OwnerRecord {
  capId: string;
  taskId?: string;
}

export async function readOwnerRecord(workspace: string, workerId: string): Promise<OwnerRecord | undefined> {
  try {
    const d = JSON.parse(await readFile(ownerFile(agentDir(workspace, "worker", workerId)), "utf8")) as { cap_id?: unknown; task_id?: unknown };
    if (typeof d.cap_id !== "string" || d.cap_id === "") return undefined;
    return { capId: d.cap_id, ...(isValidAgentId(d.task_id) ? { taskId: d.task_id } : {}) };
  } catch {
    return undefined;
  }
}

export async function readOwner(workspace: string, workerId: string): Promise<string | undefined> {
  return (await readOwnerRecord(workspace, workerId))?.capId;
}

/** worker を起動した task（無ければ undefined）。 */
export async function readOwnerTask(workspace: string, workerId: string): Promise<string | undefined> {
  return (await readOwnerRecord(workspace, workerId))?.taskId;
}

/** 持ち主を記録する（冪等）。taskId を省くと task 無し（kick_cap の worker）として書く。 */
export async function writeOwner(workspace: string, workerId: string, capId: string, taskId?: string): Promise<void> {
  const dir = agentDir(workspace, "worker", workerId);
  await mkdir(runLogDir(dir), { recursive: true });
  await writeFile(ownerFile(dir), JSON.stringify({ cap_id: capId, ...(taskId !== undefined ? { task_id: taskId } : {}) }) + "\n");
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

  /** 別の task（まだ動いている）の worker なら投げる。 */
  function guardTask(capId: string, workerId: string, owner: OwnerRecord | undefined, taskId: string | undefined): void {
    if (taskId === undefined || owner?.taskId === undefined || owner.taskId === taskId) return;
    if (deps.taskActive?.(capId, owner.taskId) === true) throw new Error(`別の task（${owner.taskId}）の worker: ${workerId}`);
  }

  async function start(capId: string, input: WorkerStartInput, taskId?: string): Promise<{ worker_id: string; accepted: true }> {
    await requireCap(capId);
    if (taskId !== undefined && !isValidAgentId(taskId)) throw new Error(`task_id が不正: ${taskId}`);
    const workerId = input.worker_id ?? newId();
    if (!isValidAgentId(workerId)) throw new Error(`worker_id が不正: ${workerId}`);
    if (typeof input.prompt !== "string" || input.prompt === "" || input.prompt.includes("\0")) {
      throw new Error("prompt は空でない文字列（NUL 不可）");
    }
    if (input.model !== undefined) assertModel(input.model, "model");
    const ownerRec = await readOwnerRecord(workspace, workerId);
    const owner = ownerRec?.capId;
    if (owner !== undefined && owner !== capId) throw new Error(`別の cap の worker: ${workerId}`);
    guardTask(capId, workerId, ownerRec, taskId);
    // worker の task: 呼び出し元の task。無ければ（center の worker_reply・kick_cap の指揮）これまでの task のまま
    const lane = taskId ?? ownerRec?.taskId;
    // 掃除中ならその完了を待つ（dir が消えた後は clone し直しで起動する）。持ち主の確認の後（他の cap が掃除を妨げられない）
    await deps.cleaner?.begin(workerId);
    const dir = agentDir(workspace, "worker", workerId);
    // repo 付きの初回は clone 先が存在してはいけないので、持ち主の記録は clone の後（runExtras）に任せる
    if (!(input.repo && !(await exists(dir)))) await writeOwner(workspace, workerId, capId, lane);
    // 指定が無ければ task の worker_model、無ければ cap の worker_model（manager が worker の前回記録を優先して使う）
    let capModel: string | undefined;
    if (input.model === undefined) {
      if (lane !== undefined) capModel = (await readModelRecord(laneDir(workspace, capId, lane))).worker_model;
      capModel ??= (await readModelRecord(agentDir(workspace, "cap", capId))).worker_model;
    }
    log(`worker_start: cap_id=${capId}${lane !== undefined ? ` task_id=${lane}` : ""} worker_id=${workerId} prompt=${oneLine(input.prompt, 80)}`);
    // 完了は待たない。失敗は activity と state.json に出る
    deps.manager
      .invoke("worker", workerId, {
        prompt: input.prompt,
        ...(input.repo ? { repo: input.repo } : {}),
        ...(input.branch ? { branch: input.branch } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(capModel !== undefined ? { defaultModel: capModel } : {}),
        reason: `worker_start from cap ${capId}`,
        capId,
        ...(lane !== undefined ? { taskId: lane } : {}),
      })
      .then(
        (r) => log(`worker 終了: worker_id=${workerId} ok=${r.ok}`),
        (e: unknown) => log(`エラー: worker 起動: worker_id=${workerId} ${errMsg(e)}`),
      );
    return { worker_id: workerId, accepted: true };
  }

  /** tracker に無い worker（server 再起動前のもの等）を state.json から補う。 */
  async function fromState(capId: string, workerId: string, taskId?: string): Promise<WithModel<AgentActivity> | undefined> {
    const dir = agentDir(workspace, "worker", workerId);
    const st = await readState(dir).catch(() => null);
    if (st === null) return undefined;
    const fresh = st.session_id === null && st.state === "idle";
    const state = fresh || st.state === "running" ? "running" : st.state === "idle" ? "idle" : "failed";
    const base = st.last_finished_at ?? st.last_started_at;
    const a: WithModel<AgentActivity> = {
      kind: "worker",
      id: workerId,
      cap_id: capId,
      state,
      task: "",
      model: (await readModelRecord(dir)).model ?? null,
      last_activity: fresh ? "starting" : null,
      last_output_at: null,
      silent_ms: base ? Math.max(0, Date.now() - Date.parse(base)) : 0,
      started_at: st.last_started_at,
      finished_at: st.state === "running" ? null : st.last_finished_at,
      ...(taskId !== undefined ? { task_id: taskId } : {}),
    };
    if (st.last_error !== undefined && state === "failed") a.error = oneLine(st.last_error, 200);
    return a;
  }

  async function status(capId: string, workerId?: string, taskId?: string): Promise<{ workers: Array<WithModel<AgentActivity>> }> {
    await requireCap(capId);
    if (workerId !== undefined) {
      if (!isValidAgentId(workerId)) throw new Error(`worker_id が不正: ${workerId}`);
      await requireOwned(capId, workerId);
    }
    // task の指揮が worker_id を省いた時は、その task の worker だけ
    const onlyTask = workerId === undefined ? taskId : undefined;
    const tracked0 = deps.activity.snapshot(capId).filter((a) => a.kind === "worker" && (workerId === undefined || a.id === workerId));
    const tracked: typeof tracked0 = [];
    for (const a of tracked0) {
      if (onlyTask === undefined || (a.task_id ?? (await readOwnerTask(workspace, a.id))) === onlyTask) tracked.push(a);
    }
    const seen = new Set(tracked0.map((a) => a.id));
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
    const extra: Array<WithModel<AgentActivity>> = [];
    for (const id of ids.sort()) {
      if (seen.has(id)) continue;
      const rec = await readOwnerRecord(workspace, id);
      if (rec?.capId !== capId) continue;
      if (onlyTask !== undefined && rec.taskId !== onlyTask) continue;
      const a = await fromState(capId, id, rec.taskId);
      if (a) extra.push(a);
    }
    return { workers: [...tracked, ...extra].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };
  }

  async function stop(capId: string, workerId: string, taskId?: string): Promise<{ worker_id: string; stopped: boolean }> {
    await requireCap(capId);
    if (!isValidAgentId(workerId)) throw new Error(`worker_id が不正: ${workerId}`);
    await requireOwned(capId, workerId);
    guardTask(capId, workerId, await readOwnerRecord(workspace, workerId), taskId);
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
