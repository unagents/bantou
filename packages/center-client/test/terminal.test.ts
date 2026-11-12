// Inputs and expectations copied from the Rust tests of the desktop (design 5.6 #5, work unit 4a).
// T = packages/desktop/src-tauri/src/terminal.rs, A = .../attachment.rs. The center is a fake HTTP
// server on 127.0.0.1 (no other host is contacted). Host names are dummies.
// Not ported: A `load_reads_a_file_*` (file source: desktop only), A `b64` (Buffer is used).

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import {
  CenterSettingsError,
  LOG_BODY_CHARS,
  MAX_ATTACHMENT_BYTES,
  SseParser,
  TerminalError,
  centerUrl,
  checkAttachmentSize,
  checkInputData,
  checkSessionName,
  checkTerminalSize,
  clipBody,
  createAttachments,
  createTerminals,
  errorReason,
  inputBody,
  inputText,
  loadBytes,
  reconnectDelayMs,
  resizeBody,
  scrub,
  sessionUrl,
  sniffType,
  streamOnce,
  toPayload,
  uploadAttachment,
  type OutputPayload,
  type SseEvent,
  type StatusPayload,
  type StreamEnd,
} from "../src/index.ts";

// -- fake center ---------------------------------------------------------------------------

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}
type Handler = (req: IncomingMessage, res: ServerResponse, seen: Seen) => void;

async function fake(handler: Handler): Promise<{ base: string; seen: Seen[]; close: () => Promise<void>; server: Server }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const s: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) };
      seen.push(s);
      handler(req, res, s);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    seen,
    server,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** Answer each connection with the next canned (status, body), then close. */
const canned =
  (responses: Array<[number, string]>): Handler =>
  (_req, res) => {
    const [status, body] = responses.shift() ?? [500, "no more"];
    res.writeHead(status, { "content-type": "text/event-stream", connection: "close" });
    res.end(body);
  };

const parseAll = (chunks: string[]): SseEvent[] => {
  const p = new SseParser();
  return chunks.flatMap((c) => p.feed(new TextEncoder().encode(c)));
};
const target = (base: string, token?: string) => ({ url: `${base}/mcp`, source: "remote" as const, ...(token ? { token } : {}) });
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
/** `streamOnce` against `<base>/mcp` for `session`'s output. */
const stream = (
  base: string,
  session: string,
  onEvent: (e: SseEvent) => boolean,
  o: { token?: string; lastEventId?: number; readTimeoutMs?: number } = {},
) => streamOnce({ url: `${base}/mcp`, token: o.token }, ["sessions", session, "output"], onEvent, o);
const noWait = () => new Promise<void>((r) => setTimeout(r, 5)); // a macrotask: a microtask-only loop would starve the test timers

// -- T: SSE parsing ------------------------------------------------------------------------

test("T parses_output_event_with_id", () => {
  assert.deepEqual(parseAll(["id: 7\nevent: output\ndata: aGVsbG8=\n\n"]), [{ id: "7", event: "output", data: "aGVsbG8=" }]);
});

test("T parses_reset_and_ignores_keep_alive_comments", () => {
  const evs = parseAll(["event: reset\ndata: {}\n\n: ka\n\n", ": ka\n\nid: 1\nevent: output\ndata: QQ==\n\n"]);
  assert.equal(evs.length, 2);
  assert.equal(evs[0]!.event, "reset");
  assert.equal(evs[0]!.data, "{}");
  assert.equal(evs[1]!.id, "1");
});

test("T keep_alive_alone_dispatches_nothing", () => {
  assert.deepEqual(parseAll([": ka\n\n", ": ka\n\n"]), []);
});

test("T handles_events_split_across_chunks_and_crlf", () => {
  const evs = parseAll(["id: 1\r\neve", "nt: output\r\nda", "ta: QQ==\r", "\n\r\n", "id: 2\nevent: output\ndata: Qg==\n", "\n"]);
  assert.equal(evs.length, 2);
  assert.deepEqual(evs[0], { id: "1", event: "output", data: "QQ==" });
  assert.equal(evs[1]!.id, "2");
});

test("T multiple_data_lines_join_with_newline_and_default_event_is_message", () => {
  assert.deepEqual(parseAll(["data: a\ndata: b\n\n"]), [{ id: undefined, event: "message", data: "a\nb" }]);
});

