/**
 * app 再起動後の状況確認。設計は docs/design/app-restart-check.md。
 *
 * center が `restore()` で起動し直した session に印を付け（arm）、その session の最初の `SessionStart`（startup / resume）の後に、
 * 最初の入力で「app が再起動した事」を知らせて状況の確認を促す。印は center の process 内だけに持つ（再起動をまたいで残さない）。
 * 1 回だけ: 送る前に印を消す。入力が届かなくても再送しない（U8 の A）。リセッション待ちの session には送らない（2.3）。
 */
import { submitFirstInput } from "./first-input.js";
import type { Logger } from "./log.js";

/** 最初の入力の本文（1 行。改行を含めない。2.5）。 */
export const RESTART_CHECK_TEXT =
  "[bantou] app が再起動した（center が起動し直した。会話の続きとは限らない）。状況を一度確かめる。1) system 指示の [始める時] の順に記録を読む。2) remote_list と task_status で remote・task の状態を見る。3) 未読の知らせ（messenger）を読む。止まっている物・届いた結果があれば続きを進める。無ければ短く状態を報告して待つ。";

export interface RestartChecker {
  /** 起動し直す直前に印を付ける（`restore()` から）。 */
  arm(session: string): void;
  /** 印を外す（起動に失敗した・眠った・消えた・リセッションで再起動した時）。印が無ければ何もしない。 */
  cancel(session: string): void;
  /** hook の payload を見る（SessionStart で最初の入力）。同期で戻り、投げない。 */
  onHook(session: string, payload: unknown): void;
  /** 確認待ち（印がある）か。 */
  pending(session: string): boolean;
}

export interface RestartCheckDeps {
  core: { input: (name: string, data: Buffer) => boolean };
  /** リセッション待ちか（`resession.pending`）。true なら確認は送らない。 */
  resessionPending: (session: string) => boolean;
  log: Logger;
  /** 本文を送ってから Enter を送るまでの間（ms）。既定 400（リセッションと同じ）。 */
  submitDelayMs?: number;
}

export function createRestartChecker(deps: RestartCheckDeps): RestartChecker {
  const { log, core } = deps;
  const submitDelayMs = deps.submitDelayMs ?? 400;
  const marks = new Map<string, { since: number }>();

  const deliver = async (session: string): Promise<void> => {
    // 1 回だけ: 先に印を消す
    marks.delete(session);
    if (deps.resessionPending(session)) {
      log(`app 再起動の確認を見送り（リセッション待ち）: session=${session}`);
      return;
    }
    try {
      await submitFirstInput(core, session, RESTART_CHECK_TEXT, submitDelayMs);
      log(`app 再起動の確認の最初の入力を送った: session=${session}`);
    } catch (e) {
      log(`app 再起動の確認の最初の入力を送れない: session=${session} ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return {
    arm(session) {
      marks.set(session, { since: Date.now() });
    },
    cancel(session) {
      marks.delete(session);
    },
    onHook(session, payload) {
      try {
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
        const p = payload as Record<string, unknown>;
        if (p.hook_event_name !== "SessionStart" || !marks.has(session)) return;
        if (p.source !== "startup" && p.source !== "resume") return;
        void deliver(session).catch((e) => log(`app 再起動の確認で例外: session=${session} ${e instanceof Error ? e.message : String(e)}`));
      } catch (e) {
        log(`app 再起動の確認の hook 処理で例外: session=${session} ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    pending: (session) => marks.has(session),
  };
}

/**
 * 印を付けたまま止まった・眠った・消えた・リセッションで起動し直した session の印を外す（U2 の A）。`events`（EventHub）の通知を見る。戻り値は購読の解除。
 * `sleep` は眠った時と起きた時の両方で流れるが、起きた時は印が無いので何も起きない（`wake` は印を付けない）。
 */
export function cancelOnSessionEvents(events: { subscribe: (l: (ev: { reason: string; name: string }) => void) => () => void }, checker: Pick<RestartChecker, "cancel">): () => void {
  return events.subscribe((ev) => {
    if (ev.reason === "sleep" || ev.reason === "deleted" || ev.reason === "restarted") checker.cancel(ev.name);
  });
}
