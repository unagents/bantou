import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

// 窓の無い起動（bantou-center の本番の形）: `--port` 無し・config に token 無し。port は config から、別の port には逃げない
const centerDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const procs = new Set<ChildProcess>();
let root = "";

after(async () => {
  for (const p of procs) p.kill("SIGKILL");
  if (root) await rm(root, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

function start(cfg: string, logs: string[]): ChildProcess {
  // --bind だけ渡す（待受 port は渡さない）
  const c = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "--config", cfg, "--transport", "http", "--bind", "127.0.0.1"], {
    cwd: centerDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.add(c);
  c.stderr?.setEncoding("utf8");
  c.stderr?.on("data", (d: string) => logs.push(d));
  return c;
}

async function until(what: string, ms: number, cond: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`待ち切れない: ${what}`);
}

test("窓の無い起動: config の port で待ち受け、範囲内の接続元に鍵を渡す。2 つ目は理由を出して正常終了する", { timeout: 60_000 }, async () => {
  root = await mkdtemp(join(tmpdir(), "headless-"));
  const port = await freePort();
  const cfg = join(root, "center.json");
  await writeFile(
    cfg,
    JSON.stringify({ port, keyRanges: ["127.0.0.0/8"], logDir: join(root, "logs"), remoteControl: { claude: process.execPath } }),
  );

  const logsA: string[] = [];
  const a = start(cfg, logsA);
  await until("center A の待受", 30_000, () => logsA.join("").includes(`:${port}/mcp`));

  // 鍵を取る接続 → その鍵で GraphQL（鍵の無い通信は 401）
  const base = `http://127.0.0.1:${port}`;
  const gql = (auth?: string) =>
    fetch(`${base}/graphql`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify({ query: "{ __typename }" }) });
  assert.equal((await gql()).status, 401);
  const r = await fetch(`${base}/auth/key`, { method: "POST" });
  assert.equal(r.status, 200);
  const { key } = (await r.json()) as { key: string };
  assert.equal((await gql(`Bearer ${key}`)).status, 200);
  // token を config に書かなくても center 自身の token が state dir に作られ、client の鍵とは別
  const internal = (await readFile(join(root, "internal-token"), "utf8")).trim();
  assert.notEqual(internal, key);
  assert.equal((await stat(join(root, "internal-token"))).mode & 0o777, 0o600);

  // 2 つ目: 同じ port → 理由を出して exit 0（launchd が再起動し続けない）。1 つ目は動き続ける
  const logsB: string[] = [];
  const b = start(cfg, logsB);
  const code = await new Promise<number | null>((resolve) => b.once("exit", resolve));
  assert.equal(code, 0);
  const out = logsB.join("");
  assert.match(out, new RegExp(`port ${port} は使用中`));
  assert.match(out, /既に center が動いている/);
  assert.equal(a.exitCode, null);
  assert.equal((await gql(`Bearer ${key}`)).status, 200);
});
