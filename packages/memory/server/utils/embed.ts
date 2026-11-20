import type { Db } from "./db";

/** 埋め込み。差し替え可能（test は決定論的な fake） */
export interface Embedder {
  readonly model: string;
  readonly dim: number;
  /** timeoutMs を渡すと、その呼び出しだけ既定の timeout を上書きする（recall の query 用） */
  embed(texts: string[], opts?: { timeoutMs?: number }): Promise<number[][]>;
}

/** Ollama が timeout 内に応答しなかった */
export class EmbedTimeoutError extends Error {}

/** error の要旨（log・状態の口・DB に残す分）。本文や token を含めない。長さを切る */
export function errorSummary(e: unknown, max = 200): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/\s+/g, " ").slice(0, max);
}

/**
 * Ollama の POST /api/embed。model と次元は環境変数（migration の vector(N) と一致が必要）。
 * error の message に入力（記憶の本文）や応答の body を入れない。
 */
export function createOllamaEmbedder(opts: { url: string; model: string; dim: number; timeoutMs: number }): Embedder {
  return {
    model: opts.model,
    dim: opts.dim,
    async embed(texts, o) {
      const timeoutMs = o?.timeoutMs ?? opts.timeoutMs;
      let res: Response;
      try {
        res = await fetch(`${opts.url}/api/embed`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: opts.model, input: texts }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
          throw new EmbedTimeoutError(`ollama embed timeout (${timeoutMs} ms, ${texts.length} texts)`);
        }
        const code = (e as { cause?: { code?: unknown } })?.cause?.code;
        throw new Error(`ollama embed failed: ${typeof code === "string" ? code : errorSummary(e, 80)}`);
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`ollama embed failed: HTTP ${res.status}`);
      }
      let j: { embeddings?: number[][] };
      try {
        j = (await res.json()) as { embeddings?: number[][] };
      } catch (e) {
        if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
          throw new EmbedTimeoutError(`ollama embed timeout (${timeoutMs} ms, ${texts.length} texts)`);
        }
        throw new Error("ollama embed failed: response is not JSON");
      }
      return checkVectors(j.embeddings, texts.length, opts.dim);
    },
  };
}

export function checkVectors(v: unknown, n: number, dim: number): number[][] {
  if (!Array.isArray(v) || v.length !== n) throw new Error(`embedding count mismatch (want ${n})`);
  for (const e of v) {
    if (!Array.isArray(e) || e.length !== dim) {
      throw new Error(`embedding dimension mismatch: want ${dim}, got ${Array.isArray(e) ? e.length : "none"}. MEMORY_EMBED_DIM と migration の vector(N) を model に合わせること`);
    }
  }
  return v as number[][];
}

/** pgvector のリテラル '[a,b,...]'。値は param で渡す */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

// ---- recall の query を優先する門 ----

/**
 * Ollama は 1 つの列で処理する。recall の query の埋め込みが待っている間は、溜まった分の消化を次の小分けに進めない。
 * query は門を通して呼び（runQuery）、消化は小分けの合間に waitIdle で譲る。
 * 既に Ollama に送った小分け 1 回は止めないので、query が待つのは最長でその 1 回分。
 */
export interface EmbedGate {
  runQuery<T>(fn: () => Promise<T>): Promise<T>;
  /** query が 1 つも無くなるまで待つ。maxMs を過ぎても残っていれば false */
  waitIdle(maxMs: number): Promise<boolean>;
  /** 実行中・待ち中の query の数 */
  readonly queries: number;
}

export function createEmbedGate(): EmbedGate {
  let n = 0;
  let waiters: (() => void)[] = [];
  return {
    get queries() {
      return n;
    },
    async runQuery(fn) {
      n++;
      try {
        return await fn();
      } finally {
        n--;
        if (n === 0) {
          const w = waiters;
          waiters = [];
          for (const f of w) f();
        }
      }
    },
    waitIdle(maxMs) {
      if (n === 0) return Promise.resolve(true);
      if (maxMs <= 0) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), maxMs);
        waiters.push(() => {
          clearTimeout(timer);
          resolve(true);
        });
      });
    },
  };
}

/** recall の query 用の embedder: 門を通し、query 用の timeout を既定にする */
export function createQueryEmbedder(base: Embedder, gate: EmbedGate, timeoutMs: number): Embedder {
  return {
    model: base.model,
    dim: base.dim,
    embed: (texts, o) => gate.runQuery(() => base.embed(texts, { timeoutMs: o?.timeoutMs ?? timeoutMs })),
  };
}

// ---- 溜まった分の消化 ----

/** 1 回の /api/embed に送る件数の既定 */
export const DEFAULT_EMBED_BATCH = 2;
/** 1 回の run で埋め込みに使う時間の既定の上限（ミリ秒）。task は毎分なので 1 分より短くする */
export const DEFAULT_EMBED_RUN_MS = 45_000;
/** 失敗した item を次に試すまでの間隔: base × 2^(失敗回数 - 1)、上限 max（秒） */
export const EMBED_RETRY_BASE_SEC = 60;
export const EMBED_RETRY_MAX_SEC = 3600;

