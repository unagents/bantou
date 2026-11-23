import {
  PROTOCOL_VERSION,
  type RegisterChangeCommand,
  type ServerCommand,
  type ServerReply,
  type WorkerReplyCommand,
  type WorkerStopCommand,
} from "@agent-hand/bantou-protocol";
import type { ChangeRunner } from "./change-runner";
import type { NotifyTarget } from "./change-store";

/**
 * 新しい経路（change）の指示。登録（register_change）と、今の worker_reply / worker_stop のうち change_id を持つ物
 * （change の worker は cap を持たない）。cap_id を持つ worker_reply / worker_stop と remote-cap の経路の指示はここでは扱わない。
 */
export type ChangeCommand = RegisterChangeCommand | (WorkerReplyCommand & { change_id: string }) | (WorkerStopCommand & { change_id: string });

export function isChangeCommand(cmd: ServerCommand): cmd is ChangeCommand {
  return cmd.type === "register_change" || ((cmd.type === "worker_reply" || cmd.type === "worker_stop") && cmd.change_id !== undefined);
}

export interface ChangeCommandContext {
  runner: ChangeRunner;
  /** 指示を送ってきた center（通知先として覚える）。 */
  from: NotifyTarget;
}

/** 指示の概要（log 用）。本文（text）は先頭 80 文字だけ。 */
export function describeChangeCommand(cmd: ChangeCommand): string {
  switch (cmd.type) {
    case "register_change":
      return `change_id=${cmd.change_id} steps=${cmd.scope.length} repo=${cmd.repo.replace(/:\/\/[^/\s"@]*@/g, "://***@")}${cmd.branch ? ` branch=${cmd.branch}` : ""}`;
    case "worker_reply":
      return `change_id=${cmd.change_id} worker_id=${cmd.worker_id} text=${cmd.text.replace(/\s+/g, " ").trim().slice(0, 80)}`;
    case "worker_stop":
      return `change_id=${cmd.change_id} worker_id=${cmd.worker_id}`;
  }
}

/** 更新待機中・退役中など、受けずに断る時の error。 */
export function changeError(cmd: ChangeCommand, message: string, extra: { code?: "updating"; retryable?: boolean; retiring?: true } = {}): ServerReply {
  return {
    bantou: PROTOCOL_VERSION,
    type: "error",
    ok: false,
    message,
    command: cmd.type,
    change_id: cmd.change_id,
    ...(cmd.type !== "register_change" ? { worker_id: cmd.worker_id } : {}),
    ...extra,
  };
}

/** change の指示を実行して返信を作る。失敗は ErrorReply にする。 */
export async function executeChange(cmd: ChangeCommand, ctx: ChangeCommandContext): Promise<ServerReply> {
  const { runner } = ctx;
  try {
    switch (cmd.type) {
      case "register_change": {
        const r = await runner.register({
          change_id: cmd.change_id,
          scope: cmd.scope,
          repo: cmd.repo,
          ...(cmd.branch !== undefined ? { branch: cmd.branch } : {}),
          ...(cmd.worker_model !== undefined ? { worker_model: cmd.worker_model } : {}),
          notify_id: cmd.notify_id,
          notify_to: ctx.from,
        });
        // worker の完了は待たずにすぐ返す
        return { bantou: PROTOCOL_VERSION, type: "register_change_result", ok: true, change_id: cmd.change_id, accepted: true, state: r.state };
      }
      case "worker_reply": {
        await runner.reply(cmd.change_id, cmd.worker_id, cmd.text, ctx.from);
        return { bantou: PROTOCOL_VERSION, type: "worker_reply_result", ok: true, change_id: cmd.change_id, worker_id: cmd.worker_id, accepted: true };
      }
      case "worker_stop": {
        const r = await runner.stopWorker(cmd.change_id, cmd.worker_id, ctx.from);
        return { bantou: PROTOCOL_VERSION, type: "worker_stop_result", ok: true, change_id: cmd.change_id, worker_id: cmd.worker_id, stopped: r.stopped };
      }
    }
  } catch (e) {
    return changeError(cmd, e instanceof Error ? e.message : String(e));
  }
}
