import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { inputText, sniffImageType, toBase64 } from "../api/attachment-util";
import { dropNulls, SESSION_FIELDS, toRc, toServer, toSession, toSettings, type GqlSession } from "../api/graphql-docs";

const base: GqlSession = {
  name: "a",
  state: "connected",
  sessionUrl: null,
  source: "session",
  lastError: null,
  path: "/w/a",
  contextUsage: null,
  instructions: true,
  activity: "needs_input",
  activityAt: null,
  background: null,
  remote: null,
  auth: "ok",
  loginUrl: null,
  loginError: null,
  sleeping: false,
};

describe("toSession", () => {
  test("the GraphQL enum needs_input is the screens' needs-input; the others are unchanged", () => {
    assert.equal(toSession(base).activity, "needs-input");
    assert.equal(toSession({ ...base, activity: "working" }).activity, "working");
    assert.equal(toSession({ ...base, activity: null }).activity, null);
  });

  test("remote issue lists that are null become absent, and the null fields of an issue are left out (lastOkAt keeps its null)", () => {
    const s = toSession({
      ...base,
      remote: {
        running: 1,
        waitingReply: 0,
        unreachable: [{ server: "s", remoteId: "r", lastOkAt: null, at: null, kind: null, taskId: null, detail: null }],
        lost: null,
        stopped: [{ server: "s", remoteId: "r", lastOkAt: null, at: "2026-01-01T00:00:00Z", kind: "failed", taskId: "t", detail: null }],
      },
    });
    assert.deepEqual(s.remote, {
      running: 1,
      waitingReply: 0,
      unreachable: [{ server: "s", remoteId: "r", lastOkAt: null }],
      stopped: [{ server: "s", remoteId: "r", lastOkAt: null, at: "2026-01-01T00:00:00Z", kind: "failed", taskId: "t" }],
    });
    assert.equal("lost" in s.remote!, false);
  });

  test("the selection asks for every field of the screens' Session", () => {
    for (const f of Object.keys(base)) assert.ok(SESSION_FIELDS.includes(f), f);
  });
});

describe("conversions", () => {
  test("settings: null (not set) is left out; the open JSON values are kept as they are", () => {
    assert.deepEqual(toSettings({ instructions: null, addDirs: ["/a"], mcpServers: { x: null } } as never), { addDirs: ["/a"], mcpServers: { x: null } });
    assert.deepEqual(dropNulls({ a: null, b: 0, c: "" }), { b: 0, c: "" });
  });

  test("server: lastSeen is last_seen", () => {
    assert.deepEqual(toServer({ name: "n", host: "h", protocol: "2", lastSeen: "t" }), { name: "n", host: "h", protocol: "2", last_seen: "t" });
  });

  test("rc: lastError is absent when null; pid and sessionUrl stay nullable", () => {
    const r = { project: "p", path: "/p", state: "connected" as const, pid: null, sessionUrl: null, restarts: 0, lastError: null };
    assert.deepEqual(toRc(r), { project: "p", path: "/p", state: "connected", pid: null, sessionUrl: null, restarts: 0 });
    assert.equal(toRc({ ...r, lastError: "x" }).lastError, "x");
  });
});

describe("attachment helpers", () => {
  test("image types are told by their first bytes", () => {
    assert.equal(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), "image/png");
    assert.equal(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
    assert.equal(sniffImageType(new TextEncoder().encode("GIF89a..")), "image/gif");
    assert.equal(sniffImageType(new TextEncoder().encode("RIFF\0\0\0\0WEBP")), "image/webp");
    assert.equal(sniffImageType(new TextEncoder().encode("hello world!!")), undefined);
  });

  test("base64 is the standard alphabet, also for a body larger than one chunk", () => {
    assert.equal(toBase64(new TextEncoder().encode("foo")), "Zm9v");
    assert.equal(toBase64(new TextEncoder().encode(" /a b ")), "IC9hIGIg");
    const big = new Uint8Array(0x8000 * 2 + 5).fill(65);
    assert.ok(Buffer.from(toBase64(big), "base64").equals(Buffer.from(big)));
  });

  test("the typed text has one space before and after and no Enter", () => {
    assert.equal(inputText(["/a/1.png"]), " /a/1.png ");
    assert.equal(inputText(["/a/1.png", "/a/2.jpg"]), " /a/1.png /a/2.jpg ");
  });
});
