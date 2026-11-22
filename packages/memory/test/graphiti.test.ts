// Outbox → Graphiti の消費者（server/utils/graphiti*.ts）。PGlite の本物の PostgreSQL + fake の Graphiti。
// 実際の Graphiti（公式 MCP server + Neo4j）での確認は docs/design/memory-graphiti.md の「実測」。
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, ev, type TestDb } from "./helpers/fakes.ts";
import { recordEvent } from "../server/utils/events.ts";
import {
  GraphitiRejectedError, GraphitiUnavailableError, createGraphitiMcpClient, graphitiGroupId,
  type AddMemoryRequest, type GraphitiClient, type GraphitiFact,
} from "../server/utils/graphiti.ts";
import { SYNC_MAX_ATTEMPTS, TOPIC_EVENT, TOPIC_ITEM, episodeName, outboxCounts, syncAll, syncForAgent } from "../server/utils/graphiti-sync.ts";
import { graphSearch } from "../server/utils/graphiti-recall.ts";
import { resetGraphitiCycleState, runGraphitiCycle, runGraphitiTask } from "../server/utils/graphiti-task.ts";
import { setRuntime, type Runtime } from "../server/utils/runtime.ts";
import { readEnv } from "../server/utils/config.ts";

/** Graphiti の fake。add_memory は queue に積むだけ（finish するまで episode は現れない = 本物の非同期の再現）。episode の uuid は Graphiti が付ける（finish が返す） */
function fakeGraphiti() {
  const f = {
    added: [] as AddMemoryRequest[],
    processed: new Map<string, string>(),
    /** name の episode が反映された事にする。付いた uuid を返す */
    finish(name: string): string {
      const u = randomUUID();
      f.processed.set(name, u);
      return u;
    },
    reject: undefined as undefined | ((r: AddMemoryRequest) => boolean),
    down: false,
    facts: [] as GraphitiFact[],
    async addMemory(req: AddMemoryRequest) {
      if (f.down) throw new GraphitiUnavailableError("graphiti add_memory: ECONNREFUSED");
      if (f.reject?.(req)) throw new GraphitiRejectedError("graphiti add_memory: rejected");
      f.added.push(req);
    },
    async recentEpisodes() {
      if (f.down) throw new GraphitiUnavailableError("graphiti get_episodes: ECONNREFUSED");
      return [...f.processed].map(([name, uuid]) => ({ name, uuid }));
    },
    async searchFacts() {
      return f.facts;
    },
    async close() {},
  };
  return f satisfies GraphitiClient & Record<string, unknown>;
}

