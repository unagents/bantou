import assert from "node:assert/strict";
import { test } from "node:test";
import { resessionSessionDeps, sessionWakeHooks } from "../src/resession-wiring.js";

const REF = { id: "c1:handoff-1", stored: "memory" as const };

test("sessionWakeHooks: onWake は resession.armWake へ（名前と参照つき）、onWakeAbort は disarmWake へ渡る。resession は呼ばれる時に引く（後から作っても効く）", () => {
  const calls: string[] = [];
  let res: { armWake: (n: string, h: typeof REF) => void; disarmWake: (n: string) => void } | undefined;
  const hooks = sessionWakeHooks(() => res!);
  res = { armWake: (n, h) => void calls.push(`arm:${n}:${h.id}:${h.stored}`), disarmWake: (n) => void calls.push(`disarm:${n}`) };
  hooks.onWake("pm1", REF);
  hooks.onWakeAbort("pm1");
  assert.deepEqual(calls, ["arm:pm1:c1:handoff-1:memory", "disarm:pm1"]);
});

test("resessionSessionDeps: info は一覧から名前で引き、restartFresh・sleepNow（ref あり = handoff を渡す / 無し = 渡さない）・afterWakeDelivered（clearSleepHandoff）が sessions へ渡る", async () => {
  const calls: unknown[][] = [];
  const sessions = {
    list: () => [{ name: "a" }, { name: "pm1" }] as never,
    restartFresh: async (n: string) => void calls.push(["fresh", n]) as never,
    sleep: async (n: string, o?: unknown) => void calls.push(["sleep", n, o]) as never,
    clearSleepHandoff: async (n: string, id: string) => void calls.push(["clear", n, id]),
  };
  const d = resessionSessionDeps(sessions);
  assert.equal(d.info("pm1")?.name, "pm1");
  assert.equal(d.info("zzz"), undefined);
  await d.restartFresh("pm1");
  await d.sleepNow("pm1", REF);
  await d.sleepNow("pm1");
  await d.afterWakeDelivered!("pm1", REF.id);
  assert.deepEqual(calls, [["fresh", "pm1"], ["sleep", "pm1", { handoff: REF }], ["sleep", "pm1", undefined], ["clear", "pm1", REF.id]]);
});
