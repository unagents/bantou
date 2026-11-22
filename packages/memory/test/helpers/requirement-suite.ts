// 作業指示（requirement）と仕様・設計の test の本体（PGlite 版と docker の実 PostgreSQL 版で共有）。
// 設計: docs/design/memory-requirement-spec.md。LLM は偽（fakeChat）。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fakeChat, fakeEmbedder, ev, type TestDb } from "./fakes.ts";
import { recordEvent } from "../../server/utils/events.ts";
import { extractForAgent, CANDIDATE_JSON_SCHEMA } from "../../server/utils/extract.ts";
import { embedPending } from "../../server/utils/embed.ts";
import { buildContext, explain, recall, type RecordNode } from "../../server/utils/recall.ts";

type Row = Record<string, unknown>;
const UUID = "00000000-0000-4000-8000-000000000001";

export function defineRequirementSuite(make: () => Promise<TestDb>): void {
  let t!: TestDb;
  const emb = fakeEmbedder();
  before(async () => {
    t = await make();
  });
  after(async () => {
    await t.close();
  });

  let seq = 0;
  const newAgent = () => `req-agent-${process.pid}-${++seq}`;

  const rec = (r: Partial<Row> & { ref: string; content: string; sourceEventIds: string[] }) => ({
    parentRef: null, parentId: null, role: "requirement", category: "feature", origin: "user", status: "confirmed", validFrom: null, ...r,
  });
  const spec = (r: Partial<Row> & { ref: string; content: string; sourceEventIds: string[] }) => ({
    parentRef: null, parentId: null, categories: [], basis: "user", requirementRefs: [], requirementIds: [], status: "confirmed", validFrom: null, ...r,
  });

  async function run(agent: string, chat: ReturnType<typeof fakeChat>) {
    const s = await extractForAgent(t.db, { chat, batchSize: 50 }, agent);
    await embedPending(t.db, agent, emb);
    return s;
  }
  const items = (agent: string, where = "true") =>
    t.asSuper(async (sq) => (await sq.query<Row>(`SELECT * FROM memory_items WHERE agent_id = $1 AND record_type IS NOT NULL AND ${where} ORDER BY created_at, content`, [agent])).rows);
  const byContent = (rows: Row[], content: string) => {
    const r = rows.find((x) => x.content === content);
    assert.ok(r, `item not found: ${content}`);
    return r;
  };

  test("1 つの発言に複数の作業指示が混ざる: requirement が分かれて木になり、仕様・設計と紐付く（偽の LLM）", async () => {
    const a = newAgent();
    await recordEvent(t.db, a, ev({
      eventId: `${a}-u1`,
      body: "memory に requirement の型を足して。あと center の remote_send に親の id を渡せるようにして。設計は requirement を parent_id の木にして、API は recall の引数に recordType を足す。",
    }));
    const chat = fakeChat(() => ({
      candidates: [],
      requirements: [
        rec({ ref: "r1", content: "memory に requirement の型を足す", category: "feature", sourceEventIds: [`${a}-u1`] }),
        rec({ ref: "r2", content: "center の remote_send に親の id を渡せるようにする", category: "feature", sourceEventIds: [`${a}-u1`] }),
        rec({ ref: "t1", parentRef: "r1", role: "task", content: "migration を書く", origin: "agent", status: "inferred", sourceEventIds: [`${a}-u1`] }),
      ],
      specs: [
        spec({ ref: "s1", content: "requirement は parent_id の木にし、recall の引数に recordType を足す", categories: ["data", "presentation"], requirementRefs: ["r1", "r2"], sourceEventIds: [`${a}-u1`] }),
        spec({ ref: "s2", parentRef: "s1", content: "木の深さは 8 までにする（エージェントの判断）", categories: ["business"], basis: "agent", status: "inferred", sourceEventIds: [`${a}-u1`] }),
      ],
    }));
    const s = await run(a, chat);
    assert.equal(s.accepted, 5);
    const rows = await items(a);
    const r1 = byContent(rows, "memory に requirement の型を足す");
    const r2 = byContent(rows, "center の remote_send に親の id を渡せるようにする");
    const t1 = byContent(rows, "migration を書く");
    // 別々の requirement（1 登録 = 1 作業）で、利用者の発言由来・確定
    assert.notEqual(r1.id, r2.id);
    for (const r of [r1, r2]) {
      assert.equal(r.record_type, "requirement");
      assert.equal(r.origin, "user");
      assert.equal(r.role, "requirement");
      assert.equal(r.status, "confirmed");
      assert.equal(r.parent_id, null);
    }
    // タスクは requirement の子（role で区別）。推測
    assert.equal(t1.parent_id, r1.id);
    assert.equal(t1.role, "task");
    assert.equal(t1.status, "inferred");
    // 仕様・設計: 利用者の仕様は 1 件にまとまり、category は複数。エージェントの設計は子で basis=agent・推測
    const s1 = byContent(rows, "requirement は parent_id の木にし、recall の引数に recordType を足す");
    const s2 = byContent(rows, "木の深さは 8 までにする（エージェントの判断）");
    assert.equal(s1.record_type, "spec_design");
    assert.equal(s1.basis, "user");
    assert.deepEqual(s1.spec_categories, ["data", "presentation"]);
    assert.equal(s1.status, "confirmed");
    assert.equal(s2.parent_id, s1.id);
    assert.equal(s2.basis, "agent");
    assert.equal(s2.status, "inferred");
    // requirement ↔ 仕様・設計の紐付け（多対多。親子ではない）
    const rel = await t.asSuper(async (sq) => (await sq.query<{ from_id: string; to_id: string; relation: string }>("SELECT from_id, to_id, relation FROM memory_relations WHERE agent_id = $1 ORDER BY from_id", [a])).rows);
    assert.deepEqual(rel.map((x) => [x.from_id, x.to_id, x.relation]).sort(), [[r1.id, s1.id, "has_spec"], [r2.id, s1.id, "has_spec"]].sort());
    assert.equal(s1.parent_id, null);
    // 出典と Outbox は従来の経路
    const src = await t.asSuper(async (sq) => (await sq.query<{ c: string }>("SELECT count(*)::text AS c FROM memory_sources WHERE agent_id = $1", [a])).rows[0]!.c);
    assert.equal(src, "5");
    const ob = await t.asSuper(async (sq) => (await sq.query<{ c: string }>("SELECT count(*)::text AS c FROM outbox_events WHERE agent_id = $1 AND topic = 'graphiti.memory_item'", [a])).rows[0]!.c);
    assert.equal(ob, "5");
    // LLM への指示に、分け方と schema の項目が入っている
    assert.match(chat.requests[0]!.system, /1 件 = 1 作業/);
    assert.deepEqual((CANDIDATE_JSON_SCHEMA.required as readonly string[]).slice().sort(), ["candidates", "requirements", "specs"]);
  });

  test("親が子より後ろに書かれていても、循環・未知の ref があっても落ちずに木にする", async () => {
    const a = newAgent();
    await recordEvent(t.db, a, ev({ eventId: `${a}-u1`, body: "A をして、その中で B をして" }));
    const chat = fakeChat(() => ({
      candidates: [],
      requirements: [
        rec({ ref: "child", parentRef: "root", content: "B をする", sourceEventIds: [`${a}-u1`] }),
        rec({ ref: "root", content: "A をする", sourceEventIds: [`${a}-u1`] }),
        rec({ ref: "x", parentRef: "y", content: "循環 x", sourceEventIds: [`${a}-u1`] }),
        rec({ ref: "y", parentRef: "x", content: "循環 y", sourceEventIds: [`${a}-u1`] }),
        rec({ ref: "z", parentRef: "nothing", content: "未知の親", sourceEventIds: [`${a}-u1`] }),
      ],
      specs: [],
    }));
    const s = await run(a, chat);
    assert.equal(s.accepted, 5);
    const rows = await items(a);
    assert.equal(byContent(rows, "B をする").parent_id, byContent(rows, "A をする").id);
    assert.equal(byContent(rows, "未知の親").parent_id, null);
  });

  test("remote_send の親の id（parentRequirementId）: task event の requirement はその親の子になり、task_id を持つ（agent 起点・推測）", async () => {
    const a = newAgent();
    await recordEvent(t.db, a, ev({ eventId: `${a}-u1`, body: "個別PM に設計書を作らせて", at: "2026-11-01T00:00:00Z" }));
    await run(a, fakeChat(() => ({ candidates: [], requirements: [rec({ ref: "r", content: "個別PM に設計書を作らせる", category: "docs", sourceEventIds: [`${a}-u1`] })], specs: [] })));
    const parent = byContent(await items(a), "個別PM に設計書を作らせる");
    await recordEvent(t.db, a, { ...ev({ eventId: `${a}-t1`, kind: "task", taskId: "t-abc-123", remoteId: "c-1", body: "goal: 設計書を作る", at: "2026-11-01T00:05:00Z" }), parentRequirementId: parent.id as string });
    const stored = await t.asSuper(async (sq) => (await sq.query<{ parent_requirement_id: string | null }>("SELECT parent_requirement_id FROM memory_events WHERE agent_id = $1 AND event_id = $2", [a, `${a}-t1`])).rows[0]!.parent_requirement_id);
    assert.equal(stored, parent.id);
    // LLM は親を何も言わない（parentRef / parentId とも null）。親は渡された id から決まる
    const chat = fakeChat(() => ({
      candidates: [],
      requirements: [rec({ ref: "r", content: "remote-cap に設計書を作らせる", origin: "agent", category: "docs", status: "inferred", sourceEventIds: [`${a}-t1`] })],
      specs: [],
    }));
    await run(a, chat);
    // event の parentRequirementId が LLM への入力にも出る
    assert.match(chat.requests[0]!.user, new RegExp(`"parentRequirementId":"${parent.id}"`));
    const child = byContent(await items(a), "remote-cap に設計書を作らせる");
    assert.equal(child.parent_id, parent.id);
    assert.equal(child.task_id, "t-abc-123");
    assert.equal(child.origin, "agent");
    assert.equal(child.status, "inferred");
  });

  test("親の id が渡されない時: 直近の利用者の requirement（openRequirements）から LLM が選ぶ。存在しない id・他 agent の id は無視する", async () => {
    const a = newAgent();
    const b = newAgent();
    await recordEvent(t.db, a, ev({ eventId: `${a}-u1`, body: "設計書を作って" }));
    await recordEvent(t.db, b, ev({ eventId: `${b}-u1`, body: "別の agent の依頼" }));
    await run(a, fakeChat(() => ({ candidates: [], requirements: [rec({ ref: "r", content: "設計書を作る", sourceEventIds: [`${a}-u1`] })], specs: [] })));
    await run(b, fakeChat(() => ({ candidates: [], requirements: [rec({ ref: "r", content: "別の agent の依頼を実施する", sourceEventIds: [`${b}-u1`] })], specs: [] })));
    const mine = byContent(await items(a), "設計書を作る");
    const theirs = byContent(await items(b), "別の agent の依頼を実施する");
    await recordEvent(t.db, a, ev({ eventId: `${a}-t1`, kind: "task", taskId: "t-1", body: "設計書を作る goal", at: "2026-11-01T00:10:00Z" }));
    await recordEvent(t.db, a, ev({ eventId: `${a}-t2`, kind: "task", taskId: "t-2", body: "別の goal", at: "2026-11-01T00:11:00Z" }));
    await recordEvent(t.db, a, ev({ eventId: `${a}-t3`, kind: "task", taskId: "t-3", body: "さらに別の goal", at: "2026-11-01T00:12:00Z" }));
    const chat = fakeChat((req) => {
      const open = (JSON.parse(req.user) as { openRequirements?: { id: string }[] }).openRequirements ?? [];
      assert.deepEqual(open.map((x) => x.id), [mine.id]); // 自分の agent の利用者の requirement だけが選択肢に出る
      return {
        candidates: [],
        requirements: [
          rec({ ref: "a", parentId: mine.id, content: "task 1 の requirement", origin: "agent", status: "inferred", sourceEventIds: [`${a}-t1`] }),
          rec({ ref: "b", parentId: UUID, content: "task 2 の requirement", origin: "agent", status: "inferred", sourceEventIds: [`${a}-t2`] }),
          rec({ ref: "c", parentId: theirs.id as string, content: "task 3 の requirement", origin: "agent", status: "inferred", sourceEventIds: [`${a}-t3`] }),
        ],
        specs: [],
      };
    });
    await run(a, chat);
    const rows = await items(a);
    assert.equal(byContent(rows, "task 1 の requirement").parent_id, mine.id);
    assert.equal(byContent(rows, "task 2 の requirement").parent_id, null);
    assert.equal(byContent(rows, "task 3 の requirement").parent_id, null);
  });

  test("起点と推測: 利用者の発言が出典に無い origin=user は agent に直す。LLM が confirmed と言っても、出典が task event なら inferred", async () => {
    const a = newAgent();
    await recordEvent(t.db, a, ev({ eventId: `${a}-t1`, kind: "task", taskId: "t-9", body: "goal" }));
    await recordEvent(t.db, a, ev({ eventId: `${a}-u1`, body: "設計は A 案で" }));
    await run(a, fakeChat(() => ({
      candidates: [],
      requirements: [rec({ ref: "r", content: "task event 由来の指示", origin: "user", status: "confirmed", sourceEventIds: [`${a}-t1`] })],
      specs: [spec({ ref: "s", content: "task event 由来の設計", basis: "user", status: "confirmed", categories: ["business"], sourceEventIds: [`${a}-t1`] }),
        spec({ ref: "s2", content: "利用者が言った設計は A 案", basis: "user", status: "confirmed", categories: ["business"], sourceEventIds: [`${a}-u1`] })],
    })));
    const rows = await items(a);
    const r = byContent(rows, "task event 由来の指示");
    assert.equal(r.origin, "agent");
    assert.equal(r.status, "inferred");
    assert.equal(byContent(rows, "task event 由来の設計").basis, "agent");
    assert.equal(byContent(rows, "利用者が言った設計は A 案").basis, "user");
    assert.equal(byContent(rows, "利用者が言った設計は A 案").status, "confirmed");
  });

  test("同文の畳み込み: 同じ親の下の同じ requirement は 1 件、別の親の下には出せる。従来の記憶は record_type 無しのまま畳まれる", async () => {
    const a = newAgent();
    await recordEvent(t.db, a, ev({ eventId: `${a}-u1`, body: "X と Y をして" }));
    const first = fakeChat(() => ({
      candidates: [{ memoryType: "semantic", content: "従来の記憶", status: "confirmed", sourceEventIds: [`${a}-u1`], validFrom: null }],
      requirements: [
        rec({ ref: "p1", content: "親 1", sourceEventIds: [`${a}-u1`] }),
        rec({ ref: "p2", content: "親 2", sourceEventIds: [`${a}-u1`] }),
        rec({ ref: "c1", parentRef: "p1", role: "task", content: "テストを書く", sourceEventIds: [`${a}-u1`] }),
        rec({ ref: "c2", parentRef: "p2", role: "task", content: "テストを書く", sourceEventIds: [`${a}-u1`] }),
        rec({ ref: "c3", parentRef: "p1", role: "task", content: "テストを書く", sourceEventIds: [`${a}-u1`] }),
        rec({ ref: "c4", parentRef: "c3", role: "task", content: "孫", sourceEventIds: [`${a}-u1`] }),
      ],
      specs: [],
    }));
    const s = await run(a, first);
    assert.equal(s.accepted, 6); // 従来 1 + 親 2 + テスト 2 + 孫 1
    assert.equal(s.rejected, 1); // c3 は c1 と同じ親・同じ本文
    const rows = await items(a);
    const tests = rows.filter((x) => x.content === "テストを書く");
    assert.equal(tests.length, 2);
    assert.notEqual(tests[0]!.parent_id, tests[1]!.parent_id);
    // 重複した c3 に付けた孫は、既存の c1 の子になる
    assert.equal(byContent(rows, "孫").parent_id, tests.find((x) => x.parent_id === byContent(rows, "親 1").id)!.id);
    const plain = await t.asSuper(async (sq) => (await sq.query<Row>("SELECT record_type FROM memory_items WHERE agent_id = $1 AND content = '従来の記憶'", [a])).rows);
    assert.deepEqual(plain.map((x) => x.record_type), [null]);
  });

  test("content の上限: 仕様・設計は 8000 文字まで、requirement は 2000 文字まで（DB の CHECK も同じ）", async () => {
    const a = newAgent();
    await recordEvent(t.db, a, ev({ eventId: `${a}-u1`, body: "長い設計" }));
    const long = "あ".repeat(5000);
    const s = await run(a, fakeChat(() => ({
      candidates: [],
      requirements: [rec({ ref: "r", content: long, sourceEventIds: [`${a}-u1`] })],
      specs: [spec({ ref: "s", content: long, categories: ["data"], sourceEventIds: [`${a}-u1`] })],
    })));
    assert.equal(s.accepted, 1);
    assert.equal(s.rejected, 1);
    assert.equal((await items(a)).length, 1);
    await assert.rejects(t.asSuper((sq) => sq.query("INSERT INTO agents (id) VALUES ($1) ON CONFLICT DO NOTHING", [a]).then(() =>
      sq.query("INSERT INTO memory_items (agent_id, memory_type, content, content_norm, status) VALUES ($1,'semantic',$2,$2,'confirmed')", [a, long]))));
  });

  test("DB の規則: 型ごとの列の組み合わせ・category の値・basis / origin の値を CHECK が守る", async () => {
    const a = newAgent();
    await t.asSuper((sq) => sq.query("INSERT INTO agents (id) VALUES ($1) ON CONFLICT DO NOTHING", [a]));
    const ins = (cols: string, vals: unknown[]) =>
      t.asSuper((sq) => sq.query(`INSERT INTO memory_items (agent_id, memory_type, content, content_norm, status, ${cols}) VALUES ($1,'episodic',$2,$2,'confirmed', ${vals.map((_, i) => `$${i + 3}`).join(",")})`, [a, `c-${Math.random()}`, ...vals]));
    await ins("record_type, origin, role, category", ["requirement", "user", "requirement", "なんでも自由な文字列"]); // category は固定しない
    await assert.rejects(ins("record_type, origin, role", ["requirement", "user", "bogus"]));
    await assert.rejects(ins("record_type", ["unknown"]));
    await assert.rejects(ins("record_type, basis, spec_categories", ["spec_design", "agent", ["nonsense"]]));
    await assert.rejects(ins("record_type, basis", ["spec_design", "both"])); // 種類は 2 値
    await assert.rejects(ins("record_type", ["requirement"])); // requirement は origin・role が要る
    await assert.rejects(ins("role", ["task"])); // record_type 無しに role は付けられない
    await ins("record_type, basis, spec_categories", ["spec_design", "user", ["presentation", "business", "data", "infrastructure", "cross-cutting"]]);
  });

  test("recall: recordType・category で絞れ、結果に型・親・紐付きが付く。省略時は従来どおり（従来の記憶の項目は変わらない）", async () => {
    const a = newAgent();
    await recordEvent(t.db, a, ev({ eventId: `${a}-u1`, body: "リスト画面を作り、DB を設計して" }));
    await run(a, fakeChat(() => ({
      candidates: [{ memoryType: "semantic", content: "リスト画面は一覧表示の方針", status: "confirmed", sourceEventIds: [`${a}-u1`], validFrom: null }],
      requirements: [
        rec({ ref: "r1", content: "リスト画面を作る", category: "feature", sourceEventIds: [`${a}-u1`] }),
        rec({ ref: "r2", content: "リスト画面の DB を設計する", category: "docs", sourceEventIds: [`${a}-u1`] }),
      ],
      specs: [spec({ ref: "s1", content: "リスト画面は一覧表示し、DB は items 表に持つ", categories: ["presentation", "data"], requirementRefs: ["r1", "r2"], sourceEventIds: [`${a}-u1`] })],
    })));
    const all = await recall(t.db, emb, a, { query: "リスト画面" });
    assert.equal(all.length, 4);
    const plain = all.find((x) => x.content === "リスト画面は一覧表示の方針")!;
    assert.deepEqual(Object.keys(plain).sort(), ["content", "id", "memoryType", "relevance", "sourceEventIds", "status"].sort());
    const reqs = await recall(t.db, emb, a, { query: "リスト画面", recordType: "requirement" });
    assert.deepEqual(reqs.map((x) => x.content).sort(), ["リスト画面の DB を設計する", "リスト画面を作る"]);
    assert.ok(reqs.every((x) => x.recordType === "requirement" && x.origin === "user" && x.role === "requirement"));
    const docs = await recall(t.db, emb, a, { query: "リスト画面", recordType: "requirement", category: "docs" });
    assert.deepEqual(docs.map((x) => x.content), ["リスト画面の DB を設計する"]);
    const sp = await recall(t.db, emb, a, { query: "リスト画面", category: "data" });
    assert.equal(sp.length, 1);
    assert.equal(sp[0]!.recordType, "spec_design");
    assert.deepEqual(sp[0]!.categories, ["presentation", "data"]);
    assert.equal(sp[0]!.basis, "user");
    assert.equal(sp[0]!.relatedIds!.length, 2); // 紐付く requirement
    assert.deepEqual(sp[0]!.relatedIds!.slice().sort(), reqs.map((x) => x.id).sort());
    assert.deepEqual(reqs.map((x) => x.relatedIds), [[sp[0]!.id], [sp[0]!.id]]);
    // explain も型の項目を返す
    const ex = await explain(t.db, a, { id: sp[0]!.id });
    assert.equal(ex.item.recordType, "spec_design");
  });

  test("recall: エージェントの設計（inferred）は既定で出ず、includeInferred で出る", async () => {
    const a = newAgent();
    await recordEvent(t.db, a, ev({ eventId: `${a}-u1`, body: "検索機能の設計" }));
    await recordEvent(t.db, a, ev({ eventId: `${a}-as1`, kind: "assistant_message", body: "検索は全文検索にしました", at: "2026-11-01T00:01:00Z" }));
    await run(a, fakeChat(() => ({
      candidates: [],
      requirements: [],
      specs: [
        spec({ ref: "s1", content: "検索機能は利用者の指定どおり", categories: ["business"], sourceEventIds: [`${a}-u1`] }),
        spec({ ref: "s2", parentRef: "s1", content: "検索機能は全文検索で実装する", categories: ["data"], basis: "agent", status: "inferred", sourceEventIds: [`${a}-as1`] }),
      ],
    })));
    const def = await recall(t.db, emb, a, { query: "検索機能", recordType: "spec_design" });
    assert.deepEqual(def.map((x) => x.content), ["検索機能は利用者の指定どおり"]);
    const inf = await recall(t.db, emb, a, { query: "検索機能", recordType: "spec_design", includeInferred: true });
    assert.equal(inf.length, 2);
    assert.equal(inf.find((x) => x.basis === "agent")!.status, "inferred");
    assert.equal(inf.find((x) => x.basis === "agent")!.parentId, def[0]!.id);
  });

  test("context: openRequirements は木で、結果が返った task は消え、従来の policies には混ざらない。specs は木で inferred を明示", async () => {
    const a = newAgent();
    await recordEvent(t.db, a, ev({ eventId: `${a}-u1`, body: "A をして、B をして。設計は C", at: "2026-11-01T00:00:00Z" }));
    await recordEvent(t.db, a, ev({ eventId: `${a}-t1`, kind: "task", taskId: "t-open", body: "A の goal", at: "2026-11-01T00:01:00Z" }));
    await recordEvent(t.db, a, ev({ eventId: `${a}-t2`, kind: "task", taskId: "t-done", body: "B の goal", at: "2026-11-01T00:02:00Z" }));
    await recordEvent(t.db, a, ev({ eventId: `${a}-r2`, kind: "result", taskId: "t-done", body: "B の結果", at: "2026-11-01T00:03:00Z" }));
    await run(a, fakeChat(() => ({
      candidates: [{ memoryType: "semantic", content: "従来の方針 C", status: "confirmed", sourceEventIds: [`${a}-u1`], validFrom: null }],
      requirements: [
        rec({ ref: "ra", content: "A をする", sourceEventIds: [`${a}-u1`] }),
        rec({ ref: "rb", content: "B をする", sourceEventIds: [`${a}-u1`] }),
        rec({ ref: "ca", parentRef: "ra", content: "A を remote-cap に出す", origin: "agent", status: "inferred", sourceEventIds: [`${a}-t1`] }),
        rec({ ref: "cb", parentRef: "rb", content: "B を remote-cap に出す", origin: "agent", status: "inferred", sourceEventIds: [`${a}-t2`] }),
      ],
      specs: [
        spec({ ref: "s1", content: "設計は C", categories: ["business"], requirementRefs: ["ra"], sourceEventIds: [`${a}-u1`] }),
        spec({ ref: "s2", parentRef: "s1", content: "C を D の形に詳細化", categories: ["data"], basis: "agent", status: "inferred", sourceEventIds: [`${a}-u1`, `${a}-t1`] }),
      ],
    })));
    const ctx = await buildContext(t.db, a, {});
    // 従来の項目は変わらない
    assert.deepEqual(ctx.policies.map((x) => x.content), ["従来の方針 C"]);
    assert.deepEqual(ctx.recentDecisions, []);
    // B は結果が返っているので消える。A（結果待ち）は子つきで残る
    const text = (n: RecordNode): string => `${n.content}[${n.children.map(text).join(",")}]`;
    assert.deepEqual(ctx.openRequirements.map(text), ["A をする[A を remote-cap に出す[]]"]);
    assert.equal(ctx.openRequirements[0]!.children[0]!.status, "inferred");
    assert.equal(ctx.openRequirements[0]!.children[0]!.taskId, "t-open");
    assert.deepEqual(ctx.specs.map(text), ["設計は C[C を D の形に詳細化[]]"]);
    assert.equal(ctx.specs[0]!.status, "confirmed");
    assert.equal(ctx.specs[0]!.children[0]!.status, "inferred");
    assert.equal(ctx.specs[0]!.children[0]!.basis, "agent");
  });

  test("agent 分離: 他 agent の requirement・紐付けは recall / context に出ず、RLS が memory_relations も隔てる", async () => {
    const a = newAgent();
    const b = newAgent();
    await recordEvent(t.db, a, ev({ eventId: `${a}-u1`, body: "秘密の作業と設計" }));
    await run(a, fakeChat(() => ({
      candidates: [],
      requirements: [rec({ ref: "r", content: "秘密の作業を実施する", sourceEventIds: [`${a}-u1`] })],
      specs: [spec({ ref: "s", content: "秘密の作業の設計", categories: ["data"], requirementRefs: ["r"], sourceEventIds: [`${a}-u1`] })],
    })));
    await recordEvent(t.db, b, ev({ eventId: `${b}-u1`, body: "別の話" }));
    await run(b, fakeChat(() => ({ candidates: [], requirements: [], specs: [] })));
    assert.deepEqual(await recall(t.db, emb, b, { query: "秘密の作業", recordType: "requirement" }), []);
    const ctx = await buildContext(t.db, b, {});
    assert.deepEqual([ctx.openRequirements, ctx.specs], [[], []]);
    const seen = await t.db.withAgent(b, async (q) => (await q.query("SELECT 1 FROM memory_relations")).rows.length);
    assert.equal(seen, 0);
    const mine = await t.db.withAgent(a, async (q) => (await q.query("SELECT 1 FROM memory_relations")).rows.length);
    assert.equal(mine, 1);
  });

  test("event: parentRequirementId の入力検証（空・長すぎる値は拒否）。省略可", async () => {
    const a = newAgent();
    await assert.rejects(recordEvent(t.db, a, { ...ev({ kind: "task" }), parentRequirementId: "" }));
    await assert.rejects(recordEvent(t.db, a, { ...ev({ kind: "task" }), parentRequirementId: "p".repeat(129) }));
    assert.equal((await recordEvent(t.db, a, ev({ kind: "task", eventId: `${a}-ok` }))).status, "recorded");
  });

  test("従来の抽出の応答（candidates だけで requirements / specs が無い）もそのまま受ける", async () => {
    const a = newAgent();
    await recordEvent(t.db, a, ev({ eventId: `${a}-u1`, body: "方針だけ" }));
    const s = await run(a, fakeChat(() => ({ candidates: [{ memoryType: "semantic", content: "方針", status: "confirmed", sourceEventIds: [`${a}-u1`], validFrom: null }] })));
    assert.equal(s.accepted, 1);
    assert.deepEqual(await items(a), []);
  });
}
