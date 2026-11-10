import pg from "pg";

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  /** 1 transaction。認証済み agent を app.agent_id に設定してから fn を実行する（RLS 用） */
  withAgent<T>(agentId: string, fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** 値は必ず params で渡す。SQL 文字列に値を埋め込まない */
export function createPgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 8 });
  return {
    query: (sql, params) => pool.query(sql, params as unknown[]) as never,
    async withAgent(agentId, fn) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.agent_id', $1, true)", [agentId]);
        const r = await fn({ query: (sql, params) => c.query(sql, params as unknown[]) as never });
        await c.query("COMMIT");
        return r;
      } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
    close: () => pool.end(),
  };
}
