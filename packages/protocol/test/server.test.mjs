import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isLaunchMessage, isStopMessage, isAnswerMessage, isApproveMessage, isRejectMessage,
  isServerInfoMessage, isServerInfoReply, isServerMessage, isBantouMessage,
  parseServerMessage, parseServerInfoReply,
  MESSENGER_PROTOCOL, MODEL_PATTERN, isValidModel, isProtocolCompatible,
} from "../dist/index.js";

const launch = { protocol: "bantou", callType: "invoke", order: "launch", "parent-id": "w-cap", model: "sonnet", prompt: "do it", ws: "ws://c" };
const stop = { protocol: "bantou", callType: "invoke", order: "stop", "parent-id": "w-cap" };
const answer = { protocol: "bantou", callType: "reply", order: "answer", "session-id": "s1", content: "yes" };
const approve = { protocol: "bantou", callType: "reply", order: "approve", "session-id": "s1" };
const reject = { protocol: "bantou", callType: "reply", order: "reject", "session-id": "s1" };
const serverInfo = { protocol: "bantou", callType: "status", order: "server-info" };
const serverInfoReply = { ...serverInfo, version: "0.7.0" };

test("guards accept the 7 messages", () => {
  assert.ok(isLaunchMessage(launch));
  assert.ok(isStopMessage(stop));
  assert.ok(isAnswerMessage(answer));
  assert.ok(isApproveMessage(approve));
  assert.ok(isRejectMessage(reject));
  assert.ok(isServerInfoMessage(serverInfo));
  assert.ok(isServerInfoReply(serverInfoReply));
  for (const m of [launch, stop, answer, approve, reject, serverInfo]) assert.ok(isServerMessage(m), m.order);
  for (const m of [launch, stop, answer, approve, reject, serverInfo, serverInfoReply]) assert.ok(isBantouMessage(m), m.order);
  assert.ok(!isServerMessage(serverInfoReply));
});

test("each guard accepts only its own message", () => {
  assert.ok(!isLaunchMessage(stop) && !isStopMessage(launch));
  assert.ok(!isAnswerMessage(approve) && !isApproveMessage(reject) && !isRejectMessage(answer));
  assert.ok(!isServerInfoMessage(serverInfoReply) && !isServerInfoReply(serverInfo));
});

test("extra keys are allowed; answer content may be empty", () => {
  assert.ok(isLaunchMessage({ ...launch, extra: 1 }));
  assert.ok(isAnswerMessage({ ...answer, content: "" }));
});

test("guards reject invalid input", () => {
  for (const bad of [null, undefined, 1, "x", [], {}]) assert.equal(isBantouMessage(bad), false);
  assert.equal(isLaunchMessage({ ...launch, protocol: "other" }), false);
  assert.equal(isLaunchMessage({ ...launch, callType: "reply" }), false);
  assert.equal(isLaunchMessage({ ...launch, "parent-id": "" }), false);
  assert.equal(isLaunchMessage({ ...launch, model: "-x" }), false);
  assert.equal(isLaunchMessage({ ...launch, model: null }), false);
  assert.equal(isLaunchMessage({ ...launch, model: "" }), false);
  const { model: _omit, ...noModel } = launch;
  assert.equal(isLaunchMessage(noModel), true, "model は省略できる");
  assert.equal(isLaunchMessage({ ...launch, prompt: "" }), false);
  assert.equal(isLaunchMessage({ ...launch, prompt: "a\0b" }), false);
  assert.equal(isLaunchMessage({ ...launch, ws: "" }), false);
  assert.equal(isLaunchMessage({ ...launch, ws: undefined }), false);
  assert.equal(isStopMessage({ ...stop, "parent-id": undefined }), false);
  assert.equal(isAnswerMessage({ ...answer, "session-id": "" }), false);
  assert.equal(isAnswerMessage({ ...answer, content: undefined }), false);
  assert.equal(isApproveMessage({ ...approve, "session-id": undefined }), false);
  assert.equal(isRejectMessage({ ...reject, "session-id": 1 }), false);
  assert.equal(isServerInfoReply({ ...serverInfoReply, version: "1.2" }), false);
  assert.equal(isServerInfoReply({ ...serverInfoReply, version: "v1.2.3" }), false);
  assert.equal(isServerInfoReply({ ...serverInfoReply, version: 1 }), false);
});

test("launch schema is optional and must be { type: http, url, headers.Authorization }", () => {
  const schema = { type: "http", url: "http://c:1/mcp/schemas", headers: { Authorization: "Bearer x" } };
  assert.equal(isLaunchMessage({ ...launch, schema }), true);
  assert.equal(isLaunchMessage({ ...launch, schema: undefined }), true);
  assert.equal(isLaunchMessage({ ...launch, schema: { ...schema, extra: 1 } }), true);
  for (const bad of [null, "x", [], {}, { ...schema, type: "sse" }, { ...schema, url: "" }, { ...schema, url: undefined },
    { ...schema, headers: undefined }, { ...schema, headers: {} }, { ...schema, headers: { Authorization: "" } }, { ...schema, headers: { Authorization: 1 } }]) {
    assert.equal(isLaunchMessage({ ...launch, schema: bad }), false, JSON.stringify(bad));
  }
  assert.deepEqual(parseServerMessage(JSON.stringify({ ...launch, schema })).schema, schema);
});