// -- T: payload ----------------------------------------------------------------------------

test("T payload_for_output_tracks_last_id", () => {
  const r = toPayload("s", { id: "12", event: "output", data: "QQ==" }, undefined);
  assert.deepEqual(r.payload, { session: "s", id: 12, data: "QQ==", reset: false });
  assert.equal(r.lastId, 12);
});

test("T payload_for_reset_forgets_last_id", () => {
  const r = toPayload("s", { id: undefined, event: "reset", data: "{}" }, 99);
  assert.equal(r.payload?.reset, true);
  assert.deepEqual([r.payload?.id, r.payload?.data], [0, ""]);
  assert.equal(r.lastId, undefined);
});

test("T payload_ignores_unknown_events_and_broken_ids", () => {
  for (const ev of [
    { id: "6", event: "message", data: "x" },
    { id: "abc", event: "output", data: "x" },
    { id: undefined, event: "output", data: "x" },
  ]) {
    const r = toPayload("s", ev, 5);
    assert.equal(r.payload, undefined);
    assert.equal(r.lastId, 5);
  }
});

test("T payload_serializes_with_the_event_field_names", () => {
  const p: OutputPayload = toPayload("s", { id: "3", event: "output", data: "QQ==" }, undefined).payload!;
  assert.deepEqual(JSON.parse(JSON.stringify(p)), { session: "s", id: 3, data: "QQ==", reset: false });
});

// -- T: requests ---------------------------------------------------------------------------

test("T session_url_uses_the_mcp_origin_and_encodes_the_name", () => {
  assert.equal(sessionUrl("http://127.0.0.1:7910/mcp", "master cap/1", "output"), "http://127.0.0.1:7910/sessions/master%20cap%2F1/output");
  assert.equal(sessionUrl("http://mac200:7910/mcp?x=1", "a", "input"), "http://mac200:7910/sessions/a/input");
  assert.throws(() => sessionUrl("not a url", "a", "input"), TerminalError);
});

test("T request_bodies_have_the_contract_shape", () => {
  assert.deepEqual(inputBody("QQ=="), { data: "QQ==" });
  assert.deepEqual(resizeBody(120, 40), { cols: 120, rows: 40 });
});

test("T clip_body_is_one_line_and_bounded", () => {
  assert.equal(clipBody(""), "(empty body)");
  assert.equal(clipBody("a\n  b\r\nc"), "a b c");
  assert.equal([...clipBody("x".repeat(LOG_BODY_CHARS + 50))].length, LOG_BODY_CHARS);
});

test("T reconnect_delay_backs_off_and_caps", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((n) => reconnectDelayMs(n) / 1000), [1, 2, 4, 8, 15, 15, 15]);
});

// -- T: stream_once ------------------------------------------------------------------------

test("T stream_once_delivers_events_and_sends_last_event_id_and_token", async () => {
  const body = "event: reset\ndata: {}\n\n: ka\n\nid: 4\nevent: output\ndata: QQ==\n\n";
  const f = await fake(canned([[200, body]]));
  try {
    const got: SseEvent[] = [];
    const end = await stream(f.base, "m", (e) => (got.push(e), true), { token: "tok", lastEventId: 3, readTimeoutMs: 5000 });
    assert.deepEqual(end, { type: "closed" });
    assert.deepEqual(got.map((e) => e.event), ["reset", "output"]);
    const s = f.seen[0]!;
    assert.equal(s.method, "GET");
    assert.equal(s.url, "/sessions/m/output");
    assert.equal(s.headers.authorization, "Bearer tok");
    assert.equal(s.headers["last-event-id"], "3");
  } finally {
    await f.close();
  }
});

test("T stream_once_omits_last_event_id_when_none_and_reports_rejection", async () => {
  const f = await fake(canned([[404, "no such session"]]));
  try {
    const end = await stream(f.base, "gone", () => true);
    assert.deepEqual(end, { type: "rejected", status: 404, body: "no such session" });
    assert.equal(f.seen[0]!.headers["last-event-id"], undefined);
    assert.equal(f.seen[0]!.headers.authorization, undefined);
  } finally {
    await f.close();
  }
});

