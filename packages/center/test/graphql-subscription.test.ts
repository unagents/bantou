import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { startHttpServer } from "../src/http.js";
import { createCore } from "../src/core.js";
import { createEventHub } from "../src/events.js";
import { parseConfig } from "../src/config.js";
import { createGraphqlHandler } from "../src/graphql/server.js";
import type { GraphqlServices } from "../src/graphql/context.js";
import { createCenterServer } from "../src/server.js";
import type { RemoteControlSupervisor } from "../src/remote-control.js";
import type { ServerLink } from "../src/server-link.js";
import type { SessionManager } from "../src/sessions.js";
import { createRemoteManager, type RemoteManager } from "../src/remotes.js";
import { createWorkerTracker } from "../src/worker-ws.js";

const TOKEN = "test-token-0123456789";
const AUTH = { authorization: `Bearer ${TOKEN}` };

/** 購読の数を数えられるようにして boot する（leak の確認用）。 */
async function boot() {
  const config = parseConfig({}, "/tmp/c.json");
  const core = createCore();
  const events = createEventHub();
  const active = { core: 0, events: 0, messages: 0 };
  const countCore = core.subscribe.bind(core);
  core.subscribe = (name, after, l) => {
    const un = countCore(name, after, l);
    if (!un) return un;
    active.core++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        active.core--;
      }
      un();
    };
  };
  const countEv = events.subscribe.bind(events);
  events.subscribe = (l) => {
    const un = countEv(l);
    active.events++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        active.events--;
      }
      un();
    };
  };
  const countMsg = events.subscribeMessage.bind(events);
  events.subscribeMessage = (l) => {
    const un = countMsg(l);
    active.messages++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        active.messages--;
      }
      un();
    };
  };
  const services = {
    config,
    supervisor: { list: () => [], shutdown: async () => {} } as unknown as RemoteControlSupervisor,
    link: {} as unknown as ServerLink,
    sessions: {} as unknown as SessionManager,
    remotes: {} as unknown as RemoteManager,
    core,
    events,
    log: () => {},
  } as unknown as GraphqlServices;
  const h = await startHttpServer({
    createServer: () => createCenterServer({ config, supervisor: services.supervisor, link: services.link, sessions: services.sessions, remotes: services.remotes }),
    graphql: createGraphqlHandler(services, () => {}),
    core,
    events,
    port: 0,
    bind: "127.0.0.1",
    token: TOKEN,
    log: () => {},
  });
  return { h, core, events, active, url: `http://127.0.0.1:${h.port}/graphql` };
}

/** subscription を SSE で購読し、届いた payload（data）を 1 つずつ取り出す。 */
async function subscribe(url: string, query: string) {
  const ac = new AbortController();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", ...AUTH },
    body: JSON.stringify({ query }),
    signal: ac.signal,
  });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let ended = false;
  const next = async (): Promise<{ data?: any; errors?: any[] } | null> => {
    for (;;) {
      const i = buf.indexOf("\n\n");
      if (i >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const m = /^event: (\w+)/m.exec(block);
        const d = /^data: (.*)$/m.exec(block);
        if (m?.[1] === "complete") {
          ended = true;
          return null;
        }
        if (m?.[1] === "next" && d) return JSON.parse(d[1]);
        continue;
      }
      const r = await reader.read();
      if (r.done) {
        ended = true;
        return null;
      }
      buf += dec.decode(r.value, { stream: true }).replace(/\r\n/g, "\n");
    }
  };
  // 届かない時にテストが固まらないよう上限を付ける（失敗として落とす）
  const nextOrFail = () =>
    Promise.race([next(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("SSE が 3 秒届かない")), 3000).unref())]);
  return { next: nextOrFail, abort: () => ac.abort(), ended: () => ended };
}

/** 条件が成り立つまで待つ（上限つき）。 */
async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`待っても成り立たない: ${what}`);
}

test("subscription sessionsChanged: events の通知が届き、10 種の reason を運ぶ。切断で購読が外れる", async () => {
  const { h, events, active, url } = await boot();
  try {
    const s = await subscribe(url, "subscription{sessionsChanged{reason name}}");
    await until(() => active.events === 1, "購読が張られる");
    const reasons = ["created", "deleted", "restored", "updated", "context", "activity", "remote", "changed", "sleep", "restarted"] as const;
    for (const reason of reasons) events.publish({ reason, name: `n-${reason}` });
    for (const reason of reasons) assert.deepEqual((await s.next())?.data, { sessionsChanged: { reason, name: `n-${reason}` } });
    s.abort();
    await until(() => active.events === 0, "切断で購読が外れる");
  } finally {
    await h.close();
  }
});