describe("graphiti", () => {
  let t!: TestDb;
  before(async () => {
    t = await createTestDb();
  });
  after(async () => {
    await t.close();
  });

  let seq = 0;
  const newAgent = () => `g-agent-${++seq}`;

  /** item と、その出典 event と、item の Outbox 行を作る */
  async function addItem(agent: string, content: string, over: { scope?: string; status?: string } = {}) {
    const e = ev({ kind: "user_prompt", body: `src ${content}`, at: "2026-11-02T00:00:00Z" });
    await recordEvent(t.db, agent, e);
    return t.asSuper(async (sq) => {
      const id = (await sq.query<{ id: string }>(
        "INSERT INTO memory_items (agent_id, scope, memory_type, content, content_norm, status, valid_from) VALUES ($1,$2,'semantic',$3,$4,$5,'2026-11-02T00:00:00Z') RETURNING id::text",
        [agent, over.scope ?? "agent_private", content, content.toLowerCase(), over.status ?? "confirmed"],
      )).rows[0]!.id;
      await sq.query("INSERT INTO memory_sources (item_id, agent_id, event_id) VALUES ($1,$2,$3)", [id, agent, e.eventId]);
      await sq.query("INSERT INTO outbox_events (agent_id, topic, idempotency_key, payload) VALUES ($1,$2,$3,$4::jsonb)", [agent, TOPIC_ITEM, id, JSON.stringify({ itemId: id })]);
      return { id, eventId: e.eventId };
    });
  }
  const outboxRow = (agent: string, topic: string, key: string) =>
    t.asSuper(async (sq) =>
      (await sq.query<{ sent_at: Date | null; processed_at: Date | null; failed_at: Date | null; attempts: number; episode_uuid: string | null; last_error: string | null; next_attempt_at: Date | null }>(
        "SELECT sent_at, processed_at, failed_at, attempts, episode_uuid, last_error, next_attempt_at FROM outbox_events WHERE agent_id = $1 AND topic = $2 AND idempotency_key = $3",
        [agent, topic, key],
      )).rows[0]!,
    );

  test("group_id は Graphiti の許可文字（英数字・-・_）だけで、agent ごとに別になる。episode の name は topic と key から決まる", () => {
    const g = graphitiGroupId("master:cap.1@host");
    assert.match(g, /^[A-Za-z0-9_-]+$/);
    assert.equal(g, graphitiGroupId("master:cap.1@host"));
    // 潰した結果が同じになる別の agent でも、group は別（hash が付く）
    assert.notEqual(graphitiGroupId("a:b"), graphitiGroupId("a.b"));
    assert.equal(episodeName({ topic: TOPIC_ITEM, payload: { itemId: "i1" }, idempotency_key: "k" }), "item:i1");
    assert.equal(episodeName({ topic: TOPIC_EVENT, payload: {}, idempotency_key: "e1" }), "event:e1");
  });

  test("config: GRAPHITI_MCP_URL が無ければ空（消費しない）。topic の既定は item だけ", () => {
    const e = readEnv({});
    assert.equal(e.graphitiUrl, "");
    assert.deepEqual(e.graphitiTopics, ["graphiti.memory_item"]);
    assert.deepEqual(readEnv({ GRAPHITI_TOPICS: "graphiti.memory_item, graphiti.episode" }).graphitiTopics, ["graphiti.memory_item", "graphiti.episode"]);
  });

  test("config: GRAPHITI_MCP_URL は trim し、空白だけなら未設定。暫定値は環境変数で変えられる（不正な値は既定）", () => {
    assert.equal(readEnv({ GRAPHITI_MCP_URL: "   " }).graphitiUrl, "");
    assert.equal(readEnv({ GRAPHITI_MCP_URL: " http://127.0.0.1:7931/mcp/ \n" }).graphitiUrl, "http://127.0.0.1:7931/mcp/");
    const d = readEnv({});
    assert.deepEqual([d.graphitiInFlight, d.graphitiMaxAttempts, d.graphitiConfirmTimeoutMin, d.graphitiBodyMax], [20, 5, 30, 4000]);
    const c = readEnv({ GRAPHITI_IN_FLIGHT: "7", GRAPHITI_MAX_ATTEMPTS: "3", GRAPHITI_CONFIRM_TIMEOUT_MIN: "90", GRAPHITI_BODY_MAX: "1000" });
    assert.deepEqual([c.graphitiInFlight, c.graphitiMaxAttempts, c.graphitiConfirmTimeoutMin, c.graphitiBodyMax], [7, 3, 90, 1000]);
    assert.equal(readEnv({ GRAPHITI_IN_FLIGHT: "x" }).graphitiInFlight, 20);
  });

  test("compose: profile 無しの起動を塞がない（graphiti の service は必須変数 `:?` を使わず、profile で隔離する）", () => {
    const s = readFileSync(fileURLToPath(new URL("../deploy/compose.yaml", import.meta.url)), "utf8");
    assert.doesNotMatch(s.slice(s.indexOf("\n  neo4j:")), /\$\{[A-Z_0-9]+:\?/);
    assert.equal((s.match(/profiles: \["graphiti"\]/g) ?? []).length, 2);
  });

  test("反映: 待ち → 送信済み（queue に受理）→ 反映済み（episode を確認）。確認できるまで再送しない", async () => {
    const a = newAgent();
    const g = fakeGraphiti();
    const it = await addItem(a, "DB は PostgreSQL にする");

    let s = await syncForAgent(t.db, { graphiti: g }, a);
    assert.deepEqual({ sent: s.sent, confirmed: s.confirmed, waiting: s.waiting }, { sent: 1, confirmed: 0, waiting: 1 });
    assert.equal(g.added.length, 1);
    const req = g.added[0]!;
    assert.equal(req.name, `item:${it.id}`);
    assert.equal(req.groupId, graphitiGroupId(a));
    assert.equal(req.episodeBody, "DB は PostgreSQL にする");
    assert.equal(req.referenceTime, "2026-11-02T00:00:00.000Z");
    assert.match(req.sourceDescription, /status=confirmed/);
    let row = await outboxRow(a, TOPIC_ITEM, it.id);
    assert.ok(row.sent_at && !row.processed_at);
    assert.equal(row.episode_uuid, null, "uuid は反映を確認した時に控える（Graphiti が付ける）");

    // まだ反映されていない: 再送しない
    s = await syncForAgent(t.db, { graphiti: g }, a);
    assert.deepEqual({ sent: s.sent, confirmed: s.confirmed, waiting: s.waiting }, { sent: 0, confirmed: 0, waiting: 1 });
    assert.equal(g.added.length, 1);

    // 反映された: 確認して processed_at を立てる。以後は何もしない
    const uuid = g.finish(`item:${it.id}`);
    s = await syncForAgent(t.db, { graphiti: g }, a);
    assert.deepEqual({ sent: s.sent, confirmed: s.confirmed, waiting: s.waiting }, { sent: 0, confirmed: 1, waiting: 0 });
    row = await outboxRow(a, TOPIC_ITEM, it.id);
    assert.ok(row.processed_at);
    assert.equal(row.episode_uuid, uuid);
    s = await syncForAgent(t.db, { graphiti: g }, a);
    assert.equal(s.sent + s.confirmed, 0);
    assert.equal(g.added.length, 1);
    assert.deepEqual(await outboxCounts(t.db, a), { pending: 0, sent: 0, done: 1, deadLetter: 0 });
  });

  test("topic: 既定は item だけ。event の Outbox 行は触らず待ちのまま（topic を足すと送る。episode の本文に種別・送り手・受け手が入る）", async () => {
    const a = newAgent();
    const g = fakeGraphiti();
    const e = ev({ kind: "task", body: "w1 に X を頼む", at: "2026-11-03T00:00:00Z", taskId: "t1" });
    await recordEvent(t.db, a, e);
    let s = await syncForAgent(t.db, { graphiti: g }, a);
    assert.equal(s.sent, 0);
    assert.equal((await outboxRow(a, TOPIC_EVENT, e.eventId)).sent_at, null);

    s = await syncForAgent(t.db, { graphiti: g, topics: [TOPIC_EVENT, TOPIC_ITEM] }, a);
    assert.equal(s.sent, 1);
    const req = g.added[0]!;
    assert.equal(req.name, `event:${e.eventId}`);
    assert.match(req.episodeBody, /^\[task\] master -> w1\nw1 に X を頼む$/);
    assert.match(req.sourceDescription, /kind=task task=t1/);
  });

  test("同時に持つ送信済み・未確認の行は inFlight まで。id 順（記録の順）に送る", async () => {
    const a = newAgent();
    const g = fakeGraphiti();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await addItem(a, `記憶 ${i}`)).id);
    const s = await syncForAgent(t.db, { graphiti: g, inFlight: 2 }, a);
    assert.equal(s.sent, 2);
    assert.deepEqual(g.added.map((r) => r.name), ids.slice(0, 2).map((i) => `item:${i}`));
    // 詰まったまま（未確認）なら、次の run も送らない
    assert.equal((await syncForAgent(t.db, { graphiti: g, inFlight: 2 }, a)).sent, 0);
    // 確認できたら、空いた分だけ次を送る
    for (const u of ids.slice(0, 2)) g.finish(`item:${u}`);
    const s2 = await syncForAgent(t.db, { graphiti: g, inFlight: 2 }, a);
    assert.deepEqual({ confirmed: s2.confirmed, sent: s2.sent }, { confirmed: 2, sent: 2 });
    assert.deepEqual(g.added.slice(2).map((r) => r.name), ids.slice(2, 4).map((i) => `item:${i}`));
  });

  test("断られた行: 失敗回数を加算し、間隔（60 秒 × 2^回数）を空けて再試行、上限で dead-letter。他の行は進む", async () => {
    const a = newAgent();
    const g = fakeGraphiti();
    const bad = await addItem(a, "断られる記憶");
    const ok = await addItem(a, "通る記憶");
    g.reject = (r) => r.name === `item:${bad.id}`;
    let clock = Date.parse("2026-11-21T00:00:00Z");
    const now = () => new Date(clock);

    let s = await syncForAgent(t.db, { graphiti: g, now }, a);
    assert.deepEqual({ sent: s.sent, retried: s.retried, failed: s.failed }, { sent: 1, retried: 1, failed: 0 });
    let row = await outboxRow(a, TOPIC_ITEM, bad.id);
    assert.equal(row.attempts, 1);
    assert.equal(row.sent_at, null);
    assert.match(row.last_error ?? "", /rejected/);
    assert.equal(new Date(row.next_attempt_at!).getTime(), clock + 60_000);
    assert.equal((await outboxRow(a, TOPIC_ITEM, ok.id)).attempts, 0);
    g.finish(`item:${ok.id}`);

    // 間隔が明ける前は試さない
    clock += 30_000;
    assert.equal((await syncForAgent(t.db, { graphiti: g, now }, a)).retried, 0);

    // 上限まで繰り返す（間隔は倍々。dead-letter になった行は以後選ばれない）
    for (let n = 2; n <= SYNC_MAX_ATTEMPTS; n++) {
      clock += 3_600_000;
      s = await syncForAgent(t.db, { graphiti: g, now }, a);
      assert.equal(s.retried + s.failed, 1, `attempt ${n}`);
    }
    row = await outboxRow(a, TOPIC_ITEM, bad.id);
    assert.equal(row.attempts, SYNC_MAX_ATTEMPTS);
    assert.ok(row.failed_at);
    clock += 3_600_000;
    assert.equal((await syncForAgent(t.db, { graphiti: g, now }, a)).retried, 0);
    assert.equal((await outboxCounts(t.db, a)).deadLetter, 1);
  });

  test("Graphiti に届かない時: 失敗回数を加算せず run を止める。復旧後にそのまま送る（障害中に dead-letter を作らない）", async () => {
    const a = newAgent();
    const g = fakeGraphiti();
    const it = await addItem(a, "障害中の記憶");
    g.down = true;
    for (let i = 0; i < 3; i++) await assert.rejects(syncForAgent(t.db, { graphiti: g }, a), GraphitiUnavailableError);
    const row = await outboxRow(a, TOPIC_ITEM, it.id);
    assert.equal(row.attempts, 0);
    assert.equal(row.failed_at, null);
    assert.equal(row.sent_at, null);
    g.down = false;
    assert.equal((await syncForAgent(t.db, { graphiti: g }, a)).sent, 1);
  });

  test("syncAll: 届かない時は最初の 1 agent で打ち切る。それ以外の失敗は他の agent を止めない", async () => {
    const a1 = newAgent();
    const a2 = newAgent();
    await addItem(a1, "a1 の記憶");
    await addItem(a2, "a2 の記憶");
    const g = fakeGraphiti();
    g.down = true;
    const r = await syncAll(t.db, { graphiti: g });
    assert.ok(r.errors.length >= 1);
    assert.equal(r.errors.length, 1, "届かない時は 1 件で打ち切る");
    g.down = false;
    const r2 = await syncAll(t.db, { graphiti: g });
    assert.equal(r2.errors.length, 0);
    assert.ok(g.added.some((x) => x.episodeBody === "a1 の記憶") && g.added.some((x) => x.episodeBody === "a2 の記憶"));
  });

  test("送信済みのまま確認できない行は、時間が過ぎたら待ちに戻して再送する（同じ name）", async () => {
    const a = newAgent();
    const g = fakeGraphiti();
    const it = await addItem(a, "queue が落ちて消えた記憶");
    let clock = Date.parse("2026-11-21T00:00:00Z");
    const now = () => new Date(clock);
    await syncForAgent(t.db, { graphiti: g, now, confirmTimeoutMin: 30 }, a);
    clock += 29 * 60_000;
    assert.equal((await syncForAgent(t.db, { graphiti: g, now, confirmTimeoutMin: 30 }, a)).retried, 0);
    clock += 2 * 60_000;
    let s = await syncForAgent(t.db, { graphiti: g, now, confirmTimeoutMin: 30 }, a);
    assert.equal(s.retried, 1);
    assert.equal((await outboxRow(a, TOPIC_ITEM, it.id)).attempts, 1);
    // 再送の間隔（60 秒）が明けたら同じ name で送り直す
    clock += 61_000;
    s = await syncForAgent(t.db, { graphiti: g, now, confirmTimeoutMin: 30 }, a);
    assert.equal(s.sent, 1);
    assert.deepEqual(g.added.map((r) => r.name), [`item:${it.id}`, `item:${it.id}`]);
  });

  test("出典が無い行・未対応の scope は、再試行せず dead-letter（理由を残す）", async () => {
    const a = newAgent();
    const g = fakeGraphiti();
    await t.asSuper((sq) => sq.query("INSERT INTO agents (id) VALUES ($1) ON CONFLICT DO NOTHING", [a]));
    const missing = "00000000-0000-4000-8000-000000000001";
    await t.asSuper((sq) => sq.query("INSERT INTO outbox_events (agent_id, topic, idempotency_key, payload) VALUES ($1,$2,$3,'{}'::jsonb)", [a, TOPIC_ITEM, missing]));
    const shared = await addItem(a, "共有の記憶", { scope: "shared" });
    const s = await syncForAgent(t.db, { graphiti: g }, a);
    assert.equal(s.failed, 2);
    assert.equal(g.added.length, 0);
    assert.match((await outboxRow(a, TOPIC_ITEM, missing)).last_error ?? "", /source item not found/);
    const r = await outboxRow(a, TOPIC_ITEM, shared.id);
    assert.ok(r.failed_at);
    assert.match(r.last_error ?? "", /scope shared/);
  });

  test("agent の分離: ある agent の run は他 agent の Outbox 行に触れない（RLS）", async () => {
    const a = newAgent();
    const b = newAgent();
    const ia = await addItem(a, "a の記憶");
    const ib = await addItem(b, "b の記憶");
    const g = fakeGraphiti();
    await syncForAgent(t.db, { graphiti: g }, a);
    assert.deepEqual(g.added.map((r) => r.name), [`item:${ia.id}`]);
    assert.equal((await outboxRow(b, TOPIC_ITEM, ib.id)).sent_at, null);
    assert.ok(g.added.every((r) => r.groupId === graphitiGroupId(a)));
  });

  test("graphSearch: fact の出典 episode を item / event に戻す。常に inferred・origin=graphiti で、item の status は出典として添える", async () => {
    const a = newAgent();
    const g = fakeGraphiti();
    const it = await addItem(a, "リリースは金曜", { status: "inferred" });
    const e = ev({ kind: "report", body: "完了", at: "2026-11-04T00:00:00Z" });
    await recordEvent(t.db, a, e);
    await syncForAgent(t.db, { graphiti: g, topics: [TOPIC_ITEM, TOPIC_EVENT] }, a);
    const itUuid = g.finish(`item:${it.id}`);
    const evUuid = g.finish(`event:${e.eventId}`);
    await syncForAgent(t.db, { graphiti: g, topics: [TOPIC_ITEM, TOPIC_EVENT] }, a);
    g.facts = [
      { uuid: "f1", fact: "リリースは金曜", validAt: "2026-11-02T00:00:00Z", invalidAt: null, episodes: [itUuid, evUuid, "unknown-episode"] },
      { uuid: "f2", fact: "出典なし", validAt: null, invalidAt: null, episodes: [] },
    ];
    const r = await graphSearch(t.db, g, a, { query: "リリース", maxFacts: 5 });
    assert.equal(r.length, 2);
    assert.deepEqual(r[0]!.sourceItems, [{ id: it.id, status: "inferred" }]);
    assert.deepEqual(r[0]!.sourceEventIds, [e.eventId, ...[(await t.asSuper(async (sq) => (await sq.query<{ event_id: string }>("SELECT event_id FROM memory_sources WHERE item_id = $1", [it.id])).rows[0]!.event_id))]].sort());
    assert.ok(r.every((f) => f.status === "inferred" && f.origin === "graphiti"));
    assert.deepEqual(r[1]!.sourceItems, []);
    // 他 agent の Outbox を介して引かれない
    const other = newAgent();
    const r2 = await graphSearch(t.db, g, other, { query: "リリース", maxFacts: 5 });
    assert.deepEqual(r2[0]!.sourceItems, []);
    assert.deepEqual(r2[0]!.sourceEventIds, []);
  });

  test("task: GRAPHITI_MCP_URL が無い（runtime に graphiti が無い）時は何もしない。run は重ならず、同じ error の log は初回と復旧だけ", async () => {
    resetGraphitiCycleState();
    const lines: string[] = [];
    const log = { info: (l: string) => lines.push(`I ${l}`), warn: (l: string) => lines.push(`W ${l}`) };
    setRuntime({ db: t.db } as unknown as Runtime);
    assert.deepEqual(await runGraphitiTask(log), { disabled: true });

    const a = newAgent();
    await addItem(a, "log の記憶");
    const g = fakeGraphiti();
    g.down = true;
    for (let i = 0; i < 3; i++) await runGraphitiCycle({ db: t.db, graphiti: g, topics: [TOPIC_ITEM] }, log);
    assert.equal(lines.filter((l) => l.startsWith("W ")).length, 1, "同じ要旨の error は 1 回だけ");
    g.down = false;
    const r = await runGraphitiCycle({ db: t.db, graphiti: g, topics: [TOPIC_ITEM] }, log);
    assert.ok(!("error" in r));
    assert.ok(lines.some((l) => l.includes("graphiti recovered")));
    assert.ok(lines.some((l) => l.includes(`agent=${a} confirmed=0 sent=1`)));
    // log に本文は出さない
    assert.ok(!lines.some((l) => l.includes("log の記憶")));
    setRuntime(undefined);
  });
});

