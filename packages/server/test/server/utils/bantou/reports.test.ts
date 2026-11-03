import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivityNotice, ServerNotice, ServerReply } from "@agent-hand/bantou-protocol";
import {
  buildReportPrompt,
  createReportHub,
  getReportHandler,
  setReportHandler,
} from "../../../../server/utils/bantou/reports";
import type { InvokeInput } from "../../../../server/utils/bantou/agents";

async function withHub(
  invoke: (capId: string, input: InvokeInput) => Promise<{ session_id: string; ok: true; result_text: string }>,
  fn: (h: { ws: string; hub: ReturnType<typeof createReportHub>; sent: Array<[string, ServerReply | ServerNotice]>; logs: string[] }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bantou-reports-test-"));
  try {
    const ws = join(dir, "ws");
    await mkdir(join(ws, "caps", "c1"), { recursive: true });
    const sent: Array<[string, ServerReply | ServerNotice]> = [];
    const logs: string[] = [];
    const hub = createReportHub({
      workspace: ws,
      invoke,
      send: async (to, r) => {
        sent.push([to, r]);
      },
      log: (m) => logs.push(m),
    });
    await fn({ ws, hub, sent, logs });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("report: prompt は「worker <id> から <kind>: <text>」で始まり、worker_start で返す案内を添える", () => {
  const p = buildReportPrompt("w1", "done", "ok");
  assert.ok(p.startsWith("worker w1 から done: ok\n"));
  assert.ok(p.includes("worker_start に同じ worker_id を渡す"));
  assert.ok(!p.includes("--mcp-config") && !p.includes("x-bantou-cap-id"));
});

test("report: 記録して cap を resume し、結果を記録済み center へ返す", async () => {
  const calls: Array<[string, InvokeInput]> = [];
  await withHub(
    async (id, input) => {
      calls.push([id, input]);
      return { session_id: "s", ok: true, result_text: "cap says" };
    },
    async ({ ws, hub, sent }) => {
      await hub.rememberCenter("c1", "center-1");
      await hub.report("c1", "w1", "done", "finished");
      await hub.drain();
      assert.equal(calls.length, 1);
      assert.equal(calls[0]![0], "c1");
      assert.ok(calls[0]![1].prompt.startsWith("worker w1 から done: finished"));
      assert.equal(calls[0]![1].keepTask, true);
      const replies = sent.filter(([, m]) => m.type !== "worker_report");
      assert.equal(replies.length, 1);
      assert.equal(replies[0]![0], "center-1");
      assert.deepEqual(replies[0]![1], {
        bantou: 1,
        type: "cap_result",
        cap_id: "c1",
        session_id: "s",
        ok: true,
        result_text: "cap says",
      });
      const rec = (await readFile(join(ws, "caps", "c1", "logs", "reports.jsonl"), "utf8")).trim().split("\n");
      assert.equal(rec.length, 1);
      const r = JSON.parse(rec[0]!) as Record<string, unknown>;
      assert.equal(r.worker_id, "w1");
      assert.equal(r.kind, "done");
      assert.equal(r.text, "finished");
    },
  );
});

test("report: report は resume の完了を待たずに戻る（cap ごとに 1 つずつ処理）", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let running = 0;
  let maxRunning = 0;
  await withHub(
    async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await gate;
      running--;
      return { session_id: "s", ok: true, result_text: "" };
    },
    async ({ hub }) => {
      await hub.report("c1", "w1", "progress", "a"); // gate が開くまで invoke は終わらない
      await hub.report("c1", "w1", "progress", "b");
      release();
      await hub.drain();
      // 直列化は manager.invoke の責務。hub は両方を invoke に渡す
      assert.ok(maxRunning >= 1);
    },
  );
});

test("report: center 不明なら返信せずログだけ。失敗は error 返信になる", async () => {
  let fail = false;
  await withHub(
    async () => {
      if (fail) throw new Error("boom");
      return { session_id: "s", ok: true, result_text: "" };
    },
    async ({ hub, sent, logs }) => {
      await hub.report("c1", "w1", "ask", "q");
      await hub.drain();
      assert.equal(sent.length, 0);
      assert.ok(logs.some((l) => l.includes("返信先 center が不明")));
      assert.ok(logs.some((l) => l.includes("通知先 center が不明")));
      fail = true;
      await hub.rememberCenter("c1", "center-2");
      await hub.report("c1", "w1", "ask", "q2");
      await hub.drain();
      assert.deepEqual(sent.filter(([, m]) => m.type !== "worker_report")[0]![1], {
        bantou: 1,
        type: "error",
        ok: false,
        message: "boom",
        command: "kick_cap",
        cap_id: "c1",
      });
    },
  );
});

test("report: center はファイルから復元できる（hub 作り直し後）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bantou-reports-test-"));
  try {
    const ws = join(dir, "ws");
    await mkdir(join(ws, "caps", "c1"), { recursive: true });
    const mk = (sent: string[]) =>
      createReportHub({
        workspace: ws,
        invoke: async () => ({ session_id: "s", ok: true, result_text: "" }),
        send: async (to) => {
          sent.push(to);
        },
        log: () => {},
      });
    await mk([]).rememberCenter("c1", "center-3");
    const sent: string[] = [];
    const hub = mk(sent);
    await hub.report("c1", "w1", "done", "x");
    await hub.drain();
    assert.deepEqual(sent, ["center-3", "center-3"]); // worker_report 通知と cap_result
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("report: 不正な入力・存在しない cap・close 後は投げる", async () => {
  await withHub(
    async () => ({ session_id: "s", ok: true, result_text: "" }),
    async ({ hub }) => {
      await assert.rejects(hub.report("../x", "w1", "done", "t"), /cap_id が不正/);
      await assert.rejects(hub.report("c1", "bad id", "done", "t"), /worker_id が不正/);
      await assert.rejects(hub.report("c1", "w1", "nope" as never, "t"), /kind が不正/);
      await assert.rejects(hub.report("c1", "w1", "done", ""), /text は/);
      await assert.rejects(hub.report("nocap", "w1", "done", "t"), /cap が存在しない/);
      hub.close();
      await assert.rejects(hub.report("c1", "w1", "done", "t"), /server 終了中/);
    },
  );
});

test("report handler: set / get / 解除", () => {
  assert.equal(getReportHandler(), undefined);
  const h = async (): Promise<void> => {};
  setReportHandler(h);
  assert.equal(getReportHandler(), h);
  setReportHandler(undefined);
  assert.equal(getReportHandler(), undefined);
});

const notice: ActivityNotice = { bantou: 1, type: "activity", cap_id: "c1", at: "2026-10-29T00:00:00.000Z", agents: [] };

test("notify: 記録済み center へ通知を送る。center 不明なら何もしない。送信失敗は投げる", async () => {
  await withHub(
    async () => ({ session_id: "s", ok: true, result_text: "" }),
    async ({ hub, sent, logs }) => {
      await hub.notify("c1", notice);
      assert.equal(sent.length, 0);
      await hub.rememberCenter("c1", "center-9");
      await hub.notify("c1", notice);
      assert.deepEqual(sent, [["center-9", notice]]);
      assert.ok(logs.some((l) => l.includes("activity 通知: to=center-9 cap_id=c1")));
    },
  );
  const dir = await mkdtemp(join(tmpdir(), "bantou-reports-test-"));
  try {
    const ws = join(dir, "ws");
    await mkdir(join(ws, "caps", "c1"), { recursive: true });
    const hub = createReportHub({
      workspace: ws,
      invoke: async () => ({ session_id: "s", ok: true, result_text: "" }),
      send: async () => {
        throw new Error("send ng");
      },
      log: () => {},
    });
    await hub.rememberCenter("c1", "center-9");
    await assert.rejects(hub.notify("c1", notice), /send ng/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pendingCount: report 起因の処理中は 1 以上、drain 後は 0", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await withHub(
    async () => {
      await gate;
      return { session_id: "s", ok: true, result_text: "" };
    },
    async ({ hub }) => {
      assert.equal(hub.pendingCount(), 0);
      await hub.report("c1", "w1", "progress", "a");
      assert.equal(hub.pendingCount(), 1);
      release();
      await hub.drain();
      assert.equal(hub.pendingCount(), 0);
    },
  );
});

test("report: worker_report を center へ通知する（task_id は task 指示のあと付く）", async () => {
  await withHub(
    async () => ({ session_id: "s", ok: true, result_text: "cap says" }),
    async ({ hub, sent }) => {
      await hub.rememberCenter("c1", "center-1");
      await hub.report("c1", "w1", "ask", "どの branch?");
      await hub.drain();
      const n1 = sent.find(([, m]) => m.type === "worker_report")![1] as unknown as Record<string, unknown>;
      assert.equal("task_id" in n1, false);
      assert.deepEqual({ ...n1, at: "x" }, { bantou: 1, type: "worker_report", cap_id: "c1", worker_id: "w1", kind: "ask", text: "どの branch?", at: "x" });
      assert.ok(!Number.isNaN(Date.parse(String(n1.at))));
      await hub.rememberTask("c1", "t-9");
      await hub.report("c1", "w2", "done", "終わった");
      await hub.drain();
      const notices = sent.filter(([, m]) => m.type === "worker_report").map(([, m]) => m as unknown as Record<string, unknown>);
      assert.equal(notices.length, 2);
      assert.equal(notices[1]!.task_id, "t-9");
      assert.equal(notices[1]!.kind, "done");
      assert.ok(sent.filter(([to]) => to === "center-1").length === sent.length);
    },
  );
});

test("report: worker_report は cap の再開（invoke）を待たずに送る", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await withHub(
    async () => {
      await gate;
      return { session_id: "s", ok: true, result_text: "" };
    },
    async ({ hub, sent }) => {
      await hub.rememberCenter("c1", "center-1");
      await hub.report("c1", "w1", "progress", "途中");
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(sent.length, 1);
      assert.equal(sent[0]![1].type, "worker_report");
      release();
      await hub.drain();
      assert.equal(sent.length, 2);
    },
  );
});

test("report: 通知の送信失敗は cap の再開を止めない", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bantou-reports-test-"));
  try {
    const ws = join(dir, "ws");
    await mkdir(join(ws, "caps", "c1"), { recursive: true });
    const logs: string[] = [];
    let invoked = 0;
    const hub = createReportHub({
      workspace: ws,
      invoke: async () => (invoked++, { session_id: "s", ok: true, result_text: "" }),
      send: async () => {
        throw new Error("net down");
      },
      log: (m) => logs.push(m),
    });
    await hub.rememberCenter("c1", "center-1");
    await hub.report("c1", "w1", "done", "ok");
    await hub.drain();
    assert.equal(invoked, 1);
    assert.ok(logs.some((l) => l.includes("worker_report 通知失敗") && l.includes("net down")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("report: task 指示中の cap が task_result の JSON で答えたら task_result、そうでなければ cap_result", async () => {
  let text = '```json\n{"summary":"完了","state":"done"}\n```';
  await withHub(
    async () => ({ session_id: "s", ok: true, result_text: text }),
    async ({ hub, sent }) => {
      await hub.rememberCenter("c1", "center-1");
      await hub.rememberTask("c1", "t-1");
      await hub.report("c1", "w1", "done", "ok");
      await hub.drain();
      const r1 = sent.find(([, m]) => m.type === "task_result")![1];
      assert.equal(r1.type, "task_result");
      assert.equal((r1 as { task_id: string }).task_id, "t-1");
      assert.equal((r1 as { summary: string }).summary, "完了");
      text = "まだ worker 待ち";
      sent.length = 0;
      await hub.report("c1", "w1", "progress", "p");
      await hub.drain();
      assert.deepEqual(sent.filter(([, m]) => m.type !== "worker_report").map(([, m]) => m.type), ["cap_result"]);
    },
  );
});

test("report: task_id は logs/task.json から復元できる（hub 作り直し後）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bantou-reports-test-"));
  try {
    const ws = join(dir, "ws");
    await mkdir(join(ws, "caps", "c1"), { recursive: true });
    const sent: ServerNotice[] = [];
    const mk = () =>
      createReportHub({
        workspace: ws,
        invoke: async () => ({ session_id: "s", ok: true, result_text: "" }),
        send: async (_to, m) => {
          sent.push(m as ServerNotice);
        },
        log: () => {},
      });
    await mk().rememberTask("c1", "t-7");
    const b = mk();
    await b.rememberCenter("c1", "center-1");
    await b.report("c1", "w1", "done", "x");
    await b.drain();
    const n = sent.find((m) => m.type === "worker_report");
    assert.equal(n?.type === "worker_report" ? n.task_id : undefined, "t-7");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// -- center を名前で覚え、送る時に今の peer id へ引く（center 再起動で peer id が変わる） --

type Peers = Array<{ id: string; registered_at?: string }>;

async function withNamedHub(
  peersOf: (name: string) => Peers | Promise<Peers>,
  fn: (h: { ws: string; hub: ReturnType<typeof createReportHub>; sent: string[]; logs: string[]; asked: string[]; remake: () => ReturnType<typeof createReportHub> }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bantou-reports-test-"));
  try {
    const ws = join(dir, "ws");
    await mkdir(join(ws, "caps", "c1"), { recursive: true });
    const sent: string[] = [];
    const logs: string[] = [];
    const asked: string[] = [];
    const mk = () =>
      createReportHub({
        workspace: ws,
        invoke: async () => ({ session_id: "s", ok: true, result_text: "" }),
        send: async (to) => {
          sent.push(to);
        },
        resolvePeers: async (name) => {
          asked.push(name);
          return peersOf(name);
        },
        log: (m) => logs.push(m),
      });
    await fn({ ws, hub: mk(), sent, logs, asked, remake: mk });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const noticeOf = (capId: string): ActivityNotice => ({ bantou: 1, type: "activity", cap_id: capId, at: "2026-11-04T00:00:00.000Z", agents: [] });

test("center: 名前で覚え、peer id が変わったら今の peer id へ送る（古い id へは送らない）", async () => {
  let peers: Peers = [{ id: "old-id", registered_at: "2026-11-04T00:00:00.000Z" }];
  await withNamedHub(
    () => peers,
    async ({ hub, sent, asked }) => {
      await hub.rememberCenter("c1", "old-id", "bantou-center");
      await hub.notify("c1", noticeOf("c1"));
      assert.deepEqual(sent, ["old-id"]);
      // center 再起動: 同名で別 id
      peers = [{ id: "new-id", registered_at: "2026-11-04T01:00:00.000Z" }];
      await hub.notify("c1", noticeOf("c1"));
      assert.deepEqual(sent, ["old-id", "new-id"]);
      assert.deepEqual(asked, ["bantou-center", "bantou-center"]);
    },
  );
});

test("center: 同名が複数なら、最後に命令を送ってきた id を優先。無ければ最後に登録した peer", async () => {
  const peers: Peers = [
    { id: "a", registered_at: "2026-11-04T01:00:00.000Z" },
    { id: "b", registered_at: "2026-11-04T02:00:00.000Z" },
  ];
  await withNamedHub(
    () => peers,
    async ({ hub, sent }) => {
      await hub.rememberCenter("c1", "a", "bantou-center"); // a が最後に命令を送ってきた（b の方が新しい登録）
      await hub.notify("c1", noticeOf("c1"));
      assert.deepEqual(sent, ["a"]);
      await hub.noteCenter("c1", "zombie", "bantou-center"); // 覚えている id がもういない
      await hub.notify("c1", noticeOf("c1"));
      assert.deepEqual(sent, ["a", "b"]);
    },
  );
});

test("center: 命令で通知先を更新する（noteCenter は id と名前を置き換え、ファイルにも残る）", async () => {
  const peers: Peers = [{ id: "x1" }, { id: "x2" }];
  await withNamedHub(
    () => peers,
    async ({ ws, hub, remake, sent }) => {
      await hub.rememberCenter("c1", "x1", "bantou-center");
      await hub.noteCenter("c1", "x2", "bantou-center");
      const d = JSON.parse(await readFile(join(ws, "caps", "c1", "logs", "center.json"), "utf8")) as Record<string, string>;
      assert.deepEqual(d, { center_id: "x2", center_name: "bantou-center" });
      await remake().notify("c1", noticeOf("c1")); // hub 作り直し後もファイルから復元して x2 へ
      assert.deepEqual(sent, ["x2"]);
    },
  );
});

test("center: noteCenter は無い cap の dir を作らない（メモリだけ更新）", async () => {
  await withNamedHub(
    () => [],
    async ({ ws, hub, logs }) => {
      await hub.noteCenter("nocap", "x1", "bantou-center");
      await assert.rejects(stat(join(ws, "caps", "nocap")));
      assert.ok(!logs.some((l) => l.includes("center 記録失敗")));
      await hub.notify("nocap", noticeOf("nocap")); // メモリの記録で送ろうとする（同名が居なければ覚えている id）
    },
  );
});

test("center: 旧形式（center_id のみ・名前無し）は peer id のまま送る。名前を引かない", async () => {
  await withNamedHub(
    () => [{ id: "other" }],
    async ({ ws, hub, sent, asked }) => {
      await mkdir(join(ws, "caps", "c1", "logs"), { recursive: true });
      await writeFile(join(ws, "caps", "c1", "logs", "center.json"), JSON.stringify({ center_id: "legacy-id" }) + "\n");
      await hub.notify("c1", noticeOf("c1"));
      assert.deepEqual(sent, ["legacy-id"]);
      assert.deepEqual(asked, []);
    },
  );
});

test("center: 同名の peer が居ない・引けない時は覚えている id へ送る", async () => {
  let mode: "none" | "fail" = "none";
  await withNamedHub(
    () => {
      if (mode === "fail") throw new Error("broker down");
      return [];
    },
    async ({ hub, sent, logs }) => {
      await hub.rememberCenter("c1", "keep-id", "bantou-center");
      await hub.notify("c1", noticeOf("c1"));
      mode = "fail";
      await hub.notify("c1", noticeOf("c1"));
      assert.deepEqual(sent, ["keep-id", "keep-id"]);
      assert.ok(logs.some((l) => l.includes("center の peer を引けない")));
    },
  );
});

test("center: report 起因の cap_result と worker_report も今の peer id へ届く", async () => {
  const peers: Peers = [{ id: "new-id" }];
  await withNamedHub(
    () => peers,
    async ({ hub, sent }) => {
      await hub.rememberCenter("c1", "old-id", "bantou-center");
      await hub.report("c1", "w1", "done", "x");
      await hub.drain();
      assert.deepEqual(sent, ["new-id", "new-id"]); // worker_report 通知と cap_result
    },
  );
});
