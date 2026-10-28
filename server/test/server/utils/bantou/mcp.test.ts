import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { toNodeListener, createApp, defineEventHandler, toWebRequest } from "h3";
import { handleMcpRequest, startMcpListener } from "../../../../server/utils/bantou/mcp";
import { setReportHandler, type ReportKind } from "../../../../server/utils/bantou/reports";

function rpc(url: string, body: object, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

const call = (kind: string, text: string) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "report", arguments: { kind, text } },
});

test("mcp: report tool は header の cap_id / worker_id で handler を呼び accepted を返す", async () => {
  const got: Array<[string, string, ReportKind, string]> = [];
  setReportHandler(async (c, w, k, t) => {
    got.push([c, w, k, t]);
  });
  const app = createApp().use("/mcp", defineEventHandler((e) => handleMcpRequest(toWebRequest(e))));
  const l = await startMcpListener(toNodeListener(app), { port: 0, bind: "127.0.0.1" });
  try {
    assert.ok(l.port > 0);
    const url = `http://127.0.0.1:${l.port}/mcp`;
    const h = { "x-bantou-cap-id": "c1", "x-bantou-worker-id": "w1" };

    const tools = await (await rpc(url, { jsonrpc: "2.0", id: 1, method: "tools/list" }, h)).json() as {
      result: { tools: Array<{ name: string }> };
    };
    assert.deepEqual(tools.result.tools.map((t) => t.name), ["report"]);

    const ok = await (await rpc(url, call("done", "all good"), h)).json() as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    assert.equal(ok.result.content[0]!.text, "accepted");
    assert.ok(!ok.result.isError);
    assert.deepEqual(got, [["c1", "w1", "done", "all good"]]);

    // header 無しはエラー、kind 不正も拒否
    const noHdr = await (await rpc(url, call("done", "x"))).json() as { result: { isError?: boolean } };
    assert.equal(noHdr.result.isError, true);
    const badKind = await (await rpc(url, call("nope", "x"), h)).json() as { error?: unknown; result?: { isError?: boolean } };
    assert.ok(badKind.error !== undefined || badKind.result?.isError === true);
    assert.equal(got.length, 1);

    // handler が投げたら isError
    setReportHandler(async () => {
      throw new Error("cap が存在しない: c1");
    });
    const ng = await (await rpc(url, call("done", "x"), h)).json() as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    assert.equal(ng.result.isError, true);
    assert.match(ng.result.content[0]!.text, /cap が存在しない/);

    // handler 未設定（起動中・終了中）は isError
    setReportHandler(undefined);
    const none = await (await rpc(url, call("done", "x"), h)).json() as { result: { isError?: boolean } };
    assert.equal(none.result.isError, true);
  } finally {
    setReportHandler(undefined);
    await l.close();
  }
});

test("mcp listener: port 0 は実 port を返し、close 後は接続できない", async () => {
  const l = await startMcpListener((_req, res) => res.end("ok"), { port: 0, bind: "127.0.0.1" });
  const url = `http://127.0.0.1:${l.port}/`;
  assert.equal(await (await fetch(url)).text(), "ok");
  await l.close();
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(2000) }));
});

test("mcp listener: 使用中の port は reject する", async () => {
  const busy = createServer();
  await new Promise<void>((r) => busy.listen(0, "127.0.0.1", r));
  const port = (busy.address() as { port: number }).port;
  try {
    await assert.rejects(startMcpListener(() => {}, { port, bind: "127.0.0.1" }), /EADDRINUSE/);
  } finally {
    busy.close();
  }
});