export interface EmbedRunOptions {
  batchSize?: number;
  maxRunMs?: number;
  gate?: EmbedGate;
  retryBaseSec?: number;
  retryMaxSec?: number;
}

export interface EmbedAgentSummary {
  agentId: string;
  /** この run で埋め込めた件数 */
  embedded: number;
  /** この run で失敗として記録した件数（後回し） */
  failed: number;
  /** run の後に残っている埋め込み待ち（後回し中を含む） */
  remaining: number;
  /** remaining のうち、失敗して再試行を待っている件数 */
  retryWait: number;
  /** error の要旨（本文を含まない） */
  errors: string[];
}

export interface EmbedRunSummary {
  agents: EmbedAgentSummary[];
  /** done: 今試せる分は全て済んだ / deadline: 時間の上限で打ち切り、残りは次の run / failing: 小分けが全滅したので打ち切り（Ollama 側の障害の疑い） */
  stopped: "done" | "deadline" | "failing";
}

interface PendingRow {
  id: string;
  content: string;
}

const MAX_ERRORS_PER_AGENT = 5;

/**
 * 埋め込み未設定（または model が違う）item を、小分けにして埋める。
 *
 *  - 1 回の /api/embed に送るのは batchSize 件。agent を順に回し、1 巡で agent ごとに小分け 1 回（1 つの agent が他を待たせない）
 *  - 順序: まだ失敗していない item を新しい順（今日入った記憶が、溜まった古い分の後ろで待たない）。
 *    失敗した item はその後ろで、間隔（base × 2^(回数-1)、上限 max）が空いたものだけ
 *  - 小分けが失敗したら 1 件ずつ試す。1 件でも失敗したものは embed_attempts / embed_failed_at / embed_error を記録して後回しにする
 *    （次の run の先頭は別の item になる。1 件が列を塞がない）
 *  - 時間の上限（maxRunMs）を過ぎたら新しい小分けを始めない。残りは次の run。
 *    小分けが失敗した直後の 1 件目だけは上限を過ぎていても試す（毎回同じ小分けで時間切れになって進まない、を防ぐ）
 *  - 小分けが全滅（1 件も通らない）したら、その run を打ち切る（Ollama が落ちている時に全件へ失敗を付けて回らない）
 *  - gate があれば、小分けの合間に recall の query へ譲る
 */
