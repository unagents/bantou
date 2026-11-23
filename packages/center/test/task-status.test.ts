import assert from "node:assert/strict";
import { test } from "node:test";
import type { RemoteView } from "../src/remotes.js";
import { buildTaskStatus, TASK_STATUS_MAX_LINES, TASK_STATUS_MAX_SERVERS } from "../src/task-status.js";

const NOW = Date.parse("2026-11-23T13:00:00.000Z");

const view = (o: Partial<RemoteView> & { session: string; server: string }): RemoteView => ({
  remote_id: `${o.session}-cap@${o.server}`,
  serverName: o.server,
  createdAt: "2026-11-23T12:00:00.000Z",
  state: "running",
  owners: [o.session],
  server_label: o.server,
  ...o,
});

test("cap ごとに 1 行。running は「実行中」、止まっている（done）は「止まっている」と最後の書き込みからの分。他の session の cap は出ない", () => {
  const views = [
    view({ session: "pm1", server: "srv-a" }),
    view({ session: "pm1", server: "srv-b", state: "done", finishedAt: new Date(NOW - 5 * 60_000).toISOString() }),
    view({ session: "pm2", server: "srv-a" }),
  ];
  const r = buildTaskStatus(views, "pm1", NOW);
  assert.equal(r.at, new Date(NOW).toISOString());
  assert.deepEqual(r.caps, [
    { remote_id: "pm1-cap@srv-a", server: "srv-a", line: "pm1-cap@srv-a | 実行中" },
    { remote_id: "pm1-cap@srv-b", server: "srv-b", line: "pm1-cap@srv-b | 止まっている | 最後の書き込み 5 分前" },
  ]);
  assert.equal(r.truncated, false);
  assert.equal(r.omitted, 0);
  // 本文（prompt・result など）は入らない
  assert.ok(!JSON.stringify(r).includes("pm2"));
});

test("servers: server ごとの版（server-info の答えを控えた物）。未取得は不明。同じ server は 1 行。版を出すのはここだけ", () => {
  const views = [view({ session: "pm1", server: "srv-a" }), view({ session: "pm1", server: "srv-b" }), view({ session: "pm1", server: "srv-a", remote_id: "x-cap@srv-a" })];
  const r = buildTaskStatus(views, "pm1", NOW, undefined, (s) => (s === "srv-a" ? "1.2.3" : undefined));
  assert.deepEqual(r.servers, ["srv-a | server 1.2.3", "srv-b | server 不明"]);
  assert.deepEqual(buildTaskStatus(views, "pm1", NOW).servers, ["srv-a | server 不明", "srv-b | server 不明"]);
  // cap の行には版が入らない
  assert.ok(r.caps.every((c) => !c.line.includes("1.2.3")));
});

test("remote_id で 1 つの cap に絞れる。cap が無ければ空", () => {
  const views = [view({ session: "pm1", server: "srv-a" }), view({ session: "pm1", server: "srv-b", remote_id: "other-cap" })];
  assert.deepEqual(buildTaskStatus(views, "pm1", NOW, { remote_id: "other-cap" }).caps.map((c) => c.server), ["srv-b"]);
  assert.deepEqual(buildTaskStatus(views, "pm1", NOW, { remote_id: "none" }).caps, []);
  assert.deepEqual(buildTaskStatus([], "pm1", NOW), { at: new Date(NOW).toISOString(), caps: [], servers: [], truncated: false, omitted: 0 });
});

test("行数・servers の数の上限。越えたら truncated と omitted", () => {
  const views = Array.from({ length: TASK_STATUS_MAX_LINES + 5 }, (_, i) => view({ session: "pm1", server: `srv-${i}` }));
  const r = buildTaskStatus(views, "pm1", NOW);
  assert.equal(r.caps.length, TASK_STATUS_MAX_LINES);
  assert.equal(r.truncated, true);
  assert.equal(r.omitted, 5);
  assert.equal(r.servers.length, TASK_STATUS_MAX_SERVERS);
});