test("T reconnect_resumes_from_the_last_received_id", async () => {
  const first = "id: 1\nevent: output\ndata: QQ==\n\nid: 2\nevent: output\ndata: Qg==\n\n";
  const second = "id: 3\nevent: output\ndata: Qw==\n\n";
  const f = await fake(canned([[200, first], [200, second]]));
  try {
    let last: number | undefined;
    const ids: number[] = [];
    for (let i = 0; i < 2; i++) {
      await stream(
        f.base,
        "m",
        (e) => {
          const r = toPayload("m", e, last);
          last = r.lastId;
          if (r.payload) ids.push(r.payload.id);
          return true;
        },
        { ...(last !== undefined ? { lastEventId: last } : {}), readTimeoutMs: 5000 },
      );
    }
    assert.deepEqual(ids, [1, 2, 3]);
    assert.equal(f.seen[0]!.headers["last-event-id"], undefined);
    assert.equal(f.seen[1]!.headers["last-event-id"], "2");
  } finally {
    await f.close();
  }
});

test("T stream_once_stops_when_the_sink_says_so", async () => {
  const body = "id: 1\nevent: output\ndata: QQ==\n\nid: 2\nevent: output\ndata: Qg==\n\n";
  const f = await fake(canned([[200, body]]));
  try {
    let n = 0;
    const end = await stream(f.base, "m", () => (n++, false), { readTimeoutMs: 5000 });
    assert.deepEqual([end, n], [{ type: "stopped" }, 1]);
  } finally {
    await f.close();
  }
});

test("T silent_connection_is_dropped_after_the_read_timeout", async () => {
  const f = await fake((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
  });
  try {
    const end: StreamEnd = await stream(f.base, "m", () => true, { readTimeoutMs: 300 });
    assert.deepEqual(end, { type: "closed" });
  } finally {
    await f.close();
  }
});

test("stream_once: a center that never sends headers fails at the connect timeout (text without secrets); the timer does not cut the body", async () => {
  const hang = await fake(() => {}); // accepts, never answers
  try {
    await assert.rejects(
      streamOnce({ url: `${hang.base}/mcp`, token: "tok-SECRET" }, ["sessions", "m", "output"], () => true, { connectTimeoutMs: 100 }),
      (e: Error) => /接続がタイムアウト/.test(e.message) && !e.message.includes("tok-SECRET"),
    );
  } finally {
    await hang.close();
  }
  const slow = await fake((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    setTimeout(() => res.end("id: 1\nevent: output\ndata: QQ==\n\n"), 250);
  });
  try {
    const got: SseEvent[] = [];
    const end = await streamOnce({ url: `${slow.base}/mcp` }, ["sessions", "m", "output"], (e) => (got.push(e), true), { connectTimeoutMs: 100, readTimeoutMs: 5000 });
    assert.deepEqual([end, got.length], [{ type: "closed" }, 1]);
  } finally {
    await slow.close();
  }
});

// -- A: attachment pure parts --------------------------------------------------------------

