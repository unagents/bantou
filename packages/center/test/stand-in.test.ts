import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { createProcessStandInClient, evictStaleSameName } from "../src/stand-in.js";
import type { LinkInbound } from "../src/server-link.js";

const node = process.execPath;
const script = (body: string): string[] => [node, "-e", body];
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("stand-in 子 process: ready で connect が済み、子が出した message を onMessage に渡す。close で子が止まる", async () => {
  const logs: string[] = [];
  const c = createProcessStandInClient("alpha-cap", (m) => logs.push(m), {
    command: script(
      `console.log(JSON.stringify({ready:true}));` +
        `console.log(JSON.stringify({message:{from_name:"other",text:"hi"}}));` +
        `console.error("note");` +
        `process.stdin.resume();process.stdin.on("end",()=>process.exit(0));setInterval(()=>{},1e6);`,
    ),
  });
  const got: LinkInbound[] = [];
  c.onMessage((m) => {
    got.push(m);
  });
  await c.connect();
  for (let i = 0; i < 50 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(got.length, 1);
  assert.equal(got[0].from_name, "other");
  assert.equal(got[0].text, "hi");
  assert.ok(logs.some((l) => l.includes("alpha-cap") && l.includes("note")));
  await c.close();
});

test("stand-in 子 process: ready の前に子が終了したら connect は reject する", async () => {
  const c = createProcessStandInClient("alpha-cap", () => {}, { command: script(`process.exit(3)`) });
  await assert.rejects(c.connect(), /終了/);
});

test("stand-in 子 process: ready が来ないままなら timeout で reject し、子を止める", async () => {
  const c = createProcessStandInClient("alpha-cap", () => {}, { command: script(`console.log(process.pid);setInterval(()=>{},1e6)`), readyTimeoutMs: 200 });
  await assert.rejects(c.connect(), /タイムアウト/);
});

test("stand-in 子 process: close すると子 process が消える", async () => {
  let pid = 0;
  const c = createProcessStandInClient("alpha-cap", (m) => {
    const x = /pid=(\d+)/.exec(m);
    if (x) pid = Number(x[1]);
  }, {
    command: script(`console.error("pid="+process.pid);console.log(JSON.stringify({ready:true}));setInterval(()=>{},1e6)`),
  });
  await c.connect();
  for (let i = 0; i < 50 && !pid; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(pid > 0 && alive(pid));
  await c.close();
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(pid), false);
});

test("evictStaleSameName: 同じ host の同名の自分以外の peer だけを broker から外す（別名・別 host・自分は外さない）", async () => {
  const unregistered: string[] = [];
  const post = async (path: string, body: Record<string, unknown>): Promise<unknown> => {
    if (path === "/list-peers") {
      // broker 0.10.0 の実際の形（配列）
      return [
        { id: "old1", name: "alpha-cap", hostname: "h1" },
        { id: "me", name: "alpha-cap", hostname: "h1" },
        { id: "other", name: "beta-cap", hostname: "h1" },
        { id: "remote", name: "alpha-cap", hostname: "h2" },
      ];
    }
    unregistered.push(String(body.id));
    return { ok: true };
  };
  const r = await evictStaleSameName(post, "alpha-cap", "me", "h1", () => {});
  assert.deepEqual(r, ["old1"]);
  assert.deepEqual(unregistered, ["old1"]);
});

test("evictStaleSameName: broker の失敗は投げない（外せなければ空）", async () => {
  const logs: string[] = [];
  const r = await evictStaleSameName(async () => { throw new Error("down"); }, "alpha-cap", "me", "h1", (m) => logs.push(m));
  assert.deepEqual(r, []);
  assert.ok(logs.some((l) => l.includes("down")));
});

test("stand-in 子 process（実体）: 登録後・ready の前に、古い同名の peer を broker から外す（別名・別 host・自分は外さない）", async () => {
  const host = hostname();
  const requests: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const path = req.url ?? "";
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      requests.push(path === "/unregister" ? `${path} ${String(body.id)}` : path);
      res.setHeader("content-type", "application/json");
      if (path === "/register") res.end(JSON.stringify({ id: "me" }));
      else if (path === "/list-peers") {
        // broker 0.10.0 の実際の形（配列）。古い同名 1 件（外す）、自分・別名・別 host の同名（外さない）
        res.end(JSON.stringify([
          { id: "old1", name: "alpha-cap", hostname: host },
          { id: "me", name: "alpha-cap", hostname: host },
          { id: "other", name: "beta-cap", hostname: host },
          { id: "remote", name: "alpha-cap", hostname: `${host}-other` },
        ]));
      } else if (path === "/poll-messages") res.end(JSON.stringify({ messages: [] }));
      else res.end(JSON.stringify({ ok: true, messages: [] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const home = mkdtempSync(join(tmpdir(), "stand-in-evict-"));
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "stand-in", "--name", "alpha-cap"], {
    // 実 broker・実 HOME に触れない（使い捨て HOME・env 固定、discovery 無効）
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, AGENT_MESSENGER_HOST: "127.0.0.1", AGENT_MESSENGER_PORT: String(port), AGENT_MESSENGER_DISCOVERY: "off", AGENT_MESSENGER_CONFIG: join(home, "none.json") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const unregisteredAtReady = await new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`ready が来ない: ${requests.join(",")}`)), 20_000);
      child.once("exit", (code) => reject(new Error(`ready の前に終了 code=${code}`)));
      createInterface({ input: child.stdout! }).on("line", (l) => {
        if (l.includes('"ready"')) {
          clearTimeout(timer);
          resolve(requests.filter((r) => r.startsWith("/unregister")));
        }
      });
    });
    // ready を出した時点で、古い同名だけが外されている
    assert.deepEqual(unregisteredAtReady, ["/unregister old1"]);
  } finally {
    child.removeAllListeners("exit");
    child.stdin?.end();
    child.kill("SIGTERM");
    await new Promise<void>((r) => (child.exitCode !== null || child.signalCode !== null ? r() : child.once("exit", () => r())));
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(home, { recursive: true, force: true });
  }
});
