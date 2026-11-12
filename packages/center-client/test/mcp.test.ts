// Inputs and expectations copied from the Rust tests of the desktop (design 5.6 #5).
// M = packages/desktop/src-tauri/src/center_mcp.rs (mock center tests, `parse_messages` / `pick_response`).
// The center is a fake HTTP server on 127.0.0.1. Host names and tokens are dummies.
// Differences from Rust, on purpose: a URL's userinfo is never sent (fetch refuses it) and error text never carries it.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  CenterMcpError,
  McpClient,
  NO_TARGET,
  PROTOCOL_VERSION,
  ToolNotAllowedError,
  WEB_ALLOWED_TOOLS,
  allowWebTool,
  createCenterMcp,
  parseMessages,
  pickResponse,
  type Target,
} from "../src/index.ts";
import { FakeCenter, deadUrl } from "./helpers/fake-center.ts";

const centers: FakeCenter[] = [];
const start = async (token?: string) => {
  const c = await FakeCenter.start(token);
  centers.push(c);
  return c;
};
afterEach(async () => {
  await Promise.all(centers.splice(0).map((c) => c.close()));
});

const text = (r: { content: { text?: string }[] }) => r.content[0]!.text;

// -- body parsing ---------------------------------------------------------------

test("M:633 parses sse and json bodies", () => {
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"ok":1}}\n\n';
  let m = parseMessages("text/event-stream", sse);
  assert.deepEqual(pickResponse(m, 3), { ok: 1 });
  m = parseMessages("application/json", '{"jsonrpc":"2.0","id":4,"result":{}}');
  assert.deepEqual(pickResponse(m, 4), {});
  assert.throws(() => pickResponse(m, 5), CenterMcpError);
});

test("M:643 json-rpc error is reported", () => {
  const m = parseMessages("application/json", '{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"bad"}}');
  assert.throws(() => pickResponse(m, 1), (e: Error) => e.message === "MCP error -32602: bad");
});

test("batch json body and multi-line sse data", () => {
  const m = parseMessages("application/json", '[{"id":1,"result":1},{"id":2,"result":2}]');
  assert.equal(pickResponse(m, 2), 2);
  const sse = parseMessages("text/event-stream", 'data: {"id":7,\ndata: "result":9}\n\n');
  assert.equal(pickResponse(sse, 7), 9);
  assert.deepEqual(parseMessages("application/json", "not json"), []);
});

// -- client behaviour -----------------------------------------------------------

test("M:757 initialize then tools/call returns result as is", async () => {
  const mock = await start();
  const client = new McpClient();
  const r = await client.callTool(mock.url, undefined, "rc_list", { project: "p" });
  assert.equal(text(r), '{"tool":"rc_list","args":{"project":"p"}}');
  assert.deepEqual(mock.methods(), ["initialize", "notifications/initialized", "tools/call"]);
  assert.equal(mock.log[1]!.headers["mcp-session-id"], "s1");
  assert.equal(mock.log[2]!.headers["mcp-session-id"], "s1");
  assert.equal(mock.log[2]!.headers["mcp-protocol-version"], PROTOCOL_VERSION);
  assert.ok(String(mock.log[2]!.headers.accept).includes("text/event-stream"));
});

test("M:772 session is reused across calls", async () => {
  const mock = await start();
  const client = new McpClient();
  await client.callTool(mock.url, undefined, "rc_list");
  await client.callTool(mock.url, undefined, "server_list");
  assert.equal(mock.count("initialize"), 1);
  assert.equal(mock.count("tools/call"), 2);
  // no arguments are sent as an empty object
  assert.deepEqual(mock.log.at(-1)!.body.params.arguments, {});
});

