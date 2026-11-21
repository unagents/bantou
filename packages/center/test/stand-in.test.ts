import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProcessStandInClient, evictStaleSameName, shutdownStandIn } from "../src/stand-in.js";
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

test("shutdownStandIn: 登録を外す前に受け取り切り、外した後の残りも拾う。どの段の失敗も後の段を止めない", async () => {
  const order: string[] = [];
  let pending = [{ id: 1 }, { id: 2 }];
  const emitted: number[] = [];
  await shutdownStandIn({
    drain: async () => {
      order.push("drain");
      const r = pending;
      pending = [];
      for (const m of r) emitted.push(m.id);
      return r;
    },
    close: async () => {
      order.push("close");
      throw new Error("down");
    },
    leftover: async () => {
      order.push("leftover");
      return [{ id: 3 }];
    },
    emit: (m) => emitted.push(m.id),
  });
  // 空振りが 2 回続くまで drain する → close → leftover
  assert.deepEqual(order, ["drain", "drain", "drain", "close", "leftover"]);
  assert.deepEqual(emitted, [1, 2, 3]);
});

/** broker の message 周りの意味（外すと未受信は捨てる・受信済み未確認は残る）を写した最小の偽 broker。 */
function fakeBroker(): Promise<{ port: number; close: () => Promise<void> }> {
  type Peer = { id: string; name: string; pid: number; hostname: string };
  type Msg = { id: number; from_id: string; from_name: string; to_id: string; text: string; mode: string; delivered: 0 | 1 };
  const peers = new Map<string, Peer>();
  let messages: Msg[] = [];
  let nextPeer = 1;
  let nextMsg = 1;
  const routes: Record<string, (b: Record<string, unknown>) => unknown> = {
    "/register": (b) => {
      const id = `p${nextPeer++}`;
      peers.set(id, { id, name: String(b.name ?? ""), pid: Number(b.pid), hostname: String(b.hostname ?? "") });
      return { id };
    },
    "/heartbeat": (b) => (peers.has(String(b.id)) ? { ok: true } : { ok: false, error: "unknown peer (re-register)" }),
    "/list-peers": () => [...peers.values()],
    "/send-message": (b) => {
      const to = [...peers.values()].filter((p) => p.id === b.to || p.name === b.to);
      if (to.length !== 1) return { ok: false, error: `Peer "${String(b.to)}" not found` };
      messages.push({ id: nextMsg++, from_id: String(b.from_id ?? "x"), from_name: String(b.from_name ?? ""), to_id: to[0].id, text: String(b.text), mode: String(b.mode ?? "pull"), delivered: 0 });
      return { ok: true };
    },
    "/poll-messages": (b) => {
      const out = messages.filter((m) => m.to_id === b.id && m.delivered === 0);
      for (const m of out) m.delivered = 1;
      return { messages: out };
    },
    "/acknowledge-messages": (b) => {
      const ids = new Set(b.message_ids as number[]);
      messages = messages.filter((m) => !(m.to_id === b.id && ids.has(m.id)));
      return { ok: true };
    },
    "/get-buffered-messages": (b) => ({ messages: messages.filter((m) => m.to_id === b.id && m.delivered === 1) }),
    "/unregister": (b) => {
      peers.delete(String(b.id));
      messages = messages.filter((m) => !(m.to_id === b.id && m.delivered === 0));
      return { ok: true };
    },
  };
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.setHeader("content-type", "application/json");
      return void res.end(JSON.stringify({ status: "ok", id: "fake", peers: peers.size }));
    }
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const h = routes[req.url ?? ""];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(h ? h(body ? JSON.parse(body) : {}) : { ok: false, error: "no route" }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as { port: number }).port, close: () => new Promise((r) => server.close(() => r())) })));
}

// 本物の stand-in 子 process（src/cli.ts stand-in）を、使い捨ての HOME・偽 broker に繋ぎ、1 通目で身代わりを外す（gate と同じ）。
// 受け取った message は全部、親へ 1 通ずつ届くこと。
for (const [label, gaps] of [
  ["0.5 秒後に 2 通目", [500]],
  ["0.1 秒後に 2 通目", [100]],
  ["続けて 5 通", [0, 0, 0, 0]],
] as const) {
  test(`stand-in 実 process: 1 通目で外しても、mailbox に入った message を全部渡す（${label}）`, async () => {
    const broker = await fakeBroker();
    const home = mkdtempSync(join(tmpdir(), "stand-in-home-"));
    const url = `http://127.0.0.1:${broker.port}`;
    const post = async (path: string, body: unknown): Promise<{ ok?: boolean; id?: string; error?: string }> =>
      (await (await fetch(url + path, { method: "POST", body: JSON.stringify(body) })).json()) as { ok?: boolean; id?: string };
    const sender = (await post("/register", { name: "sender", pid: 1, hostname: "h" })).id!;
    const got: LinkInbound[] = [];
    const c = createProcessStandInClient("alpha-cap", () => {}, {
      command: [node, "--import", "tsx", join(import.meta.dirname, "../src/cli.ts"), "stand-in", "--name", "alpha-cap"],
      env: { PATH: process.env.PATH, HOME: home, AGENT_MESSENGER_HOST: "127.0.0.1", AGENT_MESSENGER_PORT: String(broker.port), AGENT_MESSENGER_DISCOVERY: "off" },
      readyTimeoutMs: 20_000,
    });
    let closing: Promise<void> | null = null;
    c.onMessage((m) => {
      got.push(m);
      if (!closing) closing = c.close(); // 1 通目を受けたら身代わりを外す
    });
    try {
      await c.connect();
      const total = gaps.length + 1;
      const send = async (n: number): Promise<void> => {
        const r = await post("/send-message", { to: "alpha-cap", from_id: sender, from_name: "sender", text: `m${n}`, mode: "push" });
        assert.equal(r.ok, true, `m${n} を送れた: ${r.error ?? ""}`);
      };
      await send(1);
      // 2 通目以降は、身代わりがまだ居る間（1 通目を受けて外す前後）に mailbox へ入れる
      for (const [i, gap] of gaps.entries()) {
        await new Promise((r) => setTimeout(r, gap));
        await send(i + 2);
      }
      for (let i = 0; i < 100 && got.length < total; i++) await new Promise((r) => setTimeout(r, 100));
      await closing;
      assert.deepEqual(got.map((m) => m.text).sort(), Array.from({ length: total }, (_, i) => `m${i + 1}`));
    } finally {
      await c.close();
      await broker.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
}
