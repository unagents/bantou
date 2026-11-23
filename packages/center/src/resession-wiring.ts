import type { Resessioner, ResessionDeps } from "./resession.js";
import type { SessionManager } from "./sessions.js";

/**
 * sessions と resession の配線（daemon.ts から出した物。挙動は変えない）。2 つは互いを参照するので、
 * sessions 側の onWake は resession を呼ばれる時に引く（getResession）。
 */
export function sessionWakeHooks(getResession: () => Pick<Resessioner, "armWake" | "disarmWake">): {
  onWake: (name: string, handoff: { id: string; stored: "memory" | "file" }) => void;
  onWakeAbort: (name: string) => void;
} {
  return {
    // 引継ぎつきの眠りを新しい会話で起こす時: 起動の前に引継ぎを最初の入力で渡す印を付ける（失敗したら外す）
    onWake: (name, handoff) => getResession().armWake(name, handoff),
    onWakeAbort: (name) => getResession().disarmWake(name),
  };
}

/** resession が sessions に頼む 4 つ（情報・リセッションの再起動・眠り・引継ぎを渡し終えた時の掃除）。 */
export function resessionSessionDeps(sessions: Pick<SessionManager, "list" | "restartFresh" | "sleep" | "clearSleepHandoff">): Pick<ResessionDeps, "info" | "restartFresh" | "sleepNow" | "afterWakeDelivered"> {
  return {
    info: (name) => sessions.list().find((x) => x.name === name),
    restartFresh: (name) => sessions.restartFresh(name),
    // スリープ: 引継ぎを受けた後に会話を止める（新しい会話は起動しない）。ref 無しは引継ぎの無い眠り
    sleepNow: (name, ref) => sessions.sleep(name, ref ? { handoff: ref } : undefined),
    afterWakeDelivered: (name, id) => sessions.clearSleepHandoff(name, id),
  };
}
