import { setStatementTimeout, type Db } from "./db";

/** 埋め込み。差し替え可能（test は決定論的な fake） */
export interface Embedder {
  readonly model: string;
  readonly dim: number;
  /** timeoutMs を渡すと、その呼び出しだけ既定の timeout を上書きする（recall の query 用） */
  embed(texts: string[], opts?: { timeoutMs?: number }): Promise<number[][]>;
}

/** Ollama が timeout 内に応答しなかった */
export class EmbedTimeoutError extends Error {}
/** Ollama に接続できなかった（接続の確立に失敗）。送った item の内容とは無関係なので、item の失敗としては数えない */
export class EmbedUnreachableError extends Error {}

/** 接続を確立できなかった事を表す error code（応答の途中で切れた ECONNRESET 等は含めない。入力が原因で落ちた恐れがあるため） */
const UNREACHABLE_CODES = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EHOSTDOWN", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);

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
        // fetch の message は写さない（URL が入る事があり、OLLAMA_URL に認証情報があると漏れる）。固定の文言 + error の code だけ
        const cause = (e as { cause?: { code?: unknown; errors?: { code?: unknown }[] } })?.cause;
        // 複数の address を試して全て失敗した時（AggregateError）は、最初の 1 つの code
        const raw = cause?.code ?? cause?.errors?.[0]?.code;
        const code = typeof raw === "string" && /^[A-Z][A-Z0-9_]{1,39}$/.test(raw) ? raw : "unknown";
        const message = `ollama embed failed: connection error (${code})`;
        throw UNREACHABLE_CODES.has(code) ? new EmbedUnreachableError(message) : new Error(message);
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
export const DEFAULT_EMBED_BATCH = 1;
/**
 * 1 回の run で埋め込みに使う時間の既定の上限（ミリ秒）。task は毎分なので、run が 60 秒より前に終わる値にする。
 * 次の小分けは「この run で測った所要の最大 × 件数」が上限に収まる時だけ始める（上限をまたいで終わらない）
 */
export const DEFAULT_EMBED_RUN_MS = 50_000;
/** 失敗した item を次に試すまでの間隔: base × 2^(失敗回数 - 1)、上限 max（秒） */
export const EMBED_RETRY_BASE_SEC = 60;
export const EMBED_RETRY_MAX_SEC = 3600;
/** 「小分けでは通らず 1 件ずつなら通った」を覚えておく run の数。過ぎたら設定の件数をもう一度試す */
export const EMBED_SINGLE_RUNS = 30;
/** 小分けが失敗した直後の 1 件目を送る前に、待っている recall の query へ譲る時間の上限（過ぎたら送る。進む事の保証） */
export const EMBED_FIRST_YIELD_MS = 20_000;
/** 消化の SQL 1 文の時間上限（lock 等で固まらない） */
export const EMBED_SQL_TIMEOUT_MS = 15_000;
/** 続けてこの数の agent が全滅したら、Ollama の障害とみなして run を打ち切る */
const FAIL_STREAK_TO_STOP = 2;

/**
 * 並びの枠。agent ごとに、送った小分けの通し回数でこの順に回す。
 *  - new: 未失敗を新しい順（今入った記憶をすぐ recall に出す）
 *  - old: 未失敗を古い順（新しい記憶が入り続けても、溜まった古い分に順番が来る）
 *  - retry: 間隔の明けた失敗 item を、失敗の古い順（未失敗が残っていても再試行される）
 * 枠の対象が無い時は、同じ並びの後ろにある他の種類の item を取る（枠を空費しない）
 */
export const EMBED_LANES = ["new", "new", "old", "retry"] as const;
type Lane = (typeof EMBED_LANES)[number];

const PENDING_SELECT = `SELECT id, content FROM memory_items
  WHERE agent_id = $1 AND (embedding IS NULL OR embed_model IS DISTINCT FROM $2)
    AND (embed_failed_at IS NULL
         OR embed_failed_at <= now() - make_interval(secs => LEAST($5::float8, $4::float8 * power(2, LEAST(embed_attempts, 20) - 1))))`;
