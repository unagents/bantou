import {
  PROTOCOL_VERSION,
  type ErrorReply,
  type ServerReply,
  type SpawnWorkerCommand,
  type WorkerReportCommand,
} from "@agent-hand/bantou-protocol";
import type { AgentManager } from "./agents";
import { OWNER_FILE, readOwner, readReplyTo } from "./links";
import { agentDir } from "./paths";

export interface FlowDeps {
  manager: AgentManager;
  workspace: string;
  log: (msg: string) => void;
  /** peer へ reply を送る。失敗は呼び出し側（daemon）がログする。 */
  send: (peerId: string, reply: ServerReply) => Promise<void>;
  /** 終了処理中か。true の間は cap を再開しない。 */
  isClosing: () => boolean;
  /** 実行中の背景処理を登録する（終了時に待つため）。 */
  track: (p: Promise<void>) => void;
}

export interface Flow {
  /** cap の spawn_worker。worker は背景で走る。返信は無い（失敗は cap の resume prompt で伝える）。 */
  spawnWorker(cmd: SpawnWorkerCommand): void;
  /** worker の worker_report。cap を背景で resume する。起動できない時だけ ErrorReply を返す。 */
  workerReport(cmd: WorkerReportCommand): Promise<ErrorReply | undefined>;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** cap を resume する時の prompt（worker_report 分）。 */
export function reportPrompt(cmd: WorkerReportCommand): string {
  const tail =
    cmd.kind === "ask"
      ? "The worker is waiting for your decision. Answer it with resume_worker."
      : "The worker is done. Continue your task, or finish if nothing is left.";
  return `[bantou-server] worker_report from worker "${cmd.worker_id}" (kind=${cmd.kind}):\n\n${cmd.text}\n\n${tail}`;
}

/** cap を resume する時の prompt（worker の実行失敗分）。 */
export function workerFailurePrompt(workerId: string, detail: string): string {
  return `[bantou-server] worker "${workerId}" could not run to the end: ${detail}\n\nDecide what to do (spawn_worker or resume_worker again, or give up).`;
}

export function createFlow(deps: FlowDeps): Flow {
  const { manager, workspace, log, send } = deps;

  /** cap を resume し、終わったら kick_cap の送り主へ cap_result を送る。 */
  function resumeCap(capId: string, prompt: string): void {
    if (deps.isClosing()) {
      log(`終了中のため cap を再開しない: cap_id=${capId}`);
      return;
    }
    const p = (async () => {
      let outcome;
      try {
        outcome = await manager.invoke("cap", capId, { prompt });
      } catch (e) {
        log(`cap 再開失敗: cap_id=${capId} ${errMsg(e)}`);
        return;
      }
      try {
        const to = await readReplyTo(agentDir(workspace, "cap", capId));
        if (!to) {
          log(`cap_result の送り先なし: cap_id=${capId}`);
          return;
        }
        await send(to.id, { bantou: PROTOCOL_VERSION, type: "cap_result", cap_id: capId, ...outcome });
      } catch (e) {
        log(`cap_result 送信失敗: cap_id=${capId} ${errMsg(e)}`);
      }
    })();
    deps.track(p);
  }

  return {
    spawnWorker(cmd) {
      const { worker_id: workerId, cap_id: capId } = cmd;
      const p = (async () => {
        try {
          const r = await manager.invoke("worker", workerId, {
            prompt: cmd.prompt,
            ...(cmd.repo !== undefined ? { repo: cmd.repo } : {}),
            ...(cmd.branch !== undefined ? { branch: cmd.branch } : {}),
            sidecar: { name: OWNER_FILE, data: { cap_id: capId } },
          });
          if (!r.ok) resumeCap(capId, workerFailurePrompt(workerId, r.error ?? "unknown error"));
        } catch (e) {
          log(`worker 起動失敗: worker_id=${workerId} ${errMsg(e)}`);
          resumeCap(capId, workerFailurePrompt(workerId, errMsg(e)));
        }
      })();
      deps.track(p);
    },

    async workerReport(cmd) {
      const fail = (message: string): ErrorReply => ({
        bantou: PROTOCOL_VERSION,
        type: "error",
        ok: false,
        message,
        command: "worker_report",
        worker_id: cmd.worker_id,
      });
      let capId: string | null;
      try {
        capId = await readOwner(agentDir(workspace, "worker", cmd.worker_id));
      } catch (e) {
        log(`エラー: worker_report: ${errMsg(e)}`);
        return fail(errMsg(e));
      }
      if (capId === null) {
        const message = `worker ${cmd.worker_id} の所有 cap が不明（spawn_worker 経由でない）`;
        log(`エラー: worker_report: ${message}`);
        return fail(message);
      }
      resumeCap(capId, reportPrompt(cmd));
      return undefined;
    },
  };
}
