import type {
  ChangeInfo,
  ChangeProgressNotice,
  ChangeReportNotice,
  ChangeState,
  StepState,
} from "@agent-hand/bantou-protocol";
import { judgeStep, type ChangeGate } from "./change-gate";
import type { Admission } from "./change-resources";
import type { ChangeRecord, ChangeStore, NotifyTarget, StepRecord } from "./change-store";

/**
 * change 単位の step 消化（設計書 2・3.4〜3.6）。
 * change の登録を受け、step を 1 つずつ worker に実行させる。順序は scope の並び（M1）、queue は来た順（M2）、
 * 起こす数は admission（M3）が決める。step の終わりは gate（openspec-mcp）で確かめ、通れば次の step、通らなければ同じ worker
 * （同じ session）を起こし直して続きをやらせる（決定 19。回数は数えない）。
 * center に知らせるのは 3 つだけ: worker の質問（change_report）、止められた・範囲を終えた（change_progress）。
 * remote-cap の経路（task・worker_start・予約）には触れない。
 */

export type ChangeNotice = ChangeReportNotice | ChangeProgressNotice;

/** worker を 1 回起こす（run の終わりまで待つ）。daemon が manager.invoke("worker", …) につなぐ。 */
export interface LaunchRequest {
  change_id: string;
  /** change の steps の中の位置。 */
  step: number;
  worker_id: string;
  prompt: string;
  repo: string;
  branch?: string;
  model?: string;
}

export interface LaunchResult {
  ok: boolean;
  session_id?: string;
  error?: string;
}

export interface ChangeRunnerDeps {
  store: ChangeStore;
  gate: ChangeGate;
  admission: Admission;
  /** worker を起こす。起こす所（manager への登録）は同期で済ませ、run の終わりを待つ Promise を返す。 */
  launch: (req: LaunchRequest) => Promise<LaunchResult>;
  /** 動いている worker を止める（process group kill）。止められなければ投げる。 */
  stopWorker: (workerId: string) => Promise<{ stopped: boolean }>;
  /** center へ知らせる。送れなくても runner は止まらない。 */
  notify: (to: { notify_id: string; target?: NotifyTarget }, notice: ChangeNotice) => Promise<void>;
  log: (msg: string) => void;
  now?: () => number;
}

export interface RegisterInput {
  change_id: string;
  scope: string[];
  repo: string;
  branch?: string;
  worker_model?: string;
  notify_id: string;
  notify_to?: NotifyTarget;
}