test("M:783 lost session is reestablished on the next call", async () => {
  const mock = await start();
  const client = new McpClient();
  await client.callTool(mock.url, undefined, "rc_list");
  mock.restart();
  const r = await client.callTool(mock.url, undefined, "rc_list");
  assert.equal(text(r), '{"tool":"rc_list","args":{}}');
  assert.equal(mock.count("initialize"), 2);
  // the failed attempt, then the retry on the new session
  assert.equal(mock.count("tools/call"), 3);
  // and the new session is kept
  await client.callTool(mock.url, undefined, "rc_list");
  assert.equal(mock.count("initialize"), 2);
});

test("reestablish is tried once only: a second 404 is an error", async () => {
  const mock = await start();
  const client = new McpClient();
  await client.callTool(mock.url, undefined, "rc_list");
  mock.dropCalls = true;
  mock.limit = mock.log.length + 12; // a runaway retry gets HTTP 500 and the counts below fail, no hang
  await assert.rejects(client.callTool(mock.url, undefined, "rc_list"), /MCP session が切れた/);
  // the lost session, one new initialize, the retry: no third try
  assert.equal(mock.count("initialize"), 2);
  assert.equal(mock.count("tools/call"), 3);
});

test("M:798 changing the url opens a new session", async () => {
  const [a, b] = [await start(), await start()];
  const client = new McpClient();
  await client.callTool(a.url, undefined, "rc_list");
  await client.callTool(b.url, undefined, "rc_list");
  await client.callTool(a.url, undefined, "rc_list");
  assert.deepEqual([a.count("initialize"), b.count("initialize")], [2, 1]);
});

test("M:809 tool error result becomes an error with its text", async () => {
  const mock = await start();
  const client = new McpClient();
  await assert.rejects(client.callTool(mock.url, undefined, "boom"), (e: Error) => {
    assert.ok(e.message.includes("boom") && e.message.includes("kaboom"), e.message);
    assert.equal(client.lastError(), e.message);
    return true;
  });
});

test("M:818 unreachable center is an error and probe recovers", async () => {
  const dead = await deadUrl();
  const client = new McpClient();
  await assert.rejects(client.callTool(dead, undefined, "rc_list"), /接続できない/);
  await assert.rejects(client.probe(dead, undefined));
  assert.notEqual(client.lastError(), undefined);
  const mock = await start();
  await client.probe(mock.url, undefined);
  assert.equal(client.lastError(), undefined);
});

test("M:833 probe after center restart reconnects", async () => {
  const mock = await start();
  const client = new McpClient();
  await client.probe(mock.url, undefined);
  mock.restart();
  await client.probe(mock.url, undefined);
  assert.equal(mock.count("initialize"), 2);
});

test("M:843 every request carries the bearer token", async () => {
  const mock = await start("tok-abcdefghij");
  const client = new McpClient();
  await client.callTool(mock.url, "tok-abcdefghij", "rc_list");
  assert.deepEqual(mock.methods(), ["initialize", "notifications/initialized", "tools/call"]);
  for (const r of mock.log) assert.equal(r.headers.authorization, "Bearer tok-abcdefghij");
});

test("M:855 wrong or missing token is a readable 401", async () => {
  const mock = await start("tok-abcdefghij");
  const client = new McpClient();
  await assert.rejects(client.callTool(mock.url, "wrong-token-xyz", "rc_list"), (e: Error) => {
    assert.ok(e.message.includes("401") && e.message.includes("token が違う"), e.message);
    return true;
  });
  await assert.rejects(client.callTool(mock.url, undefined, "rc_list"), (e: Error) => {
    assert.ok(e.message.includes("401") && e.message.includes("token が必要"), e.message);
    return true;
  });
  await assert.rejects(client.probe(mock.url, undefined));
  assert.ok(client.lastError()!.includes("401"));
  // the right token still works afterwards
  await client.probe(mock.url, "tok-abcdefghij");
  assert.equal(client.lastError(), undefined);
});

