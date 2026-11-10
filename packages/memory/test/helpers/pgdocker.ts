import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createPgDb } from "../../server/utils/db.ts";
import { readUpMigration, type TestDb } from "./fakes.ts";

const IMAGE = process.env.MEMORY_TEST_PG_IMAGE || "pgvector/pgvector:pg17";

/** docker が使えなければ skip の理由を返す。使えれば undefined */
export function dockerSkipReason(): string | undefined {
  const r = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 15000 });
  if (r.error) return `docker unavailable: ${r.error.message}`;
  if (r.status !== 0) {
    const line = (r.stderr || "").split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("WARNING")).pop();
    return `docker unavailable: ${line ?? `exit ${r.status}`}`;
  }
  return undefined;
}

function docker(args: string[]): string {
  const r = spawnSync("docker", args, { encoding: "utf8", timeout: 120000 });
  if (r.status !== 0) throw new Error(`docker ${args[0]} failed: ${(r.stderr || "").trim()}`);
  return r.stdout.trim();
}

/**
 * 実 PostgreSQL（pgvector 入り image）を docker で起動して migration を当てる。
 * container 名は作業用 prefix 付き。close() で必ず rm する。
 */
export async function createDockerPgTestDb(): Promise<TestDb> {
  const name = `w-mem1-impl-pg-${process.pid}-${randomBytes(3).toString("hex")}`;
  const superPw = randomBytes(12).toString("hex");
  const appPw = randomBytes(12).toString("hex");
  docker(["run", "-d", "--name", name, "-e", `POSTGRES_PASSWORD=${superPw}`, "-p", "127.0.0.1::5432", IMAGE]);
  const cleanup = () => {
    spawnSync("docker", ["rm", "-f", "-v", name], { timeout: 60000 });
  };
  try {
    for (let i = 0; ; i++) {
      const r = spawnSync("docker", ["exec", name, "pg_isready", "-U", "postgres"], { encoding: "utf8" });
      if (r.status === 0) break;
      if (i > 60) throw new Error("postgres did not become ready");
      await new Promise((res) => setTimeout(res, 1000));
    }
    const mapped = docker(["port", name, "5432/tcp"]).split("\n")[0]!;
    const port = mapped.slice(mapped.lastIndexOf(":") + 1);
    const superDb = createPgDb(`postgres://postgres:${superPw}@127.0.0.1:${port}/postgres`);
    // 起動直後は再起動が挟まることがあるので接続を再試行する
    for (let i = 0; ; i++) {
      try {
        await superDb.query("SELECT 1");
        break;
      } catch (e) {
        if (i > 30) throw e;
        await new Promise((res) => setTimeout(res, 1000));
      }
    }
    await superDb.query(readUpMigration());
    await superDb.query(`CREATE ROLE memory_app LOGIN PASSWORD '${appPw}'`);
    // README の DB role の手順と同じ権限（DELETE なし）
    await superDb.query("GRANT USAGE ON SCHEMA public TO memory_app");
    await superDb.query("GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO memory_app");
    await superDb.query("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO memory_app");
    const appDb = createPgDb(`postgres://memory_app:${appPw}@127.0.0.1:${port}/postgres`);
    return {
      db: appDb,
      asSuper: (fn) => fn(superDb),
      close: async () => {
        await appDb.close().catch(() => {});
        await superDb.close().catch(() => {});
        cleanup();
      },
    };
  } catch (e) {
    cleanup();
    throw e;
  }
}
