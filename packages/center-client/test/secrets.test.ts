// Review 1: secrets (token, URL password) stay out of every error text, `lastError`, list `reason` and log line.
// Also: fail-closed default policy of `createCenterMcp`, a runaway retry ends with a count.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  CenterMcpError,
  CenterSettingsError,
  McpClient,
  ToolNotAllowedError,
  createCenterMcp,
  createSessionService,
  scrub,
  secretsOf,
  type Target,
} from "../src/index.ts";
import { FakeCenter } from "./helpers/fake-center.ts";

const centers: FakeCenter[] = [];
const start = async (token?: string) => {
  const c = await FakeCenter.start(token);
  centers.push(c);
  return c;
};
afterEach(async () => {
  await Promise.all(centers.splice(0).map((c) => c.close()));
});

const TOK = "tok-leak-0123456";
const PW = "pass-word-77";
const clean = (s: string | undefined, label = "") => {
  assert.notEqual(s, undefined, label);
  for (const x of [TOK, PW]) assert.ok(!s!.includes(x), `${x} in ${label}: ${s}`);
};
const withPw = (url: string) => url.replace("http://", `http://usr:${PW}@`);

// -- scrub ----------------------------------------------------------------------------

test("scrub removes the token and the URL password (raw and decoded)", () => {
  assert.equal(scrub(`a ${TOK} b`, "http://h/mcp", TOK), "a *** b");
  assert.equal(scrub(`a ${PW} b`, `http://u:${PW}@h/mcp`, undefined), "a *** b");
  // percent-encoded password: the raw form and the decoded form both go
  assert.equal(scrub("x p%40ss1 y p@ss1 z", "http://u:p%40ss1@h/mcp", undefined), "x *** y *** z");
  assert.deepEqual(secretsOf("http://u:p%40ss1@h/", undefined), ["p%40ss1", "p@ss1"]);
});

test("scrub: a password that cannot be percent-decoded is still removed in its raw form", () => {
  assert.deepEqual(secretsOf("http://u:ab%zzcd@h/mcp", "tok-12345678"), ["tok-12345678", "ab%zzcd"]);
  assert.equal(scrub("leak ab%zzcd end", "http://u:ab%zzcd@h/mcp", undefined), "leak *** end");
});

test("scrub: a short password (under 4 chars) is not blanked, userinfo left in text is dropped", () => {
  assert.equal(scrub("a abc b", "http://u:abc@h/", undefined), "a abc b");
  assert.equal(scrub("see http://usr:xy@host:1/p now", "", undefined), "see http://host:1/p now");
  assert.equal(scrub("nothing here", "not a url", undefined), "nothing here");
});

// -- McpClient: every path -------------------------------------------------------------

test("initialize JSON-RPC error that echoes the token: call(), connection().lastError and the list reason are clean", async () => {
  const mock = await start();
  mock.override = (method, _req, res) => {
    if (method !== "initialize") return false;
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: mock.log.at(-1)!.body.id, error: { code: -32000, message: `rejected ${TOK} ${PW}` } }));
    return true;
  };
  const target: Target = { url: withPw(mock.url), token: TOK, source: "remote" };
  const mcp = createCenterMcp({ settings: { selectTarget: async () => target } });
  await assert.rejects(mcp.call("rc_list"), (e: Error) => {
    assert.ok(e.message.includes("MCP error -32000"), e.message);
    clean(e.message, "call");
    return true;
  });
  clean((await mcp.connection()).lastError, "connection");
  const svc = createSessionService({ mcp });
  const l = await svc.refresh();
  assert.equal(l.reachable, false);
  clean(l.reason ?? undefined, "reason");
});

test("tools/call JSON-RPC error that echoes the token", async () => {
  const mock = await start();
  mock.override = (method, _req, res) => {
    if (method !== "tools/call") return false;
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: mock.log.at(-1)!.body.id, error: { code: -1, message: `no ${TOK}` } }));
    return true;
  };
  const client = new McpClient();
  await assert.rejects(client.callTool(withPw(mock.url), TOK, "rc_list"), (e: Error) => {
    assert.ok(e.message.includes("MCP error"), e.message);
    clean(e.message, "tools/call");
    return true;
  });
  clean(client.lastError(), "lastError");
});