const PENDING_SQL: Record<Lane, string> = {
  new: `${PENDING_SELECT} ORDER BY (embed_attempts = 0) DESC, created_at DESC, id LIMIT $3`,
  old: `${PENDING_SELECT} ORDER BY (embed_attempts = 0) DESC, created_at ASC, id LIMIT $3`,
  retry: `${PENDING_SELECT} ORDER BY (embed_attempts > 0) DESC, embed_failed_at ASC NULLS LAST, created_at DESC, id LIMIT $3`,
};

/** run をまたいで覚える事（process の中だけ。再起動で消えても害は無い） */
export interface EmbedState {
  /** 最後に Ollama へ送った agent。次の run はその次の agent から始める（毎 run 同じ先頭から始めない） */
  lastAgent?: string;
  /** agent ごとの、送った小分けの通し回数（並びの枠を回す） */
  turns: Map<string, number>;
  /** 残り何 run の間、設定の件数ではなく 1 件ずつ送るか（小分けが timeout に収まらない機械で、毎 run timeout を待たない） */
  singleRuns: number;
}

export function createEmbedState(): EmbedState {
  return { turns: new Map(), singleRuns: 0 };
}

export interface EmbedRunOptions {
  batchSize?: number;
  maxRunMs?: number;
  gate?: EmbedGate;
  retryBaseSec?: number;
  retryMaxSec?: number;
  /** 渡さなければ、その run だけの状態で動く */
  state?: EmbedState;
  firstYieldMs?: number;
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
  /**
   * done: 今試せる分は全て済んだ / deadline: 時間の上限で打ち切り、残りは次の run /
   * failing: Ollama の障害とみなして打ち切った（接続できない・続けて複数の agent が全滅・1 件も通らなかった）
   */
  stopped: "done" | "deadline" | "failing";
}

interface PendingRow {
  id: string;
  content: string;
}

const MAX_ERRORS_PER_AGENT = 5;

/** agent の並びを、前回最後に送った agent の次から始まるように回す */
export function rotateAgents(agentIds: string[], lastAgent: string | undefined): string[] {
  if (lastAgent === undefined || agentIds.length < 2) return [...agentIds];
  let i = agentIds.indexOf(lastAgent);
  // 前回の agent が居なくなっていたら、id の順でその次に当たる所から
  i = i >= 0 ? i + 1 : agentIds.findIndex((a) => a > lastAgent);
  if (i < 0 || i >= agentIds.length) i = 0;
  return [...agentIds.slice(i), ...agentIds.slice(0, i)];
}

/**
 * 埋め込み未設定（または model が違う）item を、小分けにして埋める。
 *
 *  - 1 回の /api/embed に送るのは batchSize 件。agent を順に回し、1 巡で agent ごとに小分け 1 回（1 つの agent が他を待たせない）。
 *    始める agent は前回の続き（state.lastAgent の次）。時間の上限で打ち切られても、後ろの agent に順番が来る
 *  - 順序: EMBED_LANES の枠を agent ごとに回す（新しい順が半分、古い順と、間隔の明けた失敗 item の再試行が 1/4 ずつ）。
 *    失敗した item は間隔（base × 2^(回数-1)、上限 max）が空くまで対象にならない
 *  - 小分けが失敗したら 1 件ずつ試す。1 件でも失敗したものは embed_attempts / embed_failed_at / embed_error を記録して後回しにする。
 *    1 件ずつなら通った時は、以後 EMBED_SINGLE_RUNS 回の run は初めから 1 件ずつ送る（state.singleRuns）
 *  - 時間の上限（maxRunMs）: 過ぎたら新しい小分けを始めない。この run で測った 1 件の所要から、上限をまたぐと見込まれる小分けも始めない。
 *    小分けが失敗した直後の 1 件目だけは上限を過ぎていても試す（毎回同じ小分けで時間切れになって進まない、を防ぐ）。時間は単調な時計で測る
 *  - 全滅（1 件も通らない）した agent は、その run から外して他の agent を続ける。
 *    run を打ち切るのは Ollama の障害とみなせる時だけ: 接続できない（item に失敗を付けない）、または続けて 2 つの agent が全滅
 *  - gate があれば、小分けの合間（1 件ずつに落とした時の 1 件目の前も）に recall の query へ譲る
 */
