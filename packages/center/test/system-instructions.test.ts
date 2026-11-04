import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MASTER_CAP_ROLE,
  SYSTEM_INSTRUCTION_PARTS,
  buildSystemInstructions,
  describeSystemInstructions,
  partLabel,
} from "../src/system-instructions.js";

test("部品: id は英数字と - で重複なし、version は 1 以上、文面は空でない", () => {
  const ids = SYSTEM_INSTRUCTION_PARTS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const p of SYSTEM_INSTRUCTION_PARTS) {
    assert.match(p.id, /^[a-z0-9-]+$/);
    assert.ok(Number.isInteger(p.version) && p.version >= 1);
    assert.ok(p.text({ session: "s" }).trim().length > 0);
    assert.ok(p.title.length > 0);
  }
});

test("master-cap-role: session 名が入り、作業は remote-cap に回す旨と道具名がある", () => {
  const t = MASTER_CAP_ROLE.text({ session: "pm-x" });
  assert.ok(t.includes("「pm-x」"));
  assert.ok(t.includes("自分では実装"));
  for (const tool of ["remote_send", "remote_wait", "remote_list", "worker_reply", "remote_delete"]) assert.ok(t.includes(tool), tool);
  assert.ok(t.includes("repo / branch の引数は使わず"));
});

test("buildSystemInstructions: 部品を順に空行で結合。空の部品は飛ばす。describe と partLabel", () => {
  const parts = [
    { id: "a", version: 1, title: "A", text: () => "A 文" },
    { id: "b", version: 2, title: "B", text: () => "  " },
    { id: "c", version: 3, title: "C", text: ({ session }: { session: string }) => `C ${session}` },
  ];
  assert.equal(buildSystemInstructions({ session: "s1" }, parts), "A 文\n\nC s1");
  assert.equal(buildSystemInstructions({ session: "s1" }, []), "");
  assert.deepEqual(describeSystemInstructions(parts), [
    { id: "a", version: 1, title: "A" },
    { id: "b", version: 2, title: "B" },
    { id: "c", version: 3, title: "C" },
  ]);
  assert.equal(partLabel(parts[2]!), "c@3");
  assert.equal(buildSystemInstructions({ session: "x" }), SYSTEM_INSTRUCTION_PARTS.map((p) => p.text({ session: "x" })).join("\n\n"));
});
