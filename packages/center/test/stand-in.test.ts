import assert from "node:assert/strict";
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
