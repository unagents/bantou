import {
  PROTOCOL_VERSION,
  type ChangeReplyCommand,
  type RegisterChangeCommand,
  type ServerCommand,
  type ServerReply,
  type StopChangeCommand,
  type ChangeStatusCommand,
} from "@agent-hand/bantou-protocol";
import type { ChangeRunner } from "./change-runner";
import type { NotifyTarget } from "./change-store";

/** 新しい経路（change）の指示。remote-cap の経路の指示（task・worker_reply など）はここでは扱わない。 */
export type ChangeCommand = RegisterChangeCommand | ChangeStatusCommand | StopChangeCommand | ChangeReplyCommand;

export function isChangeCommand(cmd: ServerCommand): cmd is ChangeCommand {
  return cmd.type === "register_change" || cmd.type === "change_status" || cmd.type === "stop_change" || cmd.type === "change_reply";
}

/** 指示が指す change_id（change_status は省略がありうる）。 */
export function commandChangeId(cmd: ChangeCommand): string | undefined {
  return cmd.change_id;
}

export interface ChangeCommandContext {
  runner: ChangeRunner;
  /** 指示を送ってきた center（通知先として覚える）。 */
  from: NotifyTarget;
  /** change_status_result の board（queue の長さ・資源など）。 */
  board?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
}

/** 指示の概要（log 用）。本文（text）は先頭 80 文字だけ。 */
export function describeChangeCommand(cmd: ChangeCommand): string {
  switch (cmd.type) {
    case "register_change":
      return `change_id=${cmd.change_id} steps=${cmd.scope.length} repo=${cmd.repo.replace(/:\/\/[^/\s"@]*@/g, "://***@")}${cmd.branch ? ` branch=${cmd.branch}` : ""}`;
    case "change_status":
      return cmd.change_id ? `change_id=${cmd.change_id}` : "";
    case "stop_change":
      return `change_id=${cmd.change_id}`;
    case "change_reply":
      return `change_id=${cmd.change_id} worker_id=${cmd.worker_id} text=${cmd.text.replace(/\s+/g, " ").trim().slice(0, 80)}`;
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
    ...(cmd.change_id !== undefined ? { change_id: cmd.change_id } : {}),
    ...(cmd.type === "change_reply" ? { worker_id: cmd.worker_id } : {}),
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
      case "change_status": {
        const board = ctx.board ? await ctx.board() : undefined;
        return { bantou: PROTOCOL_VERSION, type: "change_status_result", ok: true, changes: runner.status(cmd.change_id), ...(board !== undefined ? { board } : {}) };
      }
      case "stop_change": {
        const r = await runner.stop(cmd.change_id, ctx.from);
        return { bantou: PROTOCOL_VERSION, type: "stop_change_result", ok: true, change_id: cmd.change_id, stopped: r.stopped };
      }
      case "change_reply": {
        await runner.reply(cmd.change_id, cmd.worker_id, cmd.text, ctx.from);
        return { bantou: PROTOCOL_VERSION, type: "change_reply_result", ok: true, change_id: cmd.change_id, worker_id: cmd.worker_id, accepted: true };
      }
    }
  } catch (e) {
    return changeError(cmd, e instanceof Error ? e.message : String(e));
  }
}