test("A sniffs_the_four_types_and_refuses_the_rest", () => {
  const b = (s: string) => new TextEncoder().encode(s);
  assert.equal(sniffType(PNG), "image/png");
  assert.equal(sniffType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffType(b("GIF89a..")), "image/gif");
  assert.equal(sniffType(b("GIF87a..")), "image/gif");
  assert.equal(sniffType(b("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(sniffType(b("RIFF\0\0\0\0WAVEfmt ")), undefined);
  assert.equal(sniffType(b("<svg></svg>")), undefined);
  assert.equal(sniffType(b("")), undefined);
});

test("A size_limit_is_20mb_inclusive", () => {
  const check = (n: number) => checkAttachmentSize(n);
  assert.equal(check(1), undefined);
  assert.equal(check(MAX_ATTACHMENT_BYTES), undefined);
  assert.match(check(MAX_ATTACHMENT_BYTES + 1)!, /20MB/);
  assert.notEqual(check(0), undefined);
  // loadBytes applies the same limit before looking at the type
  assert.match(loadBytesLen(MAX_ATTACHMENT_BYTES + 1)!, /20MB/);
  assert.equal(loadBytesLen(MAX_ATTACHMENT_BYTES), undefined);
});

/** loadBytes on a PNG-headed buffer of `n` bytes; the error text, or undefined when accepted. */
function loadBytesLen(n: number): string | undefined {
  const data = new Uint8Array(n);
  data.set(PNG.subarray(0, Math.min(n, PNG.length)));
  try {
    loadBytes("x", data);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

test("A input_text_has_one_space_before_and_after_and_no_enter", () => {
  assert.equal(inputText(["/a/1.png"]), " /a/1.png ");
  assert.equal(inputText(["/a/1.png", "/a/2.jpg"]), " /a/1.png /a/2.jpg ");
  assert.doesNotMatch(inputText(["/a"]), /[\r\n]/);
});

test("A attachments_url_uses_the_mcp_origin_and_encodes_the_name", () => {
  assert.equal(sessionUrl("http://mac200:7910/mcp", "a b", "attachments"), "http://mac200:7910/sessions/a%20b/attachments");
});

test("A load_checks_clipboard_bytes_too", () => {
  assert.doesNotThrow(() => loadBytes("c", PNG));
  assert.throws(() => loadBytes("c", new TextEncoder().encode("nope")), /画像の型が違う/);
  assert.throws(() => loadBytes("c", new Uint8Array()), TerminalError);
});

test("A error_reason_takes_the_center_error_field", () => {
  assert.equal(errorReason('{"error":"未対応の型: text/plain"}'), "未対応の型: text/plain");
  assert.equal(errorReason("plain\ntext"), "plain text");
});

// -- A: upload against the fake center -----------------------------------------------------

test("A upload_posts_the_bytes_with_type_and_token_and_parses_the_answer", async () => {
  const f = await fake((_q, res) => {
    res.writeHead(201, { "content-type": "application/json" });
    res.end('{"path":"/ws/m/attachments/x.png","bytes":11,"type":"image/png"}');
  });
  try {
    const saved = await uploadAttachment({ target: target(f.base, "tok"), session: "m", data: PNG, kind: "image/png" });
    assert.deepEqual(saved, { path: "/ws/m/attachments/x.png", bytes: 11, type: "image/png" });
    const s = f.seen[0]!;
    assert.equal(s.method, "POST");
    assert.equal(s.url, "/sessions/m/attachments");
    assert.equal(s.headers["content-type"], "image/png");
    assert.equal(s.headers.authorization, "Bearer tok");
    assert.deepEqual(s.body, Buffer.from(PNG));
  } finally {
    await f.close();
  }
});

test("A upload_reports_the_center_refusal_reason", async () => {
  const f = await fake((_q, res) => {
    res.writeHead(415, { "content-type": "application/json" });
    res.end('{"error":"未対応の型: image/svg+xml"}');
  });
  try {
    await assert.rejects(uploadAttachment({ target: target(f.base), session: "m", data: PNG, kind: "image/png" }), /415.*未対応の型/);
  } finally {
    await f.close();
  }
});

// -- 4a: relay against a fake center (input / resize / attach) -----------------------------

test("input and resize POST the contract bodies with the token; 409 is the stopped-session text", async () => {
  const f = await fake((req, res) => {
    if (req.url === "/sessions/dead/input") {
      res.writeHead(409, { "content-type": "application/json" });
      res.end('{"error":"x"}');
    } else {
      res.writeHead(204);
      res.end();
    }
  });
  try {
    const t = createTerminals({ getTarget: async () => target(f.base, "tok") });
    await t.input("m", "QQ==");
    await t.resize("m", 120, 40);
    assert.deepEqual(f.seen.map((s) => [s.method, s.url, JSON.parse(s.body.toString())]), [
      ["POST", "/sessions/m/input", { data: "QQ==" }],
      ["POST", "/sessions/m/resize", { cols: 120, rows: 40 }],
    ]);
    assert.equal(f.seen[0]!.headers.authorization, "Bearer tok");
    await assert.rejects(t.input("dead", "QQ=="), /center が 409 を返した: セッションは動いていない/);
  } finally {
    await f.close();
  }
});

test("checks: name, base64, cols/rows 1..1000 (same as the center) reject before any request", async () => {
  const t = createTerminals({ getTarget: async () => assert.fail("no request expected") });
  assert.throws(() => checkSessionName("a b"), TerminalError);
  assert.throws(() => checkSessionName("../x"), TerminalError);
  assert.throws(() => checkSessionName(""), TerminalError);
  assert.equal(checkSessionName("m_1-A"), "m_1-A");
  assert.throws(() => checkInputData("not base64!"), /base64/);
  assert.equal(checkInputData(""), "");
  for (const [c, r] of [[0, 1], [1, 0], [1001, 1], [1, 1001], [1.5, 1], [NaN, 1]] as const) {
    assert.throws(() => checkTerminalSize(c, r), /1〜1000/);
  }
  assert.deepEqual(checkTerminalSize(1, 1000), { cols: 1, rows: 1000 });
  await assert.rejects(t.input("a b", "QQ=="), TerminalError);
  await assert.rejects(t.input("m", "!!"), TerminalError);
  await assert.rejects(t.resize("m", 0, 10), TerminalError);
});

test("attach: refuses over 20MB and a wrong type without a request, uploads the rest and types the paths", async () => {
  const f = await fake((req, res, s) => {
    if (req.url?.endsWith("/attachments")) {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ path: "/ws/m/attachments/1.png", bytes: s.body.length, type: "image/png" }));
    } else {
      res.writeHead(204);
      res.end();
    }
  });
  try {
    const t = createTerminals({ getTarget: async () => target(f.base) });
    const a = createAttachments(t);
    const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
    big.set(PNG);
    const out = await a.attachBytes("m", [
      { name: "big", data: big },
      { name: "txt", data: new TextEncoder().encode("hello") },
      { name: "ok", data: PNG },
    ]);
    assert.deepEqual(out.saved, ["/ws/m/attachments/1.png"]);
    assert.equal(out.errors.length, 2);
    assert.match(out.errors[0]!, /big: 20MB を超えている/);
    assert.match(out.errors[1]!, /txt: 画像の型が違う/);
    assert.deepEqual(f.seen.map((s) => s.url), ["/sessions/m/attachments", "/sessions/m/input"]);
    const typed = Buffer.from(JSON.parse(f.seen[1]!.body.toString()).data, "base64").toString();
    assert.equal(typed, " /ws/m/attachments/1.png ");
  } finally {
    await f.close();
  }
});

test("attach: center refusal is reported per image and nothing is typed", async () => {
  const f = await fake((_q, res) => {
    res.writeHead(413, { "content-type": "application/json" });
    res.end('{"error":"too big"}');
  });
  try {
    const out = await createAttachments(createTerminals({ getTarget: async () => target(f.base) })).attachBytes("m", [{ name: "ok", data: PNG }]);
    assert.deepEqual(out.saved, []);
    assert.match(out.errors[0]!, /^ok: center が 413 を返した: too big/);
    assert.equal(f.seen.length, 1);
  } finally {
    await f.close();
  }
});

// -- 4a: output relay (reconnect, after, reset, simultaneous subscriptions) ----------------

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("output: cut then reconnect carries the last id; reset reaches the consumer and forgets the id", async () => {
  const bodies = [
    "id: 1\nevent: output\ndata: QQ==\n\nid: 2\nevent: output\ndata: Qg==\n\n", // closes -> reconnect
    "event: reset\ndata: {}\n\nid: 1\nevent: output\ndata: Qw==\n\n", // reset, then restarts at 1; closes
    "id: 2\nevent: output\ndata: RA==\n\n", // keeps open below
  ];
  const f = await fake((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const b = bodies.shift() ?? "";
    if (bodies.length === 0) res.write(b); // last: stay open
    else res.end(b);
  });
  const t = createTerminals({ getTarget: async () => target(f.base, "tok"), sleep: noWait });
  const out: OutputPayload[] = [];
  const st: StatusPayload[] = [];
  const sub = t.openOutput("m", { after: 0, onOutput: (p) => out.push(p), onStatus: (s) => st.push(s) });
  try {
    await until(() => out.length >= 5);
    assert.deepEqual(out.map((p) => [p.id, p.reset]), [[1, false], [2, false], [0, true], [1, false], [2, false]]);
    assert.equal(f.seen[0]!.headers["last-event-id"], "0");
    assert.equal(f.seen[1]!.headers["last-event-id"], "2");
    assert.equal(f.seen[2]!.headers["last-event-id"], "1"); // after the reset the id restarted at 1
    assert.equal(st[0]!.state, "connected");
    assert.ok(st.some((s) => s.state === "retrying"));
  } finally {
    sub.stop();
    await f.close();
  }
});

test("output: 404 is rejected and not retried; no token in the status", async () => {
  const f = await fake(canned([[404, "no such session"], [404, "again"]]));
  try {
    const t = createTerminals({ getTarget: async () => target(f.base, "secret-token-1234"), sleep: noWait });
    const st: StatusPayload[] = [];
    t.openOutput("gone", { onOutput: () => {}, onStatus: (s) => st.push(s) });
    await until(() => st.length >= 1);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(st, [{ session: "gone", state: "rejected", message: "center が 404 を返した" }]);
    assert.equal(f.seen.length, 1);
  } finally {
    await f.close();
  }
});

test("output: two subscriptions run at the same time and stop independently", async () => {
  const f = await fake((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const name = decodeURIComponent(req.url!.split("/")[2]!);
    res.write(`id: 1\nevent: output\ndata: ${Buffer.from(name).toString("base64")}\n\n`);
  });
  const t = createTerminals({ getTarget: async () => target(f.base) });
  const a: OutputPayload[] = [];
  const b: OutputPayload[] = [];
  try {
    t.outputStart("s1", null, { onOutput: (p) => a.push(p) });
    t.outputStart("s2", undefined, { onOutput: (p) => b.push(p) });
    await until(() => a.length === 1 && b.length === 1);
    assert.equal(Buffer.from(a[0]!.data, "base64").toString(), "s1");
    assert.equal(Buffer.from(b[0]!.data, "base64").toString(), "s2");
    assert.equal(f.seen.every((s) => s.headers["last-event-id"] === undefined), true);
    t.outputStop("s1");
    t.outputStop("s2");
  } finally {
    t.close();
    await f.close();
  }
});

test("output: stop ends the loop (no more requests)", async () => {
  const f = await fake(canned(Array.from({ length: 50 }, () => [200, ""] as [number, string])));
  const t = createTerminals({ getTarget: async () => target(f.base), sleep: (ms, sig) => new Promise((r) => (sig.aborted ? r() : setTimeout(r, 20))) });
  const sub = t.openOutput("m", { onOutput: () => {} });
  try {
    await until(() => f.seen.length >= 2);
    sub.stop();
    await new Promise((r) => setTimeout(r, 100));
    const n = f.seen.length;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(f.seen.length, n);
  } finally {
    await f.close();
  }
});

// -- 4a: no secrets in errors / logs -------------------------------------------------------

test("secrets: token and userinfo never appear in errors, status or log", async () => {
  const token = "tok-SECRET-123456";
  const lines: string[] = [];
  const log = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) };
  // a dead port: connection refused
  const dead = createServer();
  await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
  const port = (dead.address() as AddressInfo).port;
  await new Promise<void>((r) => dead.close(() => r()));
  const url = `http://user:pw-SECRET@127.0.0.1:${port}/mcp?token=${token}`;
  const t = createTerminals({ getTarget: async () => ({ url, token, source: "remote" }), log, sleep: noWait });
  const errs: string[] = [];
  try {
    await t.input("m", "QQ==");
  } catch (e) {
    errs.push((e as Error).message);
  }
  try {
    await createAttachments(t, { log }).attachBytes("m", [{ name: "ok", data: PNG }]).then((o) => errs.push(...o.errors));
  } catch (e) {
    errs.push((e as Error).message);
  }
  const st: StatusPayload[] = [];
  const sub = t.openOutput("m", { onOutput: () => {}, onStatus: (s) => st.push(s) });
  await until(() => st.length >= 1);
  sub.stop();
  const all = [...errs, ...lines, ...st.map((s) => s.message ?? "")].join("\n");
  assert.ok(errs.length >= 2 && lines.length > 0);
  for (const secret of [token, "pw-SECRET", "user:"]) assert.equal(all.includes(secret), false, `${secret} leaked: ${all}`);
});