test("callType exec is not a message; an unknown order is ignored", () => {
  assert.equal(isBantouMessage({ protocol: "bantou", callType: "exec", order: "run" }), false);
  assert.equal(isBantouMessage({ protocol: "bantou", callType: "exec" }), false);
  assert.equal(isBantouMessage({ ...launch, order: "kick" }), false);
});

test("protocol 1.x messages do not pass the guards", () => {
  const v1 = [
    { bantou: 1, type: "kick_cap", cap_id: "c1", prompt: "go" },
    { bantou: 1, type: "stop_cap", cap_id: "c1" },
    { bantou: 1, type: "status" },
    { bantou: 1, type: "hello" },
    { bantou: 1, type: "update_server", version: "0.3.1" },
    { bantou: 1, type: "task", task_id: "t", title: "x" },
    { bantou: 1, type: "worker_report", cap_id: "c", worker_id: "w", kind: "done", text: "x", at: "t" },
    { bantou: 1, type: "retire_server" },
  ];
  for (const m of v1) assert.equal(isBantouMessage(m), false, m.type);
});

test("parseServerMessage / parseServerInfoReply", () => {
  assert.deepEqual(parseServerMessage(` ${JSON.stringify(launch)}\n`), launch);
  assert.equal(parseServerMessage("hello"), undefined);
  assert.equal(parseServerMessage("{}"), undefined);
  assert.equal(parseServerMessage(JSON.stringify(serverInfoReply)), undefined);
  assert.deepEqual(parseServerInfoReply(JSON.stringify(serverInfoReply)), serverInfoReply);
  assert.equal(parseServerInfoReply(JSON.stringify(serverInfo)), undefined);
  assert.equal(parseServerInfoReply("not json"), undefined);
});

test("model pattern", () => {
  for (const ok of ["sonnet", "opus[1m]", "claude-sonnet-5-5", "a.b_c"]) assert.ok(isValidModel(ok), ok);
  for (const bad of ["", "-x", " a", "a b", 1, undefined]) assert.equal(isValidModel(bad), false, String(bad));
});

const manifest = JSON.parse(readFileSync(new URL("../messenger/protocol.json", import.meta.url), "utf8"));

test("messenger/protocol.json matches MESSENGER_PROTOCOL and the 7 messages", () => {
  assert.equal(manifest.name, MESSENGER_PROTOCOL.protocol);
  assert.equal(manifest.version, MESSENGER_PROTOCOL.version);
  assert.equal(manifest.version, "2.0.0");
  assert.deepEqual(Object.keys(manifest.messages).sort(), ["answer", "approve", "launch", "reject", "server-info", "server-info_reply", "stop"]);
  for (const [k, schema] of Object.entries(manifest.messages)) {
    assert.equal(schema.type, "object", k);
    assert.equal(schema.properties.protocol.const, "bantou", k);
  }
});

test("protocol.json required fields agree with the guards", () => {
  const m = manifest.messages;
  const samples = { launch, stop, answer, approve, reject, "server-info": serverInfo, "server-info_reply": serverInfoReply };
  for (const [k, v] of Object.entries(samples)) {
    // launch の model は省略できる（required に入らない）
    const expected = Object.keys(v).filter((f) => !(k === "launch" && f === "model"));
    assert.deepEqual([...m[k].required].sort(), expected.sort(), k);
    for (const f of Object.keys(v)) {
      if (f === "protocol" || f === "callType" || f === "order") assert.equal(m[k].properties[f].const, v[f], `${k}.${f}`);
      else assert.ok(f in m[k].properties, `${k}.${f}`);
    }
  }
  assert.equal(m.launch.properties.model.pattern, MODEL_PATTERN.source);
});

test("isProtocolCompatible: 同じ版・patch だけ違う版は互換", () => {
  assert.equal(isProtocolCompatible("2.0.0", "2.0.0"), true);
  assert.equal(isProtocolCompatible("2.0.0", "2.0.1"), true);
  assert.equal(isProtocolCompatible("2.0.12", "2.0.3"), true);
});

test("isProtocolCompatible: minor・major が違えば互換でない", () => {
  assert.equal(isProtocolCompatible("2.1.0", "2.0.0"), false);
  assert.equal(isProtocolCompatible("1.8.1", "2.0.0"), false);
  assert.equal(isProtocolCompatible("3.0.0", "2.0.0"), false);
});

test("isProtocolCompatible: 形が崩れた版は互換でない（どちらの引数でも）", () => {
  for (const bad of ["", "abc", "2.0", "2", "2.0.", "v2.0.0", "2.x.0", "2.0.0-beta", "2.0.0.2", " 2.0.0", undefined, null, 2.01]) {
    assert.equal(isProtocolCompatible(bad, "2.0.0"), false, String(bad));
    assert.equal(isProtocolCompatible("2.0.0", bad), false, String(bad));
  }
  assert.equal(isProtocolCompatible("", ""), false);
});