export async function embedBacklog(db: Db, embedder: Embedder, agentIds: string[], opts: EmbedRunOptions = {}): Promise<EmbedRunSummary> {
  const deadline = Date.now() + (opts.maxRunMs ?? DEFAULT_EMBED_RUN_MS);
  const retryBase = opts.retryBaseSec ?? EMBED_RETRY_BASE_SEC;
  const retryMax = opts.retryMaxSec ?? EMBED_RETRY_MAX_SEC;
  let batchSize = Math.max(1, opts.batchSize ?? DEFAULT_EMBED_BATCH);
  const summaries = new Map<string, EmbedAgentSummary>(
    agentIds.map((agentId) => [agentId, { agentId, embedded: 0, failed: 0, remaining: 0, retryWait: 0, errors: [] }]),
  );
  const note = (s: EmbedAgentSummary, m: string) => {
    if (s.errors.length < MAX_ERRORS_PER_AGENT && !s.errors.includes(m)) s.errors.push(m);
  };

  const select = (agentId: string) =>
    db.withAgent(agentId, async (q) =>
      (await q.query<PendingRow>(
        `SELECT id, content FROM memory_items
          WHERE agent_id = $1 AND (embedding IS NULL OR embed_model IS DISTINCT FROM $2)
            AND (embed_failed_at IS NULL
                 OR embed_failed_at <= now() - make_interval(secs => LEAST($5::float8, $4::float8 * power(2, LEAST(embed_attempts, 20) - 1))))
          ORDER BY (embed_attempts = 0) DESC, created_at DESC, id
          LIMIT $3`,
        [agentId, embedder.model, batchSize, retryBase, retryMax],
      )).rows,
    );
  const store = (agentId: string, rows: PendingRow[], vecs: number[][]) =>
    db.withAgent(agentId, async (q) => {
      for (let i = 0; i < rows.length; i++) {
        await q.query(
          `UPDATE memory_items SET embedding = $1::vector, embed_model = $2, embedded_at = now(),
                  embed_attempts = 0, embed_failed_at = NULL, embed_error = NULL, updated_at = now()
            WHERE id = $3 AND agent_id = $4`,
          [toVectorLiteral(vecs[i]!), embedder.model, rows[i]!.id, agentId],
        );
      }
    });
  const markFailed = (agentId: string, row: PendingRow, message: string) =>
    db.withAgent(agentId, (q) =>
      q.query(
        "UPDATE memory_items SET embed_attempts = embed_attempts + 1, embed_failed_at = now(), embed_error = $3 WHERE id = $1 AND agent_id = $2",
        [row.id, agentId, message],
      ),
    );
  const embedRows = async (rows: PendingRow[]) => checkVectors(await embedder.embed(rows.map((r) => r.content)), rows.length, embedder.dim);

  /** 小分け 1 回。戻り値: empty = 今試せる item が無い / progress = 1 件以上埋めた / allfailed = 1 件も通らなかった */
  const step = async (agentId: string, s: EmbedAgentSummary): Promise<"empty" | "progress" | "allfailed"> => {
    const rows = await select(agentId);
    if (rows.length === 0) return "empty";
    let vecs: number[][] | undefined;
    let batchError = "";
    try {
      vecs = await embedRows(rows);
    } catch (e) {
      batchError = errorSummary(e);
    }
    if (vecs) {
      await store(agentId, rows, vecs);
      s.embedded += rows.length;
      return "progress";
    }
    if (rows.length === 1) {
      await markFailed(agentId, rows[0]!, batchError);
      s.failed++;
      note(s, batchError);
      return "allfailed";
    }
    // 小分けが失敗: 1 件ずつに落とす
    note(s, `batch of ${rows.length} failed (${batchError}); retried one by one`);
    let ok = 0;
    for (let i = 0; i < rows.length; i++) {
      // 1 件目は時間の上限を過ぎていても試す（進む事の保証）。2 件目以降は上限を守り、残りは次の run
      if (i > 0) {
        if (Date.now() >= deadline) break;
        if (opts.gate && !(await opts.gate.waitIdle(deadline - Date.now()))) break;
      }
      let one: number[][] | undefined;
      let oneError = "";
      try {
        one = await embedRows([rows[i]!]);
      } catch (e) {
        oneError = errorSummary(e);
      }
      if (one) {
        await store(agentId, [rows[i]!], one);
        s.embedded++;
        ok++;
      } else {
        await markFailed(agentId, rows[i]!, oneError);
        s.failed++;
        note(s, `item ${rows[i]!.id}: ${oneError}`);
      }
    }
    // 小分けでは通らず 1 件ずつなら通る（遅い host で小分けが timeout に収まらない等）。この run の残りは 1 件ずつ送る
    if (ok > 0) batchSize = 1;
    return ok > 0 ? "progress" : "allfailed";
  };

  let stopped: EmbedRunSummary["stopped"] = "done";
  let active = [...agentIds];
  outer: while (active.length > 0) {
    const next: string[] = [];
    for (const agentId of active) {
      if (Date.now() >= deadline) {
        stopped = "deadline";
        break outer;
      }
      if (opts.gate && !(await opts.gate.waitIdle(deadline - Date.now()))) {
        stopped = "deadline";
        break outer;
      }
      const s = summaries.get(agentId)!;
      let r: "empty" | "progress" | "allfailed";
      try {
        r = await step(agentId, s);
      } catch (e) {
        // DB の失敗など。この agent はこの run では諦める（他の agent は続ける）
        note(s, errorSummary(e));
        continue;
      }
      if (r === "empty") continue;
      if (r === "allfailed") {
        stopped = "failing";
        break outer;
      }
      next.push(agentId);
    }
    active = next;
  }

  for (const s of summaries.values()) {
    try {
      const c = await pendingCounts(db, s.agentId, embedder.model);
      s.remaining = c.pending;
      s.retryWait = c.retryWait;
    } catch (e) {
      note(s, errorSummary(e));
    }
  }
  return { agents: [...summaries.values()], stopped };
}

export async function pendingCounts(db: Db, agentId: string, model: string): Promise<{ pending: number; retryWait: number }> {
  return db.withAgent(agentId, async (q) => {
    const r = await q.query<{ pending: number; retry_wait: number }>(
      `SELECT count(*)::int AS pending, (count(*) FILTER (WHERE embed_failed_at IS NOT NULL))::int AS retry_wait
         FROM memory_items WHERE agent_id = $1 AND (embedding IS NULL OR embed_model IS DISTINCT FROM $2)`,
      [agentId, model],
    );
    return { pending: Number(r.rows[0]?.pending ?? 0), retryWait: Number(r.rows[0]?.retry_wait ?? 0) };
  });
}

/** 1 agent 分の消化（embedBacklog の薄い包み）。埋め込めた件数を返す。失敗した分は後回しになり、次回以降に回る */
export async function embedPending(db: Db, agentId: string, embedder: Embedder, opts: EmbedRunOptions = {}): Promise<number> {
  const r = await embedBacklog(db, embedder, [agentId], opts);
  return r.agents[0]?.embedded ?? 0;
}
