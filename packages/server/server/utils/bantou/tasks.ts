import type { CapTaskInfo, RunOutcome, TaskCommand } from "@agent-hand/bantou-protocol";
import { STOP_MSG } from "./agents";

/**
 * cap の task の待ち行列と並行の管理。
 *
 * task ごとに、その task だけを受け持つ指揮の会話（lane。agents.ts の InvokeInput.taskId）を立てて動かす。
 * 1 つの cap で同時に動く task は maxParallel まで。超えた分と、先に来て終わっていない task と同じ
 * deliverables.branch の task は、来た順に待たせる（同じ branch への同時の push を避ける）。branch の指定が無い task は上限の内で並行に動く。
 *
 * task が「動いている」間 = 指揮の run・その task の worker の run・report 起因の処理（再開と返信の送信）のどれかが残っている間、
 * または最初の指揮の run の返信（task_result）をまだ送り終えていない間。全部が無くなったら終わり（done / failed）にして、待っている task を始める。
 */

export type TaskLaneState = CapTaskInfo["state"];

export interface TaskSchedulerDeps {
  /** 1 つの cap で同時に動かす task の上限（config.session.maxParallelTasks。1 以上）。 */
  maxParallel: number;
  /** task の最初の指揮の run を始める（manager.invoke("cap", cap_id, { taskId })）。manager には同期で載せること。 */
  run: (cmd: TaskCommand) => Promise<RunOutcome>;
  /** その task に、run（指揮・worker。待ちを含む）か report 起因の処理が残っているか。 */
  busy: (capId: string, taskId: string) => boolean;
  /** cap の task の状態が変わった（activity を送る）。 */
  changed?: (capId: string) => void;
  /** task の branch を lane の dir に残す（server の再起動の後、lane が再開された時に引き継ぐ）。 */
  saveMeta?: (capId: string, taskId: string, meta: { branch?: string; queued_at: string }) => Promise<void>;
  loadMeta?: (capId: string, taskId: string) => Promise<{ branch?: string } | undefined>;
  log: (msg: string) => void;
  now?: () => number;
  /** 終わった task を tasks に残す時間（ms。既定 1 時間）と、cap ごとの件数（既定 20）。 */
  retainMs?: number;
  retainMax?: number;
  /** 終わりの判定を遅らせて 1 回にまとめる（既定 setImmediate。テストで差し替える）。 */
  defer?: (f: () => void) => void;
}

/** 更新待ち（server の更新）が数える、task の待ち・返信の送信中。 */
export interface TaskWaitRun {
  capId: string;
  taskId: string;
  /** queued = まだ始まっていない / preparing = 最初の指揮の run が終わり、返信を送っている途中。 */
  phase: "queued" | "preparing";
  /** ISO 8601。queued は受けた時刻、preparing は始めた時刻。 */
  since: string;
}

export interface TaskScheduler {
  /**
   * task を受ける。始められれば同期で始め、無理なら待たせる。最初の指揮の run が終わったら、その結果で解ける（失敗は投げる）。
   * deferReply = true なら、replied を呼ぶまで task を終わりにしない（呼び出し側が返信を送り終えてから呼ぶ）。
   */
  submit(cmd: TaskCommand, opts?: { deferReply?: boolean }): Promise<RunOutcome>;
  /** submit の返信を送り終えた（deferReply の時）。 */
  replied(capId: string, taskId: string): void;
  /** その task の run が manager に載った（report 起因の再開・worker の再開・再起動後の引き継ぎ）。終わった task は動いている扱いに戻す。 */
  touch(capId: string, taskId: string): void;
  /** その task の指揮の run が終わった（最後の結果で done / failed を決める）。 */
  noteOutcome(capId: string, taskId: string, result: { outcome?: RunOutcome; error?: string }): void;
  /** その task を失敗で終える印（worker の終了による再開の上限を超えた）。次に再開されたら外れる。 */
  fail(capId: string, taskId: string, message: string): void;
  /** 終わりの判定と、待っている task の開始をやり直す（run が終わった時など）。 */
  check(): void;
  /** stop_cap: その cap の待っている task を止め（失敗で返す）、close が終わるまでその cap の task を始めない。 */
  stopCap<T>(capId: string, close: () => Promise<T>): Promise<{ result: T; dropped: number }>;
  /** cap の task（待ち・実行中・最近終わったもの）を来た順に。 */
  snapshot(capId: string): CapTaskInfo[];
  /** 待っている task の数（capId を渡せばその cap だけ）。 */
  waitingCount(capId?: string): number;
  /** 更新待ちが数える、manager に載っていない task（待ち・返信の送信中）。 */
  waitRuns(): TaskWaitRun[];
  /** その task が待ちか実行中か。 */
  isActive(capId: string, taskId: string): boolean;
  /** その cap に待ちか実行中の task があるか。 */
  has(capId: string): boolean;
  /** 以降の task を断り、待っている task を message で失敗にする（server の終了・退役）。 */
  close(message: string): void;
}

