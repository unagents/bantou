/**
 * core: master-cap session の pty 出力のキューと、入力・サイズ変更の受け口。
 * center プロセスの中のモジュール（MCP の窓口とは独立）。HTTP への公開は http.ts が担う。
 */

/** セッションごとのキューの上限（デコード後バイト数の合計）。 */
export const CORE_QUEUE_MAX_BYTES = 8 * 1024 * 1024;

export type CoreEvent =
  | { type: "reset" }
  | { type: "chunk"; id: number; data: Buffer }
  /** session が core から外された。購読は終わる。 */
  | { type: "end" };

/** wrapper へ入力・サイズ変更を渡す口（supervisor が実行中だけ attach する）。 */
export interface CoreSink {
  input(data: Buffer): void;
  resize(cols: number, rows: number): void;
}

export interface Core {
  /** session を登録する（冪等）。登録済みの session だけ output を購読できる。 */
  register(name: string): void;
  /** session をキューごと外し、購読者へ end を送る。 */
  remove(name: string): void;
  has(name: string): boolean;
  /** 出力を 1 チャンクとして積む。付けたチャンク ID を返す。 */
  push(name: string, data: Buffer): number;
  /** 実行中の wrapper を繋ぐ / 外す。 */
  attach(name: string, sink: CoreSink): void;
  detach(name: string): void;
  running(name: string): boolean;
  /** 入力を wrapper へ渡す。未登録または実行中でなければ false。 */
  input(name: string, data: Buffer): boolean;
  /** サイズを wrapper へ渡して覚える（最後に送った側が勝つ）。未登録または実行中でなければ false。 */
  resize(name: string, cols: number, rows: number): boolean;
  /** 最後に覚えたサイズ（無ければ null）。次の wrapper 起動の初期値に使う。 */
  size(name: string): { cols: number; rows: number } | null;
  /**
   * 購読する。after = 受け取り済みの最後のチャンク ID（無ければ undefined）。
   * 続きが残っていれば after より後のチャンクだけ、残っていない / after が無ければ reset の後に積んである全部を、
   * 同期で listener に渡し、以降は live で渡す。未登録なら null。戻り値は購読解除。
   */
  subscribe(name: string, after: number | undefined, listener: (ev: CoreEvent) => void): (() => void) | null;
}

interface Queue {
  chunks: { id: number; data: Buffer }[];
  bytes: number;
  nextId: number;
  sink: CoreSink | null;
  size: { cols: number; rows: number } | null;
  listeners: Set<(ev: CoreEvent) => void>;
}

export function createCore(opts: { maxBytes?: number } = {}): Core {
  const maxBytes = opts.maxBytes ?? CORE_QUEUE_MAX_BYTES;
  const queues = new Map<string, Queue>();

  return {
    register(name) {
      if (queues.has(name)) return;
      queues.set(name, { chunks: [], bytes: 0, nextId: 1, sink: null, size: null, listeners: new Set() });
    },
    remove(name) {
      const q = queues.get(name);
      if (!q) return;
      queues.delete(name);
      q.sink = null;
      for (const l of [...q.listeners]) l({ type: "end" });
      q.listeners.clear();
    },
    has: (name) => queues.has(name),
    push(name, data) {
      const q = queues.get(name);
      if (!q) throw new Error(`未登録の session: ${name}`);
      const id = q.nextId++;
      q.chunks.push({ id, data });
      q.bytes += data.length;
      while (q.bytes > maxBytes && q.chunks.length > 0) q.bytes -= q.chunks.shift()!.data.length;
      for (const l of [...q.listeners]) l({ type: "chunk", id, data });
      return id;
    },
    attach(name, sink) {
      const q = queues.get(name);
      if (q) q.sink = sink;
    },
    detach(name) {
      const q = queues.get(name);
      if (q) q.sink = null;
    },
    running: (name) => queues.get(name)?.sink != null,
    input(name, data) {
      const sink = queues.get(name)?.sink;
      if (!sink) return false;
      sink.input(data);
      return true;
    },
    resize(name, cols, rows) {
      const q = queues.get(name);
      if (!q?.sink) return false;
      q.size = { cols, rows };
      q.sink.resize(cols, rows);
      return true;
    },
    size: (name) => queues.get(name)?.size ?? null,
    subscribe(name, after, listener) {
      const q = queues.get(name);
      if (!q) return null;
      // 先頭の ID（空なら次に付く ID）。after が oldest - 1 以上なら続きが全部残っている。
      // after が最新より先（古い center が付けた ID など）の時も、続きとして扱えないので reset。
      const oldest = q.chunks.length > 0 ? q.chunks[0].id : q.nextId;
      const resumable = after !== undefined && after >= oldest - 1 && after <= q.nextId - 1;
      if (!resumable) listener({ type: "reset" });
      for (const c of q.chunks) {
        if (!resumable || c.id > after!) listener({ type: "chunk", id: c.id, data: c.data });
      }
      q.listeners.add(listener);
      return () => void q.listeners.delete(listener);
    },
  };
}
