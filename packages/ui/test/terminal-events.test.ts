import assert from "node:assert/strict";
import { test } from "node:test";
import { createGraphqlClient } from "../api/graphql-client";
import { createTerminalFeed, type TerminalEvent } from "../api/terminal-events";
import { S_TERMINAL_OUTPUT } from "../api/graphql-docs";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test("a `status` (end) event reaches the screen at once, while the stream stays open", async () => {
  const enc = new TextEncoder();
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => (ctl = c) });
  const outputs: unknown[] = [];
  const statuses: unknown[] = [];
  const feed = createTerminalFeed("a", null, (p) => outputs.push(p), (p) => statuses.push(p));
  const c = createGraphqlClient({
    target: async () => ({ url: "/g" }),
    fetch: (async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as never,
  });
  const stop = c.subscribe<{ terminalOutput: TerminalEvent }>(S_TERMINAL_OUTPUT, feed.variables, {
    onNext: feed.onNext,
    onOpen: () => statuses.push("open"),
  });
  await wait();
  const frame = (ev: TerminalEvent) => enc.encode(`event: next\ndata: ${JSON.stringify({ data: { terminalOutput: ev } })}\n\n`);
  ctl.enqueue(frame({ type: "output", id: 3, data: "QQ==", status: null }));
  ctl.enqueue(frame({ type: "status", id: null, data: null, status: "end" }));
  await wait();
  // the stream was never closed
  assert.deepEqual(outputs, [{ session: "a", id: 3, data: "QQ==", reset: false }]);
  assert.deepEqual(statuses, ["open", { session: "a", state: "retrying", message: null }]);
  assert.deepEqual(feed.variables(), { session: "a", after: 3 });
  stop();
});