test("subscription sessionMessage: 最後の応答が届く。切断で購読が外れる", async () => {
  const { h, events, active, url } = await boot();
  try {
    const s = await subscribe(url, "subscription{sessionMessage{session text at}}");
    await until(() => active.messages === 1, "購読が張られる");
    events.publishMessage({ session: "a", text: "done", at: "2026-01-01T00:00:00.000Z" });
    assert.deepEqual((await s.next())?.data, { sessionMessage: { session: "a", text: "done", at: "2026-01-01T00:00:00.000Z" } });
    s.abort();
    await until(() => active.messages === 0, "切断で購読が外れる");
  } finally {
    await h.close();
  }
});

test("subscription remotesChanged: reason が remote の物だけを運ぶ", async () => {
  const { h, events, active, url } = await boot();
  try {
    const s = await subscribe(url, "subscription{remotesChanged{reason name}}");
    await until(() => active.events === 1, "購読が張られる");
    events.publish({ reason: "created", name: "x" });
    events.publish({ reason: "remote", name: "a" });
    events.publish({ reason: "context", name: "x" });
    events.publish({ reason: "activity", name: "b" });
    events.publish({ reason: "remote", name: "c" });
    assert.deepEqual((await s.next())?.data, { remotesChanged: { reason: "remote", name: "a" } });
    assert.deepEqual((await s.next())?.data, { remotesChanged: { reason: "remote", name: "c" } });
    s.abort();
    await until(() => active.events === 0, "切断で購読が外れる");
  } finally {
    await h.close();
  }
});

test("subscription remotesChanged: 実の RemoteManager・tracker につなぐと、launch・ws の書き込み（running）・60 秒無音（止まっている）で届く", async () => {
  const { h, events, active, url } = await boot();
  let t = 1_000_000;
  const tracker = createWorkerTracker({ now: () => t, silentMs: 60_000 });
  const link = { launch: async () => {}, requestServerInfo: async () => {} } as unknown as ServerLink;
  const manager = createRemoteManager({
    link,
    store: { load: async () => [], save: async () => {} },
    log: () => {},
    tracker,
    wsUrl: () => "ws://10.0.0.5:7910/ws/worker?token=tok",
    onSummaryChange: (name) => events.publish({ reason: "remote", name }),
    now: () => t,
    summaryCheckMs: 20,
  });
  try {
    await manager.restore();
    const s = await subscribe(url, "subscription{remotesChanged{reason name}}");
    await until(() => active.events === 1, "購読が張られる");
    const got = async () => (await s.next())?.data;
    await manager.send({ owner: "a", server: "srv", prompt: "p" });
    assert.deepEqual(await got(), { remotesChanged: { reason: "remote", name: "a" } });
    assert.equal(manager.list({})[0].state, "running");
    // 60 秒無音（周期の確認が見つける）: 止まっている
    t += 61_000;
    assert.deepEqual(await got(), { remotesChanged: { reason: "remote", name: "a" } });
    assert.equal(manager.list({})[0].state, "done");
    // /ws/worker の書き込み（tracker.note）: running に戻る
    tracker.note(manager.list({})[0].remote_id.split("@")[0]);
    assert.deepEqual(await got(), { remotesChanged: { reason: "remote", name: "a" } });
    assert.equal(manager.list({})[0].state, "running");
    s.abort();
    await until(() => active.events === 0, "切断で購読が外れる");
  } finally {
    manager.close();
    await h.close();
  }
});

