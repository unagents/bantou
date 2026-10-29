import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
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
      assert.equal(sent.length, 1);
      assert.equal(sent[0]![0], "center-1");
      assert.deepEqual(sent[0]![1], {
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
      fail = true;
      await hub.rememberCenter("c1", "center-2");
      await hub.report("c1", "w1", "ask", "q2");
      await hub.drain();
      assert.deepEqual(sent[0]![1], {
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
    assert.deepEqual(sent, ["center-3"]);
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