export interface ChangeRunner {
  register(input: RegisterInput): Promise<{ state: ChangeState }>;
  status(changeId?: string): ChangeInfo[];
  stop(changeId: string, notifyTo?: NotifyTarget): Promise<{ stopped: boolean }>;
  reply(changeId: string, workerId: string, text: string, notifyTo?: NotifyTarget): Promise<void>;
  /** worker の report（change の worker が /mcp の report を呼んだ）。ask / approve は質問として center へ知らせる。 */
  reported(changeId: string, workerId: string, kind: "progress" | "ask" | "approve" | "done", text: string): Promise<void>;
  /** 記録を読み直し、中断していた step を続ける（server 起動時）。 */
  load(): Promise<number>;
  /** 起こせる物を起こす（資源が空いたかもしれない時に呼ぶ）。 */
  pump(): void;
  /** queue の長さ・動いている worker の数・返答待ちの step の数。 */
  counts(): { queued: number; running: number; waiting_reply: number };
  /** これ以上、起こさず・記録を変えない（server の停止・退役。中断された run は次の load で続きになる）。 */
  close(): void;
  /** 終わった run の後始末（確かめ・次の起動・記録の書き込み）が全部済むのを待つ（動いている worker は待たない。test・終了用）。 */
  idle(): Promise<void>;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 仮の扱い（利用者の決定待ち）の印。worker の異常終了で change を止める時の理由に付ける。 */
export const ABNORMAL_EXIT_NOTE = "仮の扱い。利用者の決定待ち";

/** step の最初の指示文: change の名前と step の参照だけ渡す最小の形。 */
export function buildStepPrompt(changeId: string, ref: string): string {
  return [`change: ${changeId}`, `step: ${ref}`, "この step の範囲だけを行う。"].join("\n");
}

/** 確かめに通らなかった時の続きの指示文。通らなかった中身を渡す（決定 19）。 */
export function buildRetryPrompt(changeId: string, ref: string, reason: string): string {
  return ["[step の終わりの確かめに通らなかった]", `change: ${changeId}`, `step: ${ref}`, `通らなかった中身: ${reason}`, "続きを行う。"].join("\n");
}

/** server の再起動で中断した step の続きの指示文。 */
export function buildRestartPrompt(changeId: string, ref: string): string {
  return ["[server の再起動で中断した]", `change: ${changeId}`, `step: ${ref}`, "続きを行う。"].join("\n");
}

const TERMINAL_STEP: readonly StepState[] = ["passed", "stopped"];

export function createChangeRunner(deps: ChangeRunnerDeps): ChangeRunner {
  const { store, gate, log } = deps;
  const now = deps.now ?? Date.now;
  const changes = new Map<string, ChangeRecord>();
  let seq = 0;
  let inflight = 0;
  let closing = false;
  /** stop_change の最中の change（止める間に終わった run を異常終了と見ない）。 */
  const stopping = new Set<string>();
  const ops = new Set<Promise<unknown>>();

  const track = <T>(p: Promise<T>): Promise<T> => {
    ops.add(p);
    const done = (): void => void ops.delete(p);
    p.then(done, done);
    return p;
  };

  const touch = (rec: ChangeRecord): void => {
    rec.updated_at = new Date(now()).toISOString();
    void store.save(rec);
  };

  const send = (rec: ChangeRecord, notice: ChangeNotice): void => {
    void deps
      .notify({ notify_id: rec.notify_id, ...(rec.notify_to ? { target: rec.notify_to } : {}) }, notice)
      .catch((e: unknown) => log(`center へ知らせられない: change_id=${rec.change_id} type=${notice.type} ${errMsg(e)}`));
  };

  /** 現在の step の位置: 最後に登録した scope の中で、まだ通っていない最初の step。全部通っていれば最後。 */
  function currentStep(rec: ChangeRecord): number {
    for (let i = rec.scope_start; i < rec.steps.length; i++) if (rec.steps[i]!.state !== "passed") return i;
    return Math.max(0, rec.steps.length - 1);
  }

  function progressNotice(rec: ChangeRecord, reason?: string): ChangeProgressNotice {
    const i = currentStep(rec);
    return {
      bantou: 1,
      type: "change_progress",
      notify_id: rec.notify_id,
      change_id: rec.change_id,
      step: i,
      change_state: rec.state,
      step_state: rec.steps[i]?.state ?? "passed",
      at: new Date(now()).toISOString(),
      ...(reason !== undefined ? { reason } : {}),
    };
  }

  function enqueue(rec: ChangeRecord, step: StepRecord, prompt: string): void {
    step.state = "queued";
    step.prompt = prompt;
    step.queued_seq = ++seq;
  }

  /** change を止める（stop_change・異常終了の共通）。動いている worker の停止は呼ぶ側が済ませてある。 */
  function markStopped(rec: ChangeRecord, reason: string): void {
    rec.state = "stopped";
    rec.reason = reason;
    for (const s of rec.steps) {
      if (!TERMINAL_STEP.includes(s.state)) {
        s.state = "stopped";
        delete s.prompt;
        delete s.queued_seq;
      }
    }
    touch(rec);
    send(rec, progressNotice(rec, reason));
  }

  /**
   * worker が異常終了した時の扱い。仮の扱い（利用者の決定待ち）: その change を止めて center に知らせる。起こし直しは繰り返さない。
   */
  function abnormal(rec: ChangeRecord, what: string): void {
    log(`worker の異常終了で change を止める（${ABNORMAL_EXIT_NOTE}）: change_id=${rec.change_id} ${what}`);
    markStopped(rec, `${what}（${ABNORMAL_EXIT_NOTE}）`);
  }

  function pickQueued(): { rec: ChangeRecord; index: number } | undefined {
    let best: { rec: ChangeRecord; index: number; seq: number } | undefined;
    for (const rec of changes.values()) {
      if (rec.state !== "in_progress") continue;
      rec.steps.forEach((s, index) => {
        if (s.state === "queued" && (best === undefined || (s.queued_seq ?? 0) < best.seq)) best = { rec, index, seq: s.queued_seq ?? 0 };
      });
    }
    return best;
  }

  function pump(): void {
    if (closing) return;
    for (;;) {
      const next = pickQueued();
      if (!next) return;
      if (!deps.admission.canStart(inflight)) return;
      startStep(next.rec, next.index);
    }
  }

  function startStep(rec: ChangeRecord, index: number): void {
    const step = rec.steps[index]!;
    const prompt = step.prompt ?? buildStepPrompt(rec.change_id, step.ref);
    step.state = "running";
    step.launches++;
    step.worker_id ??= `${rec.change_id}-s${index}`;
    delete step.prompt;
    delete step.queued_seq;
    touch(rec);
    const token = step.launches;
    const req: LaunchRequest = {
      change_id: rec.change_id,
      step: index,
      worker_id: step.worker_id,
      prompt,
      repo: rec.repo,
      ...(rec.branch !== undefined ? { branch: rec.branch } : {}),
      ...(rec.worker_model !== undefined ? { model: rec.worker_model } : {}),
    };
    log(`step を起こす: change_id=${rec.change_id} step=${index} worker_id=${req.worker_id} 動いている=${inflight + 1}`);
    inflight++;
    let launched: Promise<LaunchResult>;
    try {
      launched = deps.launch(req);
    } catch (e) {
      launched = Promise.reject(e);
    }
    // run の終わりの後始末（確かめ・次の起動）だけを追う。run そのものは追わない（idle は動いている worker を待たない）
    void launched
      .then(
        (r) => r,
        (e: unknown): LaunchResult => ({ ok: false, error: errMsg(e) }),
      )
      .then((r) => {
        inflight--;
        void track(
          onRunEnd(rec.change_id, index, token, r).then(() => pump()),
        );
      });
  }

  async function onRunEnd(changeId: string, index: number, token: number, r: LaunchResult): Promise<void> {
    // 止めている最中・server の停止中は、記録を変えない（停止中に中断された run は、次の起動で続きになる）
    if (closing || stopping.has(changeId)) return;
    const rec = changes.get(changeId);
    const step = rec?.steps[index];
    if (!rec || !step || rec.state !== "in_progress") return;
    // 質問の後に起こし直した等で、新しい起動がある（この終わりは古い起動の物）
    if (step.launches !== token) return;
    if (r.session_id !== undefined) step.session_id = r.session_id;
    if (step.state === "waiting_reply") {
      // 質問を出して session を閉じた。返答（change_reply）を待つ
      touch(rec);
      return;
    }
    if (!r.ok) {
      abnormal(rec, `worker が異常終了した（step=${index} worker_id=${step.worker_id ?? "-"} ${r.error ?? "失敗"}）`);
      return;
    }
    await check(rec, index, token);
  }

  /** step の終わりを確かめ、通れば次の step、通らなければ同じ worker を続きで起こし直す。 */
  async function check(rec: ChangeRecord, index: number, token: number): Promise<void> {
    const step = rec.steps[index]!;
    step.state = "checking";
    touch(rec);
    let verdict;
    try {
      verdict = judgeStep(await gate.status(rec.change_id, step.ref));
    } catch (e) {
      // 確かめを実行できない（openspec-mcp に聞けない）。同じ事を繰り返さず止める。仮の扱い
      if (closing || stopping.has(rec.change_id) || rec.state !== "in_progress" || step.launches !== token) return;
      abnormal(rec, `step の終わりを確かめられない（step=${index} ${errMsg(e)}）`);
      return;
    }
    // 確かめている間に止められた・server が止まった
    if (closing || stopping.has(rec.change_id) || rec.state !== "in_progress" || step.launches !== token || step.state !== "checking") return;
    if (!verdict.passed) {
      // 通らなかった: 同じ worker（同じ session）に、通らなかった中身を渡して続きをやらせる。center には知らせない
      enqueue(rec, step, buildRetryPrompt(rec.change_id, step.ref, verdict.reason ?? "不明"));
      touch(rec);
      log(`確かめに通らない（続きを起こす）: change_id=${rec.change_id} step=${index} ${verdict.reason ?? ""}`);
      return;
    }
    step.state = "passed";
    const next = rec.steps[index + 1];
    if (next && next.state === "pending") {
      enqueue(rec, next, buildStepPrompt(rec.change_id, next.ref));
      touch(rec);
      return;
    }
    rec.state = "completed";
    touch(rec);
    send(rec, progressNotice(rec));
  }

  async function register(input: RegisterInput): Promise<{ state: ChangeState }> {
    const why = gate.unavailable();
    if (why !== undefined) throw new Error(`change を受けられない: ${why}`);
    if (closing) throw new Error("server が止まる所のため受け付けられない");
    let rec = changes.get(input.change_id);
    if (rec && rec.state === "in_progress") {
      throw new Error(`change は進行中（再登録は completed / stopped の change だけ）: ${input.change_id}`);
    }
    const start = rec ? rec.steps.length : 0;
    if (!rec) {
      rec = {
        change_id: input.change_id,
        state: "in_progress",
        repo: input.repo,
        notify_id: input.notify_id,
        scope_start: 0,
        steps: [],
        updated_at: "",
      };
      changes.set(rec.change_id, rec);
    }
    // 再登録: 渡された値を使う（無ければ記録の値のまま）。step の記録は足し続け、前の scope の step は変えない
    rec.state = "in_progress";
    delete rec.reason;
    rec.repo = input.repo;
    if (input.branch !== undefined) rec.branch = input.branch;
    if (input.worker_model !== undefined) rec.worker_model = input.worker_model;
    rec.notify_id = input.notify_id;
    if (input.notify_to) rec.notify_to = input.notify_to;
    rec.scope_start = start;
    for (const ref of input.scope) rec.steps.push({ ref, state: "pending", launches: 0 });
    // 先頭の step を queue に積み、残りは前の step が通るのを待つ
    enqueue(rec, rec.steps[start]!, buildStepPrompt(rec.change_id, rec.steps[start]!.ref));
    touch(rec);
    log(`change を登録: change_id=${rec.change_id} steps=${input.scope.length} 位置=${start}`);
    pump();
    return { state: rec.state };
  }

  const need = (changeId: string): ChangeRecord => {
    const rec = changes.get(changeId);
    if (!rec) throw new Error(`change が無い: ${changeId}`);
    return rec;
  };

  function toInfo(rec: ChangeRecord): ChangeInfo {
    return {
      change_id: rec.change_id,
      state: rec.state,
      step: currentStep(rec),
      steps: rec.steps.map((s) => ({
        ref: s.ref,
        ...(s.worker_id !== undefined ? { worker_id: s.worker_id } : {}),
        ...(s.session_id !== undefined ? { session_id: s.session_id } : {}),
        state: s.state,
      })),
      ...(rec.reason !== undefined ? { reason: rec.reason } : {}),
      updated_at: rec.updated_at,
    };
  }

  function status(changeId?: string): ChangeInfo[] {
    if (changeId !== undefined) return [toInfo(need(changeId))];
    return [...changes.values()].sort((a, b) => (a.change_id < b.change_id ? -1 : 1)).map(toInfo);
  }

  async function stop(changeId: string, notifyTo?: NotifyTarget): Promise<{ stopped: boolean }> {
    const rec = need(changeId);
    if (notifyTo) rec.notify_to = notifyTo;
    if (rec.state !== "in_progress") return { stopped: false };
    stopping.add(changeId);
    try {
      let any = false;
      for (const s of rec.steps) {
        if (s.state === "running" && s.worker_id !== undefined) {
          // 止められなければ投げる（change の状態は変えない）
          const r = await deps.stopWorker(s.worker_id).catch((e: unknown) => {
            throw new Error(`動いている worker を止められなかった: worker_id=${s.worker_id} ${errMsg(e)}`);
          });
          any = any || r.stopped;
        }
      }
      if (rec.state !== "in_progress") return { stopped: any };
      markStopped(rec, "stop_change");
      return { stopped: true };
    } finally {
      stopping.delete(changeId);
    }
  }

  async function reply(changeId: string, workerId: string, text: string, notifyTo?: NotifyTarget): Promise<void> {
    const rec = need(changeId);
    const step = rec.steps.find((s) => s.worker_id === workerId);
    if (!step) throw new Error(`change の step の worker でない: change_id=${changeId} worker_id=${workerId}`);
    if (step.state !== "waiting_reply") throw new Error(`返答待ちではない（step の状態: ${step.state}）: worker_id=${workerId}`);
    if (notifyTo) rec.notify_to = notifyTo;
    // 同じ session で起こし直す依頼を queue に積む（起こすのも queue と資源の判定を通る）
    enqueue(rec, step, text);
    touch(rec);
    pump();
  }

  async function reported(changeId: string, workerId: string, kind: "progress" | "ask" | "approve" | "done", text: string): Promise<void> {
    const rec = need(changeId);
    const index = rec.steps.findIndex((s) => s.worker_id === workerId);
    const step = rec.steps[index];
    if (!step) throw new Error(`change の step の worker でない: change_id=${changeId} worker_id=${workerId}`);
    step.last_report = { kind, at: new Date(now()).toISOString() };
    if (kind === "progress" || kind === "done") {
      // 知らせない。記録に残すだけ
      touch(rec);
      return;
    }
    if (rec.state !== "in_progress" || step.state !== "running") throw new Error(`質問を受けられない（change=${rec.state} step=${step.state}）`);
    // 同期で状態を変える（run の終わりより先に、返答待ちが見える）
    step.state = "waiting_reply";
    touch(rec);
    send(rec, {
      bantou: 1,
      type: "change_report",
      notify_id: rec.notify_id,
      change_id: rec.change_id,
      worker_id: workerId,
      step: index,
      kind,
      text,
      at: new Date(now()).toISOString(),
    });
  }

  async function load(): Promise<number> {
    const recs = await store.loadAll();
    for (const rec of recs) {
      changes.set(rec.change_id, rec);
      for (const s of rec.steps) if (s.queued_seq !== undefined && s.queued_seq > seq) seq = s.queued_seq;
    }
    // 中断した step は、queue で待っていた物より先に（もともと先に起きていたので）続きを起こす
    let queuedMin = Infinity;
    let interrupted = 0;
    for (const rec of recs) {
      if (rec.state !== "in_progress") continue;
      for (const s of rec.steps) {
        if (s.state === "queued") queuedMin = Math.min(queuedMin, s.queued_seq ?? 0);
        if (s.state === "running") interrupted++;
      }
    }
    let nextLow = (Number.isFinite(queuedMin) ? queuedMin : seq + 1) - interrupted;
    for (const rec of recs) {
      if (rec.state !== "in_progress") continue;
      rec.steps.forEach((s, index) => {
        if (s.state === "running") {
          // server の再起動で中断した（worker の異常終了ではない）。同じ session で続きを起こす
          enqueue(rec, s, buildRestartPrompt(rec.change_id, s.ref));
          s.queued_seq = nextLow++;
          touch(rec);
        } else if (s.state === "checking") {
          void track(check(rec, index, s.launches));
        }
      });
    }
    pump();
    return recs.length;
  }

  return {
    register,
    status,
    stop,
    reply,
    reported,
    load,
    pump,
    counts() {
      let queued = 0;
      let waiting = 0;
      for (const rec of changes.values()) {
        if (rec.state !== "in_progress") continue;
        for (const s of rec.steps) {
          if (s.state === "queued") queued++;
          else if (s.state === "waiting_reply") waiting++;
        }
      }
      return { queued, running: inflight, waiting_reply: waiting };
    },
    close() {
      closing = true;
    },
    async idle() {
      while (ops.size > 0) await Promise.allSettled([...ops]);
      await store.flush();
    },
  };
}