test("secrets: a center body that echoes the token is scrubbed; scrub drops userinfo", async () => {
  const token = "tok-SECRET-123456";
  const f = await fake((_q, res) => {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`bad ${token} http://u:p@h/x`);
  });
  try {
    const t = createTerminals({ getTarget: async () => target(f.base, token) });
    await assert.rejects(t.input("m", "QQ=="), (e: Error) => !e.message.includes(token) && !e.message.includes("u:p@"));
  } finally {
    await f.close();
  }
  assert.equal(scrub("x http://u:p@h/y tok", "http://u:p@h/mcp", "tok"), "x http://h/y ***");
  assert.equal(centerUrl("http://u:p@127.0.0.1:1/mcp", ["a"]).href, "http://127.0.0.1:1/a");
});

test("no target: input and output report it", async () => {
  const t = createTerminals({ getTarget: async () => undefined, sleep: noWait });
  await assert.rejects(t.input("m", "QQ=="), /接続先が無い/);
  const st: StatusPayload[] = [];
  const sub = t.openOutput("m", { onOutput: () => {}, onStatus: (s) => st.push(s) });
  await until(() => st.length >= 1);
  sub.stop();
  assert.deepEqual(st[0], { session: "m", state: "retrying", message: "接続先が無い" });
});

// -- input checks (each one must hold on its own path, before any request) -------------------

