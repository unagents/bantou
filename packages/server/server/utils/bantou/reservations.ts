import { readFile, rename, writeFile } from "node:fs/promises";

/**
 * worker の開始の予約（cap が資源が足りないと判断して worker_start に予約のフラグを付けたもの）。
 * server は来た順に貯め、worker が 1 本終わるたびに先頭から 1 本ずつ起こす。動いている worker が 0 本の時に来た予約はすぐ起こす。
 * 足りるかの判定はしない（判断は cap）。ファイルに残し（U5 B）、再起動の後も有効。
 */

/** 起動に要る入力（worker_start の入力と同じ。prompt・repo・branch・model）。 */
export interface ReservationInput {
  prompt: string;
  repo?: string;
  branch?: string;
  model?: string;
  /** model 指定が無い時の既定（task の worker_model → cap の worker_model。予約を受けた時に決めた値）。 */
  defaultModel?: string;
}

export interface Reservation {
  capId: string;
  taskId?: string;
  workerId: string;
  input: ReservationInput;
  /** ISO 8601。受けた時刻。 */
  reservedAt: string;
}

export interface ReservationQueueDeps {
  /** 予約を残すファイル。省略時は残さない（メモリのみ）。 */
  file?: string;
  /** 今動いている worker の本数。 */
  running: () => number;
  /** 予約を起こす（worker を起動する）。manager には同期で載せること。投げたら予約は捨てる。 */
  launch: (r: Reservation) => void;
  /** 予約の件数が変わった（掲示・activity）。 */
  changed?: (capId: string) => void;
  log: (msg: string) => void;
  now?: () => number;
}

export interface ReservationQueue {
  /** 予約を受ける。すぐ起こした（動いている worker が 0 本）なら false、queue に貯めたら true。 */
  add(r: Omit<Reservation, "reservedAt">): boolean;
  /** worker が 1 本終わった。先頭から 1 本起こす。 */
  workerEnded(): void;
  /** 予約を取り消す（worker_stop）。取り消したら true。 */
  cancel(workerId: string): boolean;
  /** その cap の予約を全部捨てる（stop_cap）。捨てた件数。 */
  dropCap(capId: string): number;
  has(workerId: string): Reservation | undefined;
  /** その task の予約の件数（task の「動いている」に数える）。 */
  reservedFor(capId: string, taskId: string): number;
  /** 件数（capId を渡せばその cap だけ）。 */
  count(capId?: string): number;
  /** 来た順。 */
  list(): Reservation[];
  /** ファイルから読み直す。読んだ後、動いている worker が 0 本なら先頭を起こす。 */
  load(): Promise<number>;
  /** 書き込みが終わるのを待つ（テスト・終了用）。 */
  flush(): Promise<void>;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function isReservation(v: unknown): v is Reservation {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  const i = r.input as Record<string, unknown> | undefined;
  return (
    typeof r.capId === "string" &&
    typeof r.workerId === "string" &&
    (r.taskId === undefined || typeof r.taskId === "string") &&
    typeof r.reservedAt === "string" &&
    typeof i === "object" &&
    i !== null &&
    typeof i.prompt === "string"
  );
}

export function createReservationQueue(deps: ReservationQueueDeps): ReservationQueue {
  const { log } = deps;
  const now = deps.now ?? Date.now;
  const queue: Reservation[] = [];
  let writing: Promise<void> = Promise.resolve();

  const changed = (capId: string): void => {
    try {
      deps.changed?.(capId);
    } catch (e) {
      log(`予約の変化の通知に失敗: cap_id=${capId} ${errMsg(e)}`);
    }
  };

  function persist(): void {
    const file = deps.file;
    if (file === undefined) return;
    const body = JSON.stringify(queue) + "\n";
    writing = writing
      .then(async () => {
        await writeFile(`${file}.tmp`, body);
        await rename(`${file}.tmp`, file);
      })
      .catch((e: unknown) => log(`予約を書けない: ${errMsg(e)}`));
  }

  function launch(r: Reservation): void {
    log(`予約を起こす: cap_id=${r.capId}${r.taskId !== undefined ? ` task_id=${r.taskId}` : ""} worker_id=${r.workerId}`);
    try {
      deps.launch(r);
    } catch (e) {
      log(`予約の起動に失敗（捨てる）: worker_id=${r.workerId} ${errMsg(e)}`);
    }
  }

  function wakeHead(): void {
    const head = queue.shift();
    if (head === undefined) return;
    persist();
    launch(head);
    changed(head.capId);
  }

  return {
    add(r) {
      const rec: Reservation = { ...r, reservedAt: new Date(now()).toISOString() };
      if (deps.running() === 0 && queue.length === 0) {
        // 動いている worker が 0 本: 終了の知らせは来ないので、すぐ起こす
        launch(rec);
        return false;
      }
      queue.push(rec);
      persist();
      log(`worker を予約: cap_id=${r.capId}${r.taskId !== undefined ? ` task_id=${r.taskId}` : ""} worker_id=${r.workerId} 待ち=${queue.length}`);
      changed(r.capId);
      return true;
    },
    workerEnded() {
      wakeHead();
    },
    cancel(workerId) {
      const i = queue.findIndex((x) => x.workerId === workerId);
      if (i < 0) return false;
      const [r] = queue.splice(i, 1);
      persist();
      log(`予約を取り消す: cap_id=${r!.capId} worker_id=${workerId}`);
      changed(r!.capId);
      return true;
    },
    dropCap(capId) {
      let n = 0;
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i]!.capId === capId) {
          queue.splice(i, 1);
          n++;
        }
      }
      if (n > 0) {
        persist();
        log(`予約を捨てる（stop_cap）: cap_id=${capId} ${n} 件`);
        changed(capId);
      }
      return n;
    },
    has: (workerId) => queue.find((x) => x.workerId === workerId),
    reservedFor: (capId, taskId) => queue.filter((x) => x.capId === capId && x.taskId === taskId).length,
    count: (capId) => (capId === undefined ? queue.length : queue.filter((x) => x.capId === capId).length),
    list: () => queue.map((x) => ({ ...x, input: { ...x.input } })),
    async load() {
      const file = deps.file;
      if (file === undefined) return 0;
      let data: unknown;
      try {
        data = JSON.parse(await readFile(file, "utf8"));
      } catch (e) {
        if ((e as { code?: string }).code !== "ENOENT") log(`予約を読めない: ${errMsg(e)}`);
        return 0;
      }
      if (!Array.isArray(data)) return 0;
      for (const x of data) if (isReservation(x) && !queue.some((q) => q.workerId === x.workerId)) queue.push(x);
      if (queue.length > 0) log(`予約を読み込む: ${queue.length} 件`);
      if (deps.running() === 0) wakeHead();
      return queue.length;
    },
    flush: () => writing,
  };
}
