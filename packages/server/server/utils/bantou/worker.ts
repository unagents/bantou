import type { ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { killGroup, type RunMode } from "./claude";
import { stripNpxEnv } from "./child-env";
import type { Config } from "./config";
import { buildExtraMcp, writeMcpConfigFile } from "./extra-mcp";
import { WORKER_ID_HEADER } from "./mcp";
import { ensureTmpDir, runLogDir } from "./paths";
import { WORKER_GUIDE } from "./prompts";
import { WORKER_SCHEMA_JSON, interpretResult, type CapMessage, type CapReport } from "./result";
import type { AgentRunner } from "./runner";
import { readState, writeState, type WorkerState } from "./state";
import { createTracker, type Tracker, type TrackerOptions } from "./tracker";
import type { Job } from "./queue";

/** 止める時、SIGTERM の後に SIGKILL を送るまでの猶予（ms）。 */
export const STOP_GRACE_MS = 3000;

export interface WorkerDeps {
  config: Config;
  runner: AgentRunner;
  /** worker の bash 道具の URL（/mcp）。未起動なら undefined。 */
  mcpUrl: () => string | undefined;
  /** cap（parent-id の名前）へ、ふつうの agent-messenger の message を送る（delivery push、meta 無し）。 */
  sendToCap: (to: string, body: CapMessage | CapReport) => Promise<void>;
  /** tracker の作り方（テストで差し替える）。 */
  makeTracker?: (o: TrackerOptions) => Tracker;
  log: (msg: string) => void;
}

export interface WorkerRunInput {
  workerId: string;
  /** worker の作業 dir（claude の cwd。state.json・logs/ もここ）。 */
  dir: string;
  parentId: string;
  ws: string;
  /** 省略されたら --model を付けない。 */
  model?: string;
  mode: RunMode;
  /** new はこの id で作る。resume はこの id を --resume する。 */
  sessionId: string;
  prompt: string;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** worker 1 回分の実行（起こす → 最後の result を読む → cap へ返す）を queue の Job にする。 */
export function createWorkerJob(deps: WorkerDeps, input: WorkerRunInput, kind: "launch" | "reply", onSettled?: () => void): Job {
  const { config, log } = deps;
  const makeTracker = deps.makeTracker ?? createTracker;
  let aborted = false;
  let child: ChildProcess | undefined;

  const abort = (): void => {
    aborted = true;
    const c = child;
    if (c === undefined) return;
    try {
      killGroup(c, "SIGTERM");
    } catch (e) {
      log(`worker を止められない: worker_id=${input.workerId} ${errMsg(e)}`);
    }
    const t = setTimeout(() => {
      try {
        killGroup(c, "SIGKILL");
      } catch {
        // すでに終わっている
      }
    }, STOP_GRACE_MS);
    t.unref?.();
  };

  const start = async (): Promise<void> => {
    if (aborted) return onSettled?.();
    const tracker = makeTracker({ parentId: input.parentId, ws: input.ws, log });
    let state: WorkerState | undefined;
    try {
      const startedAt = new Date().toISOString();
      state = {
        worker_id: input.workerId,
        session_id: input.sessionId,
        parent_id: input.parentId,
        ws: input.ws,
        model: input.model,
        last_started_at: startedAt,
        last_finished_at: null,
      };
      await mkdir(input.dir, { recursive: true });
      await writeState(input.dir, state);
      const tmp = await ensureTmpDir(input.dir);
      const url = deps.mcpUrl();
      if (!url) throw new Error("mcp が未起動");
      // 引数に本文を直書きすると " -- " を含む時に孤児回収が照合できなくなるのでファイルで渡す（claude.ts）
      const logs = runLogDir(input.dir);
      await mkdir(logs, { recursive: true });
      const mcpConfigFile = join(logs, "mcp.json");
      const appendSystemPromptFile = join(logs, "system-prompt.md");
      const extra = buildExtraMcp(config.extraMcp ?? {}, "worker", log);
      const mcpServers = { bantou: { type: "http", url, headers: { [WORKER_ID_HEADER]: input.workerId } }, ...extra.servers };
      // extraMcp の env を含みうるので本人だけが読める mode で書く
      await writeMcpConfigFile(mcpConfigFile, { mcpServers });
      await writeFile(appendSystemPromptFile, WORKER_GUIDE + "\n");
      if (aborted) return;
      log(`claude 起動: kind=${kind} worker_id=${input.workerId} parent_id=${input.parentId} mode=${input.mode} session=${input.sessionId} cwd=${input.dir}`);
      const result = await deps.runner.run({
        claude: config.session.claude,
        sessionId: input.sessionId,
        mode: input.mode,
        prompt: input.prompt,
        cwd: input.dir,
        permissionMode: config.session.permissionMode,
        allowedTools: config.session.allowedTools,
        disallowedTools: config.session.disallowedTools,
        capBashSandbox: config.session.capBashSandbox,
        extraArgs: config.session.extraArgs,
        model: input.model,
        timeoutMs: config.session.timeoutMs,
        logFile: join(logs, "claude.jsonl"),
        // TMPDIR は config.session.env でも上書きさせない（自分の path の tmp/ だけ）
        env: { ...stripNpxEnv(process.env), ...config.session.env, TMPDIR: tmp },
        mcpConfigFile,
        appendSystemPromptFile,
        jsonSchema: WORKER_SCHEMA_JSON,
        extraAllowedTools: ["mcp__bantou__bash", ...extra.allowedTools],
        onSpawn: (c) => {
          child = c;
          // spawn の間に stop が来ていた
          if (aborted) abort();
        },
        onLine: () => tracker.touch(),
      });
      child = undefined;
      state = { ...state, ...(result.ok ? { session_id: result.sessionId } : {}), last_finished_at: new Date().toISOString() };
      await writeState(input.dir, state).catch((e: unknown) => log(`state を書けない: worker_id=${input.workerId} ${errMsg(e)}`));
      if (aborted) {
        log(`stop で止めた worker の結果は cap へ送らない: worker_id=${input.workerId} parent_id=${input.parentId}`);
        return;
      }
      await send(interpretResult(result));
    } catch (e) {
      log(`worker の実行に失敗: worker_id=${input.workerId} ${errMsg(e)}`);
      if (!aborted) await send({ status: "failed", content: `server が worker を起こせなかった: ${errMsg(e)}` });
    } finally {
      tracker.close();
      onSettled?.();
    }
  };

  const send = async (body: CapMessage | CapReport): Promise<void> => {
    try {
      await deps.sendToCap(input.parentId, body);
      log(`cap へ返信: to=${input.parentId} worker_id=${input.workerId} ${"session-id" in body ? "message" : "report"} status=${body.status}`);
    } catch (e) {
      log(`cap へ返信できない: to=${input.parentId} worker_id=${input.workerId} ${errMsg(e)}`);
    }
  };

  return { kind, parentId: input.parentId, start, abort, cancelled: () => onSettled?.() };
}

/** state.json から reply の起こし直しの入力を作る。 */
export async function resumeInput(dir: string, prompt: string): Promise<WorkerRunInput | undefined> {
  const st = await readState(dir);
  if (st === undefined) return undefined;
  return { workerId: st.worker_id, dir, parentId: st.parent_id, ws: st.ws, ...(st.model !== undefined ? { model: st.model } : {}), mode: "resume", sessionId: st.session_id, prompt };
}