interface Entry {
  capId: string;
  taskId: string;
  seq: number;
  branch?: string;
  cmd?: TaskCommand;
  state: TaskLaneState;
  waitingFor?: "limit" | "branch";
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error?: string;
  /** 最後の指揮の run の結果（このサーバの起動後に run が無ければ undefined）。 */
  lastOk?: boolean;
  lastError?: string;
  /** fail で付けた失敗の理由。 */
  forcedError?: string;
  /** 最初の返信を送り終えたか（deferReply でなければ run の終わりで true）。 */
  replied: boolean;
  deferReply: boolean;
  settle?: { resolve: (o: RunOutcome) => void; reject: (e: unknown) => void };
}

export const TASK_RETAIN_MS = 3_600_000;
export const TASK_RETAIN_MAX = 20;
const ERROR_MAX = 200;

const oneLine = (s: string, n: number): string => s.replace(/\s+/g, " ").trim().slice(0, n);
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createTaskScheduler(deps: TaskSchedulerDeps): TaskScheduler {
  const { log } = deps;
  const now = deps.now ?? Date.now;
  const retainMs = deps.retainMs ?? TASK_RETAIN_MS;
  const retainMax = deps.retainMax ?? TASK_RETAIN_MAX;
  const defer = deps.defer ?? ((f: () => void) => void setImmediate(f));
  const maxParallel = Math.max(1, Math.floor(deps.maxParallel));
  const entries = new Map<string, Entry>();
  /** stop_cap の close の最中の cap（その間は task を始めない）。 */
  const closing = new Map<string, number>();
  let seq = 0;
  let closed = false;
  let checkScheduled = false;

  const keyOf = (capId: string, taskId: string): string => `${capId}/${taskId}`;
  const iso = (): string => new Date(now()).toISOString();
  const changed = (capId: string): void => {
    if (!deps.changed) return;
    try {
      deps.changed(capId);
    } catch (e) {
      log(`task の変化の通知に失敗: cap_id=${capId} ${errMsg(e)}`);
    }
  };
  const ofCap = (capId: string): Entry[] => [...entries.values()].filter((e) => e.capId === capId);
  const isLive = (e: Entry): boolean => e.state === "waiting" || e.state === "running";

  /** 待たせる理由。始められるなら undefined。 */
  function blockedBy(e: Entry): "limit" | "branch" | "closing" | undefined {
    if (closing.has(e.capId)) return "closing";
    const mine = ofCap(e.capId);
    if (
      e.branch !== undefined &&
      mine.some((x) => x !== e && x.branch === e.branch && (x.state === "running" || (x.state === "waiting" && x.seq < e.seq)))
    ) {
      return "branch";
    }
    if (mine.filter((x) => x.state === "running").length >= maxParallel) return "limit";
    return undefined;
  }

  function start(e: Entry): void {
    e.state = "running";
    e.startedAt = iso();
    delete e.waitingFor;
    const cmd = e.cmd!;
    log(`task 開始: cap_id=${e.capId} task_id=${e.taskId}${e.branch !== undefined ? ` branch=${e.branch}` : ""} 同時=${ofCap(e.capId).filter((x) => x.state === "running").length}/${maxParallel}`);
    changed(e.capId);
    let p: Promise<RunOutcome>;
    try {
      p = deps.run(cmd);
    } catch (err) {
      p = Promise.reject(err);
    }
    p.then(
      (o) => {
        e.lastOk = o.ok;
        if (o.ok) delete e.lastError;
        else e.lastError = o.error ?? "指揮の実行に失敗";
        e.settle?.resolve(o);
      },
      (err: unknown) => {
        e.lastOk = false;
        e.lastError = errMsg(err);
        e.settle?.reject(err);
      },
    ).finally(() => {
      delete e.settle;
      if (!e.deferReply) e.replied = true;
      check();
    });
  }

  /** 待っている task を来た順に見て、始められるものを始める。 */
  function pump(): void {
    if (closed) return;
    const waiting = [...entries.values()].filter((e) => e.state === "waiting").sort((a, b) => a.seq - b.seq);
    for (const e of waiting) {
      const why = blockedBy(e);
      if (why === undefined) {
        start(e);
        continue;
      }
      const w = why === "closing" ? (e.waitingFor ?? "limit") : why;
      if (e.waitingFor !== w) {
        e.waitingFor = w;
        changed(e.capId);
      }
    }
  }

  function finish(e: Entry): void {
    const error = e.forcedError ?? (e.lastOk === false ? (e.lastError ?? "指揮の実行に失敗") : undefined);
    e.state = error !== undefined ? "failed" : "done";
    if (error !== undefined) e.error = oneLine(error, ERROR_MAX);
    else delete e.error;
    e.finishedAt = iso();
    log(`task 終了: cap_id=${e.capId} task_id=${e.taskId} state=${e.state}${error !== undefined ? ` error=${oneLine(error, 120)}` : ""}`);
    changed(e.capId);
  }

  /** 終わった task を、時間と件数の上限で落とす。 */
  function prune(): void {
    const t = now();
    const byCap = new Map<string, Entry[]>();
    for (const e of entries.values()) {
      if (isLive(e)) continue;
      const fin = e.finishedAt === null ? t : Date.parse(e.finishedAt);
      if (t - fin > retainMs) {
        entries.delete(keyOf(e.capId, e.taskId));
        continue;
      }
      byCap.set(e.capId, [...(byCap.get(e.capId) ?? []), e]);
    }
    for (const list of byCap.values()) {
      if (list.length <= retainMax) continue;
      for (const e of list.sort((a, b) => a.seq - b.seq).slice(0, list.length - retainMax)) entries.delete(keyOf(e.capId, e.taskId));
    }
  }

  function evaluate(): void {
    for (const e of [...entries.values()]) {
      if (e.state !== "running" || !e.replied) continue;
      let busy: boolean;
      try {
        busy = deps.busy(e.capId, e.taskId);
      } catch (err) {
        log(`task の判定に失敗: cap_id=${e.capId} task_id=${e.taskId} ${errMsg(err)}`);
        continue;
      }
      if (!busy) finish(e);
    }
    prune();
    pump();
  }

  function check(): void {
    if (checkScheduled) return;
    checkScheduled = true;
    defer(() => {
      checkScheduled = false;
      evaluate();
    });
  }

  function submit(cmd: TaskCommand, opts: { deferReply?: boolean } = {}): Promise<RunOutcome> {
    if (closed) return Promise.reject(new Error("server 終了中"));
    const key = keyOf(cmd.cap_id, cmd.task_id);
    const prev = entries.get(key);
    if (prev && isLive(prev)) return Promise.reject(new Error(`同じ task_id の task が動いている: ${cmd.task_id}`));
    return new Promise<RunOutcome>((resolve, reject) => {
      const branch = typeof cmd.deliverables?.branch === "string" && cmd.deliverables.branch !== "" ? cmd.deliverables.branch : undefined;
      const e: Entry = {
        capId: cmd.cap_id,
        taskId: cmd.task_id,
        seq: ++seq,
        ...(branch !== undefined ? { branch } : {}),
        cmd,
        state: "waiting",
        queuedAt: iso(),
        startedAt: null,
        finishedAt: null,
        replied: false,
        deferReply: opts.deferReply === true,
        settle: { resolve, reject },
      };
      entries.set(key, e);
      if (deps.saveMeta) {
        void deps
          .saveMeta(e.capId, e.taskId, { ...(branch !== undefined ? { branch } : {}), queued_at: e.queuedAt })
          .catch((err: unknown) => log(`task の記録に失敗: cap_id=${e.capId} task_id=${e.taskId} ${errMsg(err)}`));
      }
      pump();
      if (e.state === "waiting") {
        const ahead = ofCap(e.capId).filter((x) => x.state === "running").map((x) => x.taskId);
        log(`task 待ち: cap_id=${e.capId} task_id=${e.taskId} 理由=${e.waitingFor ?? "-"}${branch !== undefined ? ` branch=${branch}` : ""} 実行中=${ahead.join(",") || "-"}`);
        changed(e.capId);
      }
    });
  }

  function touch(capId: string, taskId: string): void {
    const key = keyOf(capId, taskId);
    const e = entries.get(key);
    if (e === undefined) {
      // server の再起動の後などで知らない task の run が来た: 動いている task として引き継ぐ（branch は記録から）
      const t = iso();
      const adopted: Entry = { capId, taskId, seq: ++seq, state: "running", queuedAt: t, startedAt: t, finishedAt: null, replied: true, deferReply: false };
      entries.set(key, adopted);
      log(`task を引き継ぐ（記録の無い task の run）: cap_id=${capId} task_id=${taskId}`);
      changed(capId);
      if (deps.loadMeta) {
        void deps.loadMeta(capId, taskId).then(
          (m) => {
            if (m?.branch !== undefined && adopted.branch === undefined) {
              adopted.branch = m.branch;
              changed(capId);
            }
          },
          (err: unknown) => log(`task の記録を読めない: cap_id=${capId} task_id=${taskId} ${errMsg(err)}`),
        );
      }
      return;
    }
    if (e.state === "done" || e.state === "failed") {
      e.state = "running";
      e.finishedAt = null;
      delete e.error;
      delete e.forcedError;
      log(`task 再開: cap_id=${capId} task_id=${taskId}`);
      changed(capId);
    }
  }

  function noteOutcome(capId: string, taskId: string, result: { outcome?: RunOutcome; error?: string }): void {
    const e = entries.get(keyOf(capId, taskId));
    if (!e) return;
    const ok = result.outcome?.ok === true;
    e.lastOk = ok;
    if (ok) delete e.lastError;
    else e.lastError = result.outcome?.error ?? result.error ?? "指揮の実行に失敗";
  }

  async function stopCap<T>(capId: string, close: () => Promise<T>): Promise<{ result: T; dropped: number }> {
    closing.set(capId, (closing.get(capId) ?? 0) + 1);
    let dropped = 0;
    for (const e of ofCap(capId)) {
      if (e.state !== "waiting") continue;
      e.state = "failed";
      e.error = STOP_MSG;
      e.finishedAt = iso();
      e.replied = true;
      dropped++;
      log(`task を止める（待ち）: cap_id=${capId} task_id=${e.taskId}`);
      e.settle?.resolve({ session_id: "", ok: false, result_text: "", error: STOP_MSG });
      delete e.settle;
    }
    if (dropped > 0) changed(capId);
    try {
      return { result: await close(), dropped };
    } finally {
      const n = (closing.get(capId) ?? 1) - 1;
      if (n > 0) closing.set(capId, n);
      else closing.delete(capId);
      check();
    }
  }

  function snapshot(capId: string): CapTaskInfo[] {
    return ofCap(capId)
      .sort((a, b) => a.seq - b.seq)
      .map((e) => ({
        task_id: e.taskId,
        state: e.state,
        ...(e.branch !== undefined ? { branch: e.branch } : {}),
        ...(e.state === "waiting" && e.waitingFor !== undefined ? { waiting_for: e.waitingFor } : {}),
        queued_at: e.queuedAt,
        started_at: e.startedAt,
        finished_at: e.finishedAt,
        ...(e.error !== undefined ? { error: e.error } : {}),
      }));
  }

  function waitRuns(): TaskWaitRun[] {
    const out: TaskWaitRun[] = [];
    for (const e of [...entries.values()].sort((a, b) => a.seq - b.seq)) {
      if (e.state === "waiting") out.push({ capId: e.capId, taskId: e.taskId, phase: "queued", since: e.queuedAt });
      else if (e.state === "running" && !e.replied && !deps.busy(e.capId, e.taskId)) {
        out.push({ capId: e.capId, taskId: e.taskId, phase: "preparing", since: e.startedAt ?? e.queuedAt });
      }
    }
    return out;
  }

  return {
    submit,
    replied(capId, taskId) {
      const e = entries.get(keyOf(capId, taskId));
      if (!e || e.replied) return;
      e.replied = true;
      check();
    },
    touch,
    noteOutcome,
    fail(capId, taskId, message) {
      touch(capId, taskId);
      const e = entries.get(keyOf(capId, taskId));
      if (e) e.forcedError = message;
      check();
    },
    check,
    stopCap,
    snapshot,
    waitingCount: (capId) => [...entries.values()].filter((e) => e.state === "waiting" && (capId === undefined || e.capId === capId)).length,
    waitRuns,
    isActive: (capId, taskId) => {
      const e = entries.get(keyOf(capId, taskId));
      return e !== undefined && isLive(e);
    },
    has: (capId) => ofCap(capId).some(isLive),
    close(message) {
      closed = true;
      for (const e of entries.values()) {
        if (e.state !== "waiting") continue;
        e.state = "failed";
        e.error = oneLine(message, ERROR_MAX);
        e.finishedAt = iso();
        e.replied = true;
        e.settle?.resolve({ session_id: "", ok: false, result_text: "", error: message });
        delete e.settle;
      }
    },
  };
}