test("HTTP 500 body echo (initialize and tools/call) is clean in the error, lastError and the log", async () => {
  for (const failing of ["initialize", "tools/call"]) {
    const mock = await start();
    mock.override = (method, _req, res) => {
      if (method !== failing) return false;
      res.writeHead(500, { "content-type": "text/plain" }).end(`oops ${TOK} ${PW}`);
      return true;
    };
    const log: string[] = [];
    const client = new McpClient({ logger: { info: (m) => log.push(m), warn: (m) => log.push(m) } });
    await assert.rejects(client.callTool(withPw(mock.url), TOK, "rc_list"), (e: Error) => {
      assert.ok(e.message.includes("HTTP 500") && e.message.includes("oops"), e.message);
      clean(e.message, failing);
      return true;
    });
    clean(client.lastError(), `${failing} lastError`);
    assert.ok(log.some((l) => l.includes("HTTP 500") && l.includes("oops")), `${failing} logged`);
    for (const l of log) clean(l, `${failing} log`);
  }
});

test("a failing fetch (connect error, read error) is clean in the error and the log", async () => {
  const log: string[] = [];
  const logger = { info: (m: string) => log.push(m), warn: (m: string) => log.push(m) };
  const connect = new McpClient({
    logger,
    fetch: async () => {
      throw new Error(`connect failed for ${TOK} at usr:${PW}@h`);
    },
  });
  await assert.rejects(connect.callTool("http://usr:" + PW + "@127.0.0.1:1/mcp", TOK, "rc_list"), (e: Error) => {
    assert.ok(e.message.includes("接続できない"), e.message);
    clean(e.message, "connect");
    return true;
  });
  const read = new McpClient({
    logger,
    fetch: async () =>
      new Response(
        new ReadableStream({
          pull(c) {
            c.error(new Error(`stream broke ${TOK} ${PW}`));
          },
        }),
        { status: 200 },
      ),
  });
  await assert.rejects(read.callTool("http://usr:" + PW + "@127.0.0.1:1/mcp", TOK, "rc_list"), (e: Error) => {
    assert.ok(e.message.includes("応答の読み取りに失敗"), e.message);
    clean(e.message, "read");
    return true;
  });
  assert.ok(log.length >= 2);
  for (const l of log) clean(l, "log");
});

test("a success clears lastError, and a working tools/call is logged at info", async () => {
  const mock = await start();
  const log: string[] = [];
  const client = new McpClient({ logger: { info: (m) => log.push(`i:${m}`), warn: (m) => log.push(`w:${m}`) } });
  await assert.rejects(client.callTool(mock.url, undefined, "boom"));
  assert.notEqual(client.lastError(), undefined);
  await client.callTool(mock.url, undefined, "rc_list");
  assert.equal(client.lastError(), undefined);
  assert.ok(log.includes("i:center MCP tools/call rc_list: HTTP 200"), log.join("|"));
  // ping is not logged on success
  await client.probe(mock.url, undefined);
  assert.ok(!log.some((l) => l.includes("ping")), log.join("|"));
  assert.ok(log.some((l) => l.startsWith("w:") && l.includes("tool error")), log.join("|"));
});

test("a session the center keeps forgetting is re-initialized once, not without limit", async () => {
  const mock = await start();
  mock.dropCalls = true;
  mock.limit = 12; // a runaway retry gets HTTP 500 and the counts below fail, no hang
  const client = new McpClient();
  await assert.rejects(client.callTool(mock.url, undefined, "rc_list"), /MCP session が切れた/);
  assert.equal(mock.count("initialize"), 2);
  assert.equal(mock.count("tools/call"), 2);
});

// -- createCenterMcp: fail-closed policy, selectTarget failures ------------------------------

test("createCenterMcp without a policy applies the web list; an explicit allowTool decides", async () => {
  const mock = await start();
  const target = async (): Promise<Target> => ({ url: mock.url, source: "remote" });
  const web = createCenterMcp({ settings: { selectTarget: target } });
  await assert.rejects(web.call("server_retire"), ToolNotAllowedError);
  await assert.rejects(web.call("session_delete"), ToolNotAllowedError);
  await assert.rejects(web.json("session_delete"), ToolNotAllowedError);
  assert.equal(mock.log.length, 0);
  await web.call("rc_list");
  // a policy object without allowTool is also fail-closed
  const noFn = createCenterMcp({ settings: { selectTarget: target }, policy: {} });
  await assert.rejects(noFn.call("server_retire"), ToolNotAllowedError);
  const all = createCenterMcp({ settings: { selectTarget: target }, policy: { allowTool: () => true } });
  await all.call("server_retire");
  const only = createCenterMcp({ settings: { selectTarget: target }, policy: { allowTool: (n) => n === "rc_stop" } });
  await assert.rejects(only.call("rc_list"), ToolNotAllowedError);
  await only.call("rc_stop");
});

