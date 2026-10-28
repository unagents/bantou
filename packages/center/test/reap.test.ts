import assert from "node:assert/strict";
import { test } from "node:test";
import { listProcesses, matchOrphan, matchesRc, parsePs, reapOrphans, type ProcInfo } from "../src/reap.js";

const proc = (o: Partial<ProcInfo> & { command: string }): ProcInfo => ({ pid: 500, ppid: 1, pgid: 400, ...o });
const RC = "claude remote-control --name proj-a --permission-mode auto --continue";

test("parsePs: pid ppid pgid command に分解する（command の空白は保つ）", () => {
  const out = "    1     0     1 /sbin/init splash\n 4242     1  4242 claude remote-control --name x\n\nbad line\n";
  assert.deepEqual(parsePs(out), [
    { pid: 1, ppid: 0, pgid: 1, command: "/sbin/init splash" },
    { pid: 4242, ppid: 1, pgid: 4242, command: "claude remote-control --name x" },
  ]);
});

test("listProcesses: 実 ps で自分自身が見える", async () => {
  const procs = await listProcesses();
  assert.ok(procs, "ps が失敗した");
  const me = procs.find((p) => p.pid === process.pid);
  assert.ok(me);
  assert.equal(me.ppid, process.ppid);
});

test("matchesRc: --name は token 完全一致（foo と foobar を区別）", () => {
  assert.equal(matchesRc("claude remote-control --name foo", "foo"), true);
  assert.equal(matchesRc("claude remote-control --name foobar", "foo"), false);
  assert.equal(matchesRc("claude remote-control --name foo", "foobar"), false);
  assert.equal(matchesRc("claude remote-control --name=foo", "foo"), false);
  assert.equal(matchesRc("claude --name foo", "foo"), false);
  assert.equal(matchesRc("vim remote-control-notes --name foo", "foo"), false);
  assert.equal(matchesRc(RC, "proj-a"), true);
  assert.equal(matchesRc("claude remote-control --permission-mode auto --name proj-a", "proj-a"), true);
  assert.equal(matchesRc("claude remote-control --name", "proj-a"), false);
});

test("matchOrphan: ppid=1 のみ。自分・自分の子・ppid≠1 は除く", () => {
  assert.equal(matchOrphan(proc({ command: RC }), "proj-a"), true);
  assert.equal(matchOrphan(proc({ command: RC, ppid: 777 }), "proj-a"), false);
  assert.equal(matchOrphan(proc({ command: RC, pid: 9 }), "proj-a", { selfPid: 9 }), false);
  assert.equal(matchOrphan(proc({ command: RC, pid: 9 }), "proj-a", { ownPids: new Set([9]) }), false);
  assert.equal(matchOrphan(proc({ command: "claude remote-control --name other" }), "proj-a"), false);
  // isOrphan 注入（subreaper 環境用）
  assert.equal(matchOrphan(proc({ command: RC, ppid: 777 }), "proj-a", { isOrphan: (p) => p.ppid === 777 }), true);
});

function fake(procs: ProcInfo[] | null, behaviour: { termKills: boolean }) {
  const alive = new Set(procs?.map((p) => p.pid) ?? []);
  const sent: { pid: number; sig: string | number }[] = [];
  return {
    sent,
    deps: {
      list: async () => (procs === null ? null : procs.filter((p) => alive.has(p.pid))),
      kill: (pid: number, sig: NodeJS.Signals | 0) => {
        sent.push({ pid, sig });
        if (sig === "SIGKILL" || (sig === "SIGTERM" && behaviour.termKills)) alive.delete(Math.abs(pid));
      },
      isAlive: (pid: number) => alive.has(pid),
      graceMs: 100,
      pollMs: 5,
    },
  };
}

test("reapOrphans: SIGTERM で終われば SIGKILL は送らない。0.1.9 以前（pgid≠pid）は pid 単体", async () => {
  const f = fake([proc({ command: RC, pid: 500, pgid: 400 })], { termKills: true });
  assert.equal(await reapOrphans("proj-a", f.deps), 1);
  assert.deepEqual(f.sent, [{ pid: 500, sig: "SIGTERM" }]);
});

test("reapOrphans: 終わらなければ SIGKILL。pgid===pid は group 宛て", async () => {
  const f = fake([proc({ command: RC, pid: 500, pgid: 500 })], { termKills: false });
  assert.equal(await reapOrphans("proj-a", f.deps), 1);
  assert.deepEqual(f.sent, [
    { pid: -500, sig: "SIGTERM" },
    { pid: -500, sig: "SIGKILL" },
  ]);
});

test("reapOrphans: SIGKILL 直前に argv が変わっていたら（pid 再利用）送らない", async () => {
  const p = proc({ command: RC, pid: 500, pgid: 400 });
  const f = fake([p], { termKills: false });
  let calls = 0;
  const deps = {
    ...f.deps,
    list: async () => (++calls === 1 ? [p] : [{ ...p, command: "/usr/bin/unrelated" }]),
  };
  await reapOrphans("proj-a", deps);
  assert.deepEqual(f.sent, [{ pid: 500, sig: "SIGTERM" }]);
});

test("reapOrphans: ps が取れなければ何もしない / 一致なしなら 0 件", async () => {
  const f = fake(null, { termKills: true });
  const logs: string[] = [];
  assert.equal(await reapOrphans("proj-a", { ...f.deps, log: (m) => logs.push(m) }), 0);
  assert.deepEqual(f.sent, []);
  assert.ok(logs.length > 0);
  const g = fake([proc({ command: "claude remote-control --name other" }), proc({ command: RC, pid: 1, ppid: 5 })], { termKills: true });
  assert.equal(await reapOrphans("proj-a", g.deps), 0);
  assert.deepEqual(g.sent, []);
});