test("M:917 http error message names the url without secrets", async () => {
  const mock = await start();
  // a center that answers 404 with a body to every POST (no session ever exists)
  const { createServer } = await import("node:http");
  const srv = createServer((req, res) => {
    req.resume();
    req.on("end", () => res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}'));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const addr = (srv.address() as import("node:net").AddressInfo).port;
  try {
    const url = `http://user:pw@127.0.0.1:${addr}//mcp?token=secret-q`;
    const client = new McpClient();
    await assert.rejects(client.callTool(url, "bearer-secret-zzz", "rc_list"), (e: Error) => {
      assert.ok(
        e.message.includes("HTTP 404") && e.message.includes(`http://127.0.0.1:${addr}//mcp`) && e.message.includes("not found"),
        e.message,
      );
      for (const secret of ["secret-q", "pw@", "bearer-secret-zzz"]) assert.ok(!e.message.includes(secret), `${secret} in ${e.message}`);
      return true;
    });
    assert.ok(!client.lastError()!.includes("bearer-secret-zzz"));
  } finally {
    srv.closeAllConnections();
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

test("secrets stay out of the 401 text, the connect error, the tool error and the log", async () => {
  const log: string[] = [];
  const logger = { info: (m: string) => log.push(m), warn: (m: string) => log.push(m) };
  const mock = await start("tok-abcdefghij");
  const client = new McpClient({ logger });
  const withUserinfo = mock.url.replace("http://", "http://usr:passw0rd@") + "?token=secret-q";
  await assert.rejects(client.callTool(withUserinfo, "wrong-token-xyz", "rc_list"), (e: Error) => {
    for (const s of ["usr:", "passw0rd", "secret-q", "wrong-token-xyz"]) assert.ok(!e.message.includes(s), `${s} in ${e.message}`);
    return true;
  });
  const dead = (await deadUrl()).replace("http://", "http://usr:passw0rd@") + "?token=secret-q";
  await assert.rejects(client.callTool(dead, "wrong-token-xyz", "rc_list"), (e: Error) => {
    assert.ok(e.message.includes("接続できない"));
    for (const s of ["usr:", "passw0rd", "secret-q", "wrong-token-xyz"]) assert.ok(!e.message.includes(s), `${s} in ${e.message}`);
    return true;
  });
  // a tool error whose text echoes the token
  mock.requiredToken = undefined;
  mock.errorTools.set("leak", "bad token tok-echo-secret-1 for usr");
  await assert.rejects(client.callTool(mock.url, "tok-echo-secret-1", "leak"), (e: Error) => {
    assert.ok(e.message.includes("leak が失敗") && !e.message.includes("tok-echo-secret-1"), e.message);
    assert.ok(!client.lastError()!.includes("tok-echo-secret-1"));
    return true;
  });
  assert.ok(log.length > 0);
  for (const line of log) for (const s of ["passw0rd", "secret-q", "wrong-token-xyz", "tok-echo-secret-1"]) assert.ok(!line.includes(s), `${s} in ${line}`);
});

test("M:947 changing the token opens a new session", async () => {
  const mock = await start();
  const client = new McpClient();
  await client.callTool(mock.url, "first-token-123", "rc_list");
  await client.callTool(mock.url, "first-token-123", "rc_list");
  assert.equal(mock.count("initialize"), 1);
  await client.callTool(mock.url, "second-token-45", "rc_list");
  assert.equal(mock.count("initialize"), 2);
});

test("concurrent first calls share one session", async () => {
  const mock = await start();
  const client = new McpClient();
  await Promise.all([1, 2, 3, 4, 5].map(() => client.callTool(mock.url, undefined, "rc_list")));
  assert.equal(mock.count("initialize"), 1);
  assert.equal(mock.count("tools/call"), 5);
});

test("a stateless server (no session id) works and its 404 is not a lost session", async () => {
  const { createServer } = await import("node:http");
  let seen: string[] = [];
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const b = JSON.parse(Buffer.concat(chunks).toString() || "null");
      seen.push(b.method);
      if (b.method === "initialize") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: b.id, result: {} }));
      if (b.method === "notifications/initialized") return void res.writeHead(202).end();
      res.writeHead(404, { "content-type": "text/plain" }).end("nope");
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as import("node:net").AddressInfo).port;
  try {
    const client = new McpClient();
    await assert.rejects(client.callTool(`http://127.0.0.1:${port}/mcp`, undefined, "rc_list"), /HTTP 404/);
    assert.deepEqual(seen, ["initialize", "notifications/initialized", "tools/call"]);
  } finally {
    srv.closeAllConnections();
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

// -- policy.allowTool (design 5.3) ------------------------------------------------

test("5.3 the web list is exactly the designed one", () => {
  assert.deepEqual(
    [...WEB_ALLOWED_TOOLS].sort(),
    [
      "center_info",
      "center_settings_get",
      "center_settings_update",
      "rc_list",
      "rc_start",
      "rc_stop",
      "remote_list",
      "server_list",
      "server_peers",
      "session_create",
      "session_list",
      "session_login",
      "session_login_code",
      "session_settings_get",
      "session_settings_update",
      "session_update",
      "worker_reply",
    ].sort(),
  );
  for (const t of ["session_delete", "server_retire", "rc_status", "cap_kick", ""]) assert.equal(allowWebTool(t), false, t);
});

test("5.3 a tool outside allowTool is refused before anything is sent; no policy allows every tool", async () => {
  const mock = await start();
  const web = new McpClient({ policy: { allowTool: allowWebTool } });
  await assert.rejects(web.callTool(mock.url, undefined, "server_retire", {}), ToolNotAllowedError);
  await assert.rejects(web.callTool(mock.url, undefined, "session_delete", {}), /許可されていない/);
  assert.equal(mock.log.length, 0);
  assert.equal(web.lastError(), undefined);
  await web.callTool(mock.url, undefined, "rc_list");
  assert.equal(mock.count("tools/call"), 1);
  const desktop = new McpClient();
  await desktop.callTool(mock.url, undefined, "server_retire");
  assert.equal(mock.count("tools/call"), 2);
});

// -- bound to the settings --------------------------------------------------------

test("createCenterMcp: target is chosen on every call, no target is a readable error", async () => {
  const [a, b] = [await start("tok-aaaaaaaaaaaa"), await start()];
  let target: Target | undefined;
  const mcp = createCenterMcp({ settings: { selectTarget: async () => target } });
  await assert.rejects(mcp.call("rc_list"), (e: Error) => e.message.includes(NO_TARGET));
  assert.deepEqual(await mcp.connection(), { connected: false, lastError: NO_TARGET });
  target = { url: a.url, token: "tok-aaaaaaaaaaaa", source: "remote" };
  await mcp.call("rc_list");
  target = { url: b.url, source: "remote" };
  await mcp.call("rc_list");
  assert.deepEqual([a.count("initialize"), b.count("initialize")], [1, 1]);
});

test("createCenterMcp: json() parses the text, connection() hides the userinfo and query", async () => {
  const mock = await start();
  mock.tools.set("center_info", { workspace: "/ws" });
  const url = mock.url.replace("http://", "http://u:p@") + "?x=1";
  const mcp = createCenterMcp({ settings: { selectTarget: async () => ({ url, source: "remote" }) } });
  assert.deepEqual(await mcp.json("center_info"), { workspace: "/ws" });
  const c = await mcp.connection();
  assert.deepEqual(c, { url: mock.url, source: "remote", connected: true });
  mock.rawTools.set("rc_list", "not json");
  await assert.rejects(mcp.json("rc_list"), (e: Error) => e instanceof CenterMcpError && e.message.startsWith("rc_list の結果を読めない"));
  const dead = createCenterMcp({ settings: { selectTarget: async () => ({ url: "http://u:p@127.0.0.1:1/mcp?t=s", source: "remote" }) } });
  const dc = await dead.connection();
  assert.equal(dc.connected, false);
  assert.equal(dc.url, "http://127.0.0.1:1/mcp");
  assert.ok(!dc.lastError!.includes("u:p") && !dc.lastError!.includes("t=s"));
});