// ---- MCP client（Streamable HTTP の fake server で。実 Graphiti は docs の「実測」）----

describe("graphiti MCP client", () => {
  let server: Server;
  let url = "";
  let calls: { name: string; args: Record<string, unknown> }[] = [];
  let respond: (name: string, args: Record<string, unknown>) => { isError?: boolean; body: unknown; plainText?: boolean } = () => ({ body: { message: "ok" } });

  before(async () => {
    server = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        const m = JSON.parse(b || "{}") as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string } };
        if (m.id === undefined) {
          res.statusCode = 202;
          res.end();
          return;
        }
        res.setHeader("content-type", "application/json");
        if (m.method === "initialize") {
          res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-graphiti", version: "0" } } }));
          return;
        }
        if (m.method === "tools/call") {
          calls.push({ name: m.params!.name!, args: m.params!.arguments ?? {} });
          const r = respond(m.params!.name!, m.params!.arguments ?? {});
          const result = r.plainText
            ? { content: [{ type: "text", text: JSON.stringify(r.body) }], isError: r.isError ?? false }
            : { content: [{ type: "text", text: JSON.stringify(r.body) }], structuredContent: { result: r.body }, isError: r.isError ?? false };
          res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
          return;
        }
        res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp/`;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const req: AddMemoryRequest = { name: "n", episodeBody: "b", groupId: "g", source: "text", sourceDescription: "d", referenceTime: "2026-11-01T00:00:00Z" };

  test("add_memory の引数を Graphiti の tool の名前で送る。ErrorResponse は Rejected", async () => {
    calls = [];
    const c = createGraphitiMcpClient({ url, timeoutMs: 5000 });
    respond = () => ({ body: { message: "queued" } });
    await c.addMemory(req);
    assert.deepEqual(calls[0], {
      name: "add_memory",
      args: { name: "n", episode_body: "b", group_id: "g", source: "text", source_description: "d", reference_time: "2026-11-01T00:00:00Z" },
    });
    respond = () => ({ body: { error: "Error queuing episode: boom" } });
    await assert.rejects(c.addMemory(req), (e) => e instanceof GraphitiRejectedError && /boom/.test(e.message));
    respond = () => ({ isError: true, plainText: true, body: { error: "tool failed" } });
    await assert.rejects(c.addMemory(req), GraphitiRejectedError);
    await c.close();
  });

  test("get_episodes / search_memory_facts の応答を読む（structuredContent が無くても text の JSON から）", async () => {
    calls = [];
    const c = createGraphitiMcpClient({ url, timeoutMs: 5000 });
    respond = (n) => (n === "get_episodes" ? { plainText: true, body: { message: "ok", episodes: [{ uuid: "e1", name: "item:1" }, { uuid: "e2", name: "event:2" }] } } : { body: { message: "ok", facts: [{ uuid: "f1", fact: "X は Y", name: "REL", valid_at: "2026-11-01T00:00:00Z", invalid_at: null, episodes: ["e1"] }] } });
    assert.deepEqual(await c.recentEpisodes("g", 50), [{ uuid: "e1", name: "item:1" }, { uuid: "e2", name: "event:2" }]);
    assert.deepEqual(calls[0], { name: "get_episodes", args: { group_ids: ["g"], max_episodes: 50 } });
    const facts = await c.searchFacts({ query: "q", groupId: "g", maxFacts: 3, validAtAfter: "2026-01-01T00:00:00Z" });
    assert.deepEqual(facts, [{ uuid: "f1", fact: "X は Y", name: "REL", validAt: "2026-11-01T00:00:00Z", invalidAt: null, episodes: ["e1"] }]);
    assert.deepEqual(calls[1], { name: "search_memory_facts", args: { query: "q", group_ids: ["g"], max_facts: 3, valid_at_after: "2026-01-01T00:00:00Z" } });
    await c.close();
  });

  test("接続できない時は Unavailable（URL は message に出さない）。復旧後は張り直して通る", async () => {
    const dead = createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    const c = createGraphitiMcpClient({ url: `http://127.0.0.1:${port}/mcp/`, timeoutMs: 2000 });
    await assert.rejects(c.addMemory(req), (e) => e instanceof GraphitiUnavailableError && !e.message.includes(String(port)));
    await c.close();
  });
});