test("checkInputData: non-string, bad padding and URL-safe characters are refused; plain base64 passes", () => {
  for (const bad of [123, null, undefined, {}, ["QQ=="], "QQ===", "Q===", "QQ=Q", "a-_b", "ab_c", "a b", "QQ==\n"]) {
    assert.throws(() => checkInputData(bad), TerminalError, String(bad));
  }
  for (const ok of ["", "QQ==", "QUI=", "QUJD", "a+/b"]) assert.equal(checkInputData(ok), ok);
});

test("input(): a non-string / malformed data is refused before any request", async () => {
  const f = await fake(canned([[200, "{}"]]));
  try {
    const t = createTerminals({ getTarget: async () => target(f.base) });
    for (const bad of [123, "QQ===", "a-_b"]) await assert.rejects(t.input("m", bad as unknown as string), TerminalError);
    assert.equal(f.seen.length, 0);
  } finally {
    await f.close();
  }
});

test("a bad session name is refused before any request: input, resize, attachBytes, openOutput", async () => {
  const f = await fake(canned([[200, "{}"], [200, "{}"], [200, "{}"], [200, "{}"]]));
  const subs: Array<{ stop(): void }> = []; // only filled when the name check is missing
  try {
    const t = createTerminals({ getTarget: async () => target(f.base, "tok"), sleep: noWait });
    const a = createAttachments(t);
    for (const bad of ["a/b", "", "a b", "../x", "x\n"]) {
      await assert.rejects(t.input(bad, "QQ=="), TerminalError, `input ${bad}`);
      await assert.rejects(t.resize(bad, 80, 24), TerminalError, `resize ${bad}`);
      await assert.rejects(a.attachBytes(bad, [{ name: "ok", data: PNG }]), TerminalError, `attachBytes ${bad}`);
      assert.throws(() => subs.push(t.openOutput(bad, { onOutput: () => {} })), TerminalError, `openOutput ${bad}`);
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(f.seen.length, 0);
  } finally {
    for (const s of subs) s.stop();
    await f.close();
  }
});

test("openOutput: a getTarget() that throws shows a fixed text (3c form); CenterSettingsError is passed on, scrubbed", async () => {
  const token = "tok-SECRET-123456";
  const f = await fake((_q, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("id: 1\nevent: output\ndata: QQ==\n\n");
  });
  try {
    let n = 0;
    const t = createTerminals({
      getTarget: async () => {
        n++;
        if (n === 1) return target(f.base, token);
        if (n === 2) throw new Error(`settings read failed: ${token} http://user:pw-SECRET@h/x`);
        if (n === 3) throw Object.assign(new Error(`read ${token}`), { code: "EACCES" });
        throw new CenterSettingsError(`bad ${token} http://user:pw-SECRET@h/x`);
      },
      sleep: noWait,
    });
    const st: StatusPayload[] = [];
    const sub = t.openOutput("m", { onOutput: () => {}, onStatus: (s) => st.push(s) });
    await until(() => st.some((s) => s.message?.startsWith("bad ")));
    sub.stop();
    const msgs = st.map((s) => s.message ?? "");
    const msg = msgs.join("\n");
    for (const secret of [token, "user:", "pw-SECRET", "settings read failed"]) assert.equal(msg.includes(secret), false, `${secret} leaked: ${msg}`);
    assert.ok(msgs.includes("接続先の選択に失敗"));
    assert.ok(msgs.includes("接続先の選択に失敗 (EACCES)"));
    assert.ok(msgs.includes("bad *** http://h/x"));
  } finally {
    await f.close();
  }
});

test("input / resize / attachBytes: the first getTarget() throw (no secret known yet) becomes a fixed TerminalError, not a re-throw", async () => {
  const leak = "tok-SECRET-123456 http://user:pw-SECRET@h/x";
  const bad = createTerminals({
    getTarget: async () => {
      throw new Error(`parse failed near ${leak}`);
    },
  });
  const check = (e: unknown) => e instanceof TerminalError && e.message === "接続先の選択に失敗";
  await assert.rejects(bad.input("m", "QQ=="), check);
  await assert.rejects(bad.resize("m", 80, 24), check);
  await assert.rejects(createAttachments(bad).attachBytes("m", [{ name: "ok", data: PNG }]), check);
  const coded = createTerminals({ getTarget: async () => Promise.reject(Object.assign(new Error(leak), { code: "ENOENT" })) });
  await assert.rejects(coded.input("m", "QQ=="), (e: Error) => e.message === "接続先の選択に失敗 (ENOENT)");
  const odd = createTerminals({ getTarget: async () => Promise.reject(Object.assign(new Error(leak), { code: `x ${leak}` })) });
  await assert.rejects(odd.input("m", "QQ=="), (e: Error) => e.message === "接続先の選択に失敗");
  // our own CenterSettingsError: message passes, scrubbed with the target seen earlier
  let n = 0;
  const f = await fake(canned([[200, "{}"]]));
  try {
    const t = createTerminals({
      getTarget: async () => {
        if (n++ === 0) return target(f.base, "tok-SECRET-123456");
        throw new CenterSettingsError("設定が不正 tok-SECRET-123456");
      },
    });
    await t.input("m", "QQ==");
    await assert.rejects(t.input("m", "QQ=="), (e: Error) => e instanceof TerminalError && e.message === "設定が不正 ***");
  } finally {
    await f.close();
  }
});

// -- scrub on the paths a real fetch failure / 5xx takes (fake fetch: no server) ----------------

test("scrub: upload 5xx body and upload connect failure never carry the token or userinfo", async () => {
  const token = "tok-SECRET-123456";
  const leak = `${token} http://u:pw-SECRET@h/x`;
  const t = target("http://127.0.0.1:1", token);
  const args = { target: t, session: "m", data: PNG, kind: "image/png" };
  const bad = (e: Error) => ![token, "pw-SECRET", "u:pw"].some((s) => e.message.includes(s));
  await assert.rejects(uploadAttachment({ ...args, fetch: async () => new Response(`{"error":"boom ${leak}"}`, { status: 500 }) }), (e: Error) => e instanceof TerminalError && e.status === 500 && e.message.includes("***") && bad(e));
  await assert.rejects(uploadAttachment({ ...args, fetch: async () => new Response(`plain ${leak}`, { status: 502 }) }), (e: Error) => e.message.includes("***") && bad(e));
  await assert.rejects(uploadAttachment({ ...args, fetch: async () => Promise.reject(new TypeError(`fetch failed ${leak}`)) }), (e: Error) => e.message.includes("***") && bad(e));
});

test("scrub: input/resize connect failure (cause message) and 5xx body are scrubbed in the error and in the log", async () => {
  const token = "tok-SECRET-123456";
  const leak = `${token} http://u:pw-SECRET@h/x`;
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) };
  const bad = (e: Error) => ![token, "pw-SECRET", "u:pw"].some((s) => e.message.includes(s));
  const cause = (fetchFn: typeof fetch) => createTerminals({ getTarget: async () => target("http://127.0.0.1:1", token), fetch: fetchFn, log });
  const t1 = cause(async () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { message: `connect ${leak}` } })));
  await assert.rejects(t1.input("m", "QQ=="), (e: Error) => e instanceof TerminalError && e.message.includes("***") && bad(e));
  await assert.rejects(t1.resize("m", 80, 24), (e: Error) => e.message.includes("***") && bad(e));
  const t2 = cause(async () => Promise.reject(new TypeError(`fetch failed ${leak}`)));
  await assert.rejects(t2.input("m", "QQ=="), (e: Error) => e.message.includes("***") && bad(e));
  const t3 = cause(async () => new Response(`boom ${leak}`, { status: 500 }));
  await assert.rejects(t3.input("m", "QQ=="), (e: TerminalError) => e.status === 500 && e.message.includes("***") && bad(e));
  const all = logs.join("\n");
  assert.ok(logs.length >= 4);
  for (const s of [token, "pw-SECRET", "u:pw"]) assert.equal(all.includes(s), false, `${s} leaked in log: ${all}`);
});