export async function embedBacklog(db: Db, embedder: Embedder, agentIds: string[], opts: EmbedRunOptions = {}): Promise<EmbedRunSummary> {
  const now = () => performance.now();
  const deadline = now() + (opts.maxRunMs ?? DEFAULT_EMBED_RUN_MS);
  const retryBase = opts.retryBaseSec ?? EMBED_RETRY_BASE_SEC;
  const retryMax = opts.retryMaxSec ?? EMBED_RETRY_MAX_SEC;
  const firstYieldMs = opts.firstYieldMs ?? EMBED_FIRST_YIELD_MS;
  const state = opts.state ?? createEmbedState();
  const configured = Math.max(1, opts.batchSize ?? DEFAULT_EMBED_BATCH);
  const remembered = configured > 1 && state.singleRuns > 0;
  let batchSize = remembered ? 1 : configured;
  let sent = false;
  /** この run で測った、1 件あたりの所要の最大（ミリ秒）。0 = まだ測っていない */
  let itemMs = 0;
  const summaries = new Map<string, EmbedAgentSummary>(
    agentIds.map((agentId) => [agentId, { agentId, embedded: 0, failed: 0, remaining: 0, retryWait: 0, errors: [] }]),
  );
  const note = (s: EmbedAgentSummary, m: string) => {
    if (s.errors.length < MAX_ERRORS_PER_AGENT && !s.errors.includes(m)) s.errors.push(m);
  };
  /** n 件を今から送ると、時間の上限をまたぐ見込みか */
  const wouldOverrun = (n: number) => itemMs > 0 && now() + itemMs * n > deadline;

  const select = (agentId: string, lane: Lane) =>
    db.withAgent(agentId, async (q) => {
      await setStatementTimeout(q, EMBED_SQL_TIMEOUT_MS);
      return (await q.query<PendingRow>(PENDING_SQL[lane], [agentId, embedder.model, batchSize, retryBase, retryMax])).rows;
    });
  const store = (agentId: string, rows: PendingRow[], vecs: number[][]) =>
    db.withAgent(agentId, async (q) => {
      await setStatementTimeout(q, EMBED_SQL_TIMEOUT_MS);
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
    db.withAgent(agentId, async (q) => {
      await setStatementTimeout(q, EMBED_SQL_TIMEOUT_MS);
      await q.query(
        "UPDATE memory_items SET embed_attempts = embed_attempts + 1, embed_failed_at = now(), embed_error = $3 WHERE id = $1 AND agent_id = $2",
        [row.id, agentId, message],
      );
    });
  /** Ollama に送る。通れば vector、失敗なら error の要旨（unreachable = 接続できなかった） */
  const tryEmbed = async (rows: PendingRow[]): Promise<{ vecs: number[][] } | { error: string; unreachable: boolean }> => {
    if (!sent) {
      sent = true;
      if (remembered) state.singleRuns--;
    }
    const t0 = now();
    try {
      const vecs = checkVectors(await embedder.embed(rows.map((r) => r.content)), rows.length, embedder.dim);
      itemMs = Math.max(itemMs, (now() - t0) / rows.length);
      return { vecs };
    } catch (e) {
      return { error: errorSummary(e), unreachable: e instanceof EmbedUnreachableError };
    }
  };

  type StepResult = "empty" | "deadline" | "progress" | "allfailed" | "unreachable";
  /** 小分け 1 回。empty = 今試せる item が無い / deadline = 始めると上限をまたぐ / progress = 1 件以上埋めた / allfailed = 1 件も通らなかった / unreachable = Ollama に接続できない */
  const step = async (agentId: string, s: EmbedAgentSummary): Promise<StepResult> => {
    const turn = state.turns.get(agentId) ?? 0;
    const rows = await select(agentId, EMBED_LANES[turn % EMBED_LANES.length]!);
    if (rows.length === 0) return "empty";
    if (wouldOverrun(rows.length)) return "deadline";
    state.turns.set(agentId, turn + 1);
    state.lastAgent = agentId;
    const batch = await tryEmbed(rows);
    if ("vecs" in batch) {
      await store(agentId, rows, batch.vecs);
      s.embedded += rows.length;
      return "progress";
    }
    if (batch.unreachable) {
      note(s, batch.error);
      return "unreachable";
    }
    if (rows.length === 1) {
      await markFailed(agentId, rows[0]!, batch.error);
      s.failed++;
      note(s, batch.error);
      return "allfailed";
    }
    // 小分けが失敗: 1 件ずつに落とす
    note(s, `batch of ${rows.length} failed (${batch.error}); retried one by one`);
    let ok = 0;
    for (let i = 0; i < rows.length; i++) {
      if (i === 0) {
        // 1 件目は時間の上限を過ぎていても試す（進む事の保証）。待っている query には短い上限つきで譲り、過ぎたら送る
        if (opts.gate) await opts.gate.waitIdle(firstYieldMs);
      } else {
        // 2 件目以降は上限を守り、残りは次の run
        if (now() >= deadline || wouldOverrun(1)) break;
        if (opts.gate && !(await opts.gate.waitIdle(deadline - now()))) break;
      }
      const one = await tryEmbed([rows[i]!]);
      if ("vecs" in one) {
        await store(agentId, [rows[i]!], one.vecs);
        s.embedded++;
        ok++;
      } else if (one.unreachable) {
        note(s, one.error);
        return ok > 0 ? "progress" : "unreachable";
      } else {
        await markFailed(agentId, rows[i]!, one.error);
        s.failed++;
        note(s, `item ${rows[i]!.id}: ${one.error}`);
      }
    }
    // 小分けでは通らず 1 件ずつなら通る（遅い host で小分けが timeout に収まらない等）。この run の残りと、以後の数 run は 1 件ずつ送る
    if (ok > 0) {
      batchSize = 1;
      state.singleRuns = EMBED_SINGLE_RUNS;
    }
    return ok > 0 ? "progress" : "allfailed";
  };

  let stopped: EmbedRunSummary["stopped"] = "done";
  let active = rotateAgents(agentIds, state.lastAgent);
  let failStreak = 0;
  let failedAgents = 0;
  outer: while (active.length > 0) {
    const next: string[] = [];
    for (const agentId of active) {
      if (now() >= deadline) {
        stopped = "deadline";
        break outer;
      }
      if (opts.gate && !(await opts.gate.waitIdle(deadline - now()))) {
        stopped = "deadline";
        break outer;
      }
      const s = summaries.get(agentId)!;
      let r: StepResult;
      try {
        r = await step(agentId, s);
      } catch (e) {
        // DB の失敗など。この agent はこの run では諦める（他の agent は続ける）
        note(s, errorSummary(e));
        continue;
      }
      if (r === "empty") continue;
      if (r === "deadline") {
        stopped = "deadline";
        break outer;
      }
      if (r === "unreachable") {
        stopped = "failing";
        break outer;
      }
      if (r === "allfailed") {
        // 全滅した agent だけをこの run から外す。続けて全滅するなら Ollama の障害とみなして打ち切る
        failedAgents++;
        if (++failStreak >= FAIL_STREAK_TO_STOP) {
          stopped = "failing";
          break outer;
        }
        continue;
      }
      failStreak = 0;
      next.push(agentId);
    }
    active = next;
  }
  let total = 0;
  for (const s of summaries.values()) total += s.embedded;
  if (stopped === "done" && failedAgents > 0 && total === 0) stopped = "failing";

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
    await setStatementTimeout(q, EMBED_SQL_TIMEOUT_MS);
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
