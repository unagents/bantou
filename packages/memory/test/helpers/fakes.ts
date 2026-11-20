import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import type { Db, Queryable } from "../../server/utils/db.ts";
import type { Embedder } from "../../server/utils/embed.ts";
import type { ChatClient } from "../../server/utils/extract.ts";

export const DIM = 768;

/** 決定論的な fake の vector: NFKC・小文字化した文字 bigram を hash して L2 正規化（語が重なるほど cosine が高い） */
export function fakeVector(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  const s = text.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  for (let i = 0; i < s.length - 1; i++) {
    let h = 2166136261;
    for (const ch of s.slice(i, i + 2)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    v[(h >>> 0) % DIM]! += 1;
  }
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

/** 決定論的な fake 埋め込み */
export function fakeEmbedder(model = "fake-embed"): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    model,
    dim: DIM,
    calls,
    async embed(texts) {
      calls.push(texts);
      return texts.map(fakeVector);
    },
  };
}

export interface FakeOllama {
  url: string;
  /** 受けた /api/embed の input（届いた順） */
  calls: string[][];
  /** 同時に処理中だった request の最大数 */
  maxInFlight: number;
  /** 応答の作り方を途中で変える */
  behavior: FakeOllamaBehavior;
  close(): Promise<void>;
}
export interface FakeOllamaBehavior {
  /** 応答までの遅れ（ミリ秒） */
  delayMs?: number;
  /** HTTP status を返せば失敗、"hang" なら応答しない（timeout の再現）、undefined なら成功 */
  fail?: (input: string[]) => number | "hang" | undefined;
}

/** 本物の Ollama embedder が叩く偽の HTTP server（POST /api/embed）。遅い応答・失敗を作る */
export async function startFakeOllama(behavior: FakeOllamaBehavior = {}): Promise<FakeOllama> {
  const out: FakeOllama = { url: "", calls: [], maxInFlight: 0, behavior, close: async () => {} };
  let inFlight = 0;
  const server: Server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const input = (JSON.parse(b) as { input: string[] }).input;
      out.calls.push(input);
      inFlight++;
      out.maxInFlight = Math.max(out.maxInFlight, inFlight);
      let done = false;
      const finish = () => {
        if (!done) inFlight--;
        done = true;
      };
      res.on("close", finish);
      const f = out.behavior.fail?.(input);
      if (f === "hang") return;
      setTimeout(() => {
        if (typeof f === "number") {
          res.statusCode = f;
          res.end("error");
        } else {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ embeddings: input.map(fakeVector) }));
        }
        finish();
      }, out.behavior.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  out.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  out.close = async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return out;
}

/** 誰も listen していない port の URL（接続が拒否される = Ollama が落ちている時の再現） */
export async function closedPortUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

export type ChatScript = (req: { system: string; user: string }) => unknown | Promise<unknown>;

export function fakeChat(script: ChatScript): ChatClient & { requests: { system: string; user: string; schemaName: string; schema: object }[] } {
  const requests: { system: string; user: string; schemaName: string; schema: object }[] = [];
  return {
    requests,
    async completeJson(req) {
      requests.push(req);
      return script(req);
    },
  };
}

export interface TestDb {
  db: Db;
  /** RLS を受けない superuser の接続で実行する（検証用） */
  asSuper<T>(fn: (sq: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** 全 migration の Up 部分を名前順につないだもの（PGlite と実 PostgreSQL で共通） */
export function readUpMigration(): string {
  const dir = fileURLToPath(new URL("../../migrations/", import.meta.url));
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(`${dir}${f}`, "utf8").split("-- Up Migration")[1]!.split("-- Down Migration")[0]!)
    .join("\n");
}

/** PGlite（WASM の本物の PostgreSQL + pgvector）に migration を当て、非 superuser role で接続する（RLS を効かせるため） */
export async function createTestDb(): Promise<TestDb> {
  const raw = new PGlite({ extensions: { vector } });
  await raw.exec("CREATE EXTENSION IF NOT EXISTS vector");
  await raw.exec(readUpMigration());
  await raw.exec("CREATE ROLE memory_app NOLOGIN");
  await raw.exec("GRANT ALL ON ALL TABLES IN SCHEMA public TO memory_app");
  await raw.exec("GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO memory_app");
  await raw.exec("SET ROLE memory_app");
  const db: Db = {
    query: (sql, params) => raw.query(sql, params as unknown[]) as never,
    withAgent: (agentId, fn) =>
      raw.transaction(async (tx) => {
        await tx.query("SELECT set_config('app.agent_id', $1, true)", [agentId]);
        return fn({ query: (sql, params) => tx.query(sql, params as unknown[]) as never });
      }),
    close: () => raw.close(),
  };
  return {
    db,
    asSuper: async (fn) => {
      await raw.exec("RESET ROLE");
      try {
        return await fn({ query: (sql, params) => raw.query(sql, params as unknown[]) as never });
      } finally {
        await raw.exec("SET ROLE memory_app");
      }
    },
    close: () => raw.close(),
  };
}

let seq = 0;
export function ev(over: Partial<{ eventId: string; kind: string; body: string; at: string; taskId: string; remoteId: string }> = {}) {
  seq++;
  return {
    eventId: over.eventId ?? `e${seq}`,
    sender: { session: "master" },
    recipient: { workerId: "w1" },
    kind: over.kind ?? "user_prompt",
    body: over.body ?? `body ${seq}`,
    at: over.at ?? "2026-11-01T00:00:00Z",
    ...(over.taskId ? { taskId: over.taskId } : {}),
    ...(over.remoteId ? { remoteId: over.remoteId } : {}),
  };
}