test("subscription centerStatus: 購読した時点の状態を返し、切断で購読を残さない", async () => {
  const { h, url } = await boot();
  try {
    const s = await subscribe(url, "subscription{centerStatus{version running authRequired}}");
    const first = (await s.next())?.data.centerStatus;
    assert.equal(first.running, true);
    assert.equal(first.authRequired, null);
    assert.match(first.version, /^\d+\.\d+\.\d+/);
    // package.json の version と同じ（0.0.0 の取得失敗値ではない。compile した binary でも同じ取得元 = version.ts）
    assert.equal(first.version, (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version);
    assert.notEqual(first.version, "0.0.0");
    s.abort();
  } finally {
    await h.close();
  }
});

test("subscription terminalOutput: 積んである分 → live。after で続きから、残っていなければ reset", async () => {
  const { h, core, active, url } = await boot();
  try {
    core.register("t");
    core.push("t", Buffer.from("one"));
    core.push("t", Buffer.from("two"));
    const q = "subscription{terminalOutput(session:\"t\" %A){type id data status}}";
    // after 無し: reset の後に全部
    const s1 = await subscribe(url, q.replace("%A", ""));
    assert.deepEqual((await s1.next())?.data.terminalOutput, { type: "reset", id: null, data: null, status: null });
    assert.deepEqual((await s1.next())?.data.terminalOutput, { type: "output", id: 1, data: Buffer.from("one").toString("base64"), status: null });
    assert.deepEqual((await s1.next())?.data.terminalOutput, { type: "output", id: 2, data: Buffer.from("two").toString("base64"), status: null });
    core.push("t", Buffer.from("three"));
    assert.deepEqual((await s1.next())?.data.terminalOutput, { type: "output", id: 3, data: Buffer.from("three").toString("base64"), status: null });
    s1.abort();
    // after = 2: 続き（id 3）だけ。reset は出ない
    const s2 = await subscribe(url, q.replace("%A", ", after: 2"));
    assert.deepEqual((await s2.next())?.data.terminalOutput, { type: "output", id: 3, data: Buffer.from("three").toString("base64"), status: null });
    s2.abort();
    // 最新より先の after は続きにできない → reset
    const s3 = await subscribe(url, q.replace("%A", ", after: 99"));
    assert.equal((await s3.next())?.data.terminalOutput.type, "reset");
    s3.abort();
    await until(() => active.core === 0, "切断で購読が外れる");
  } finally {
    await h.close();
  }
});

test("subscription terminalOutput: session が外れたら status end を流して閉じ、購読が残らない", async () => {
  const { h, core, active, url } = await boot();
  try {
    core.register("t");
    const s = await subscribe(url, 'subscription{terminalOutput(session:"t"){type status}}');
    assert.equal((await s.next())?.data.terminalOutput.type, "reset");
    await until(() => active.core === 1, "購読が張られる");
    core.remove("t");
    assert.deepEqual((await s.next())?.data.terminalOutput, { type: "status", status: "end" });
    assert.equal(await s.next(), null);
    assert.equal(active.core, 0);
  } finally {
    await h.close();
  }
});

test("subscription terminalOutput: 未登録の session は NOT_FOUND（/output の 404 と同じ）で購読は張られない", async () => {
  const { h, active, url } = await boot();
  try {
    const s = await subscribe(url, 'subscription{terminalOutput(session:"nope"){type}}');
    const r = await s.next();
    assert.equal(r?.errors?.[0].extensions.code, "NOT_FOUND");
    assert.equal(active.core, 0);
  } finally {
    await h.close();
  }
});

test("subscription: 切断・再接続を繰り返しても購読が溜まらない。server を閉じる時にも残らない", async () => {
  const { h, core, events, active, url } = await boot();
  core.register("t");
  for (let i = 0; i < 5; i++) {
    const a = await subscribe(url, "subscription{sessionsChanged{name}}");
    const b = await subscribe(url, 'subscription{terminalOutput(session:"t"){type}}');
    await b.next();
    await until(() => active.events === 1 && active.core === 1, "購読が張られる");
    a.abort();
    b.abort();
    await until(() => active.events === 0 && active.core === 0, "全部外れる");
  }
  const open = await subscribe(url, "subscription{sessionMessage{text}}");
  await until(() => active.messages === 1, "購読が張られる");
  await h.close();
  open.abort();
  await until(() => active.messages === 0, "server 終了で外れる");
  events.publishMessage({ session: "a", text: "late", at: "x" }); // 外れた購読に届いても落ちない
});

test("subscription: 既存の /events・/sessions/<n>/output の SSE は並べて動く（変わらない）", async () => {
  const { h, core, events, url } = await boot();
  try {
    core.register("t");
    core.push("t", Buffer.from("x"));
    const base = url.replace("/graphql", "");
    const out = await fetch(`${base}/sessions/t/output`, { headers: AUTH });
    const r = out.body!.getReader();
    const text = new TextDecoder().decode((await r.read()).value);
    assert.match(text, /event: reset/);
    const ev = await fetch(`${base}/events`, { headers: AUTH });
    assert.equal(ev.status, 200);
    events.publish({ reason: "created", name: "a" });
    await r.cancel();
    await ev.body!.cancel();
  } finally {
    await h.close();
  }
});