test("selectTarget failures: an arbitrary error becomes a fixed text (also before any target was known)", async () => {
  const mock = await start();
  let fail: unknown;
  const mcp = createCenterMcp({
    settings: {
      selectTarget: async () => {
        if (fail) throw fail;
        return { url: withPw(mock.url), token: TOK, source: "remote" as const };
      },
    },
  });
  // nothing was known yet: the text of the error (a JSON parse error quotes the file) is not passed on
  fail = new SyntaxError(`Unexpected token in {"token":"${TOK}","url":"http://usr:${PW}@h"}`);
  await assert.rejects(mcp.call("rc_list"), (e: Error) => {
    assert.ok(e instanceof CenterMcpError && e.message === "接続先の選択に失敗", e.message);
    return true;
  });
  const c0 = await mcp.connection();
  assert.deepEqual(c0, { connected: false, lastError: "接続先の選択に失敗" });
  // an error code is kept
  fail = Object.assign(new Error(`EACCES: open /x/${TOK}`), { code: "EACCES" });
  await assert.rejects(mcp.json("rc_list"), (e: Error) => (assert.equal(e.message, "接続先の選択に失敗 (EACCES)"), true));
  // after the target was known and the settings changed: still fixed, nothing of the old or new secrets
  fail = undefined;
  await mcp.call("rc_list");
  fail = new Error(`new settings with ${TOK} and usr:${PW}@h and brand-new-token-999`);
  await assert.rejects(mcp.call("rc_list"), (e: Error) => {
    assert.equal(e.message, "接続先の選択に失敗");
    return true;
  });
  const c = await mcp.connection();
  assert.equal(c.connected, false);
  assert.equal(c.lastError, "接続先の選択に失敗");
});

test("selectTarget failures: a CenterSettingsError message is passed on, scrubbed with the last known target", async () => {
  const mock = await start();
  let fail: unknown;
  const mcp = createCenterMcp({
    settings: {
      selectTarget: async () => {
        if (fail) throw fail;
        return { url: withPw(mock.url), token: TOK, source: "remote" as const };
      },
    },
  });
  // learned through connection() only: the target is remembered there too
  assert.equal((await mcp.connection()).connected, true);
  fail = new CenterSettingsError(`bad settings ${TOK} ${PW}`);
  const c = await mcp.connection();
  assert.ok(c.lastError!.startsWith("bad settings"), c.lastError);
  clean(c.lastError, "connection");
  await assert.rejects(mcp.call("rc_list"), (e: Error) => (clean(e.message, "call"), e.message.startsWith("bad settings")));
});

test("json(): an unreadable body is not quoted in the error, the list reason or the log", async () => {
  const mock = await start();
  const body = `<html>secret-body-${TOK}</html>`;
  mock.rawTools.set("rc_list", body);
  mock.rawTools.set("session_list", body);
  const log: string[] = [];
  const logger = { info: (m: string) => log.push(m), warn: (m: string) => log.push(m) };
  const mcp = createCenterMcp({ settings: { selectTarget: async () => ({ url: mock.url, token: TOK, source: "remote" as const }) }, logger });
  await assert.rejects(mcp.json("rc_list"), (e: Error) => {
    assert.equal(e.message, "rc_list の結果を読めない (JSON ではない)");
    return true;
  });
  const svc = createSessionService({ mcp, logger });
  const l = await svc.refresh();
  assert.equal(l.reachable, false);
  assert.equal(l.reason, "session_list の結果を読めない (JSON ではない)");
  assert.ok(log.length > 0);
  for (const x of [...log, l.reason!]) assert.ok(!x.includes("secret-body") && !x.includes(TOK), x);
});

test("an initialized notification that fails with a body that echoes the secrets is clean in the error, lastError and the log", async () => {
  const mock = await start();
  mock.override = (method, _req, res) => {
    if (method !== "notifications/initialized") return false;
    res.writeHead(500, { "content-type": "text/plain" }).end(`notify failed ${TOK} ${PW}`);
    return true;
  };
  const log: string[] = [];
  const client = new McpClient({ logger: { info: (m) => log.push(m), warn: (m) => log.push(m) } });
  await assert.rejects(client.callTool(withPw(mock.url), TOK, "rc_list"), (e: Error) => {
    assert.ok(e.message.includes("initialized 通知が HTTP 500") && e.message.includes("notify failed"), e.message);
    clean(e.message, "error");
    return true;
  });
  clean(client.lastError(), "lastError");
  assert.ok(log.some((l) => l.includes("notifications/initialized") && l.includes("notify failed")));
  for (const l of log) clean(l, "log");
});
