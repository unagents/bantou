import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MASTER_CAP_AVAILABILITY,
  MASTER_CAP_ROLE,
  MEMORY_USAGE,
  SYSTEM_INSTRUCTION_PARTS,
  applicableParts,
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

test("master-cap-availability: 2 つ目に並び、いつでも受けられる・remote_send・background・turn を塞がない旨がある。label は master-cap-availability@1", () => {
  assert.equal(SYSTEM_INSTRUCTION_PARTS.length, 3);
  assert.equal(SYSTEM_INSTRUCTION_PARTS[0], MASTER_CAP_ROLE);
  assert.equal(SYSTEM_INSTRUCTION_PARTS[1], MASTER_CAP_AVAILABILITY);
  assert.equal(partLabel(MASTER_CAP_AVAILABILITY), "master-cap-availability@1");
  assert.ok(!MASTER_CAP_AVAILABILITY.title.includes("\n"));
  const t = MASTER_CAP_AVAILABILITY.text({ session: "s" });
  for (const w of ["いつでも受けられる", "remote_send", "background", "turn を塞がない", "Agent tool", "run_in_background", "例外"]) assert.ok(t.includes(w), w);
});

test("buildSystemInstructions: 出力で master-cap-availability の文面が master-cap-role の後に空行区切りで並ぶ", () => {
  const out = buildSystemInstructions({ session: "s" });
  const role = MASTER_CAP_ROLE.text({ session: "s" }).trim();
  const avail = MASTER_CAP_AVAILABILITY.text({ session: "s" }).trim();
  assert.equal(out, `${role}\n\n${avail}`);
  assert.ok(out.indexOf(role) < out.indexOf(avail));
});

test("describeSystemInstructions: 既定は 3 件（role, availability, memory の順）。memory は条件付きだと title で分かる", () => {
  assert.deepEqual(describeSystemInstructions().map((d) => `${d.id}@${d.version}`), ["master-cap-role@1", "master-cap-availability@1", "memory@1"]);
  assert.ok(describeSystemInstructions()[2]!.title.includes("設定がある session だけ"));
});

test("memory@1: memory 設定がある session だけに付く。context / recall を呼ぶ・書き込みは自動で自分では呼ばない旨がある。label は memory@1", () => {
  assert.equal(partLabel(MEMORY_USAGE), "memory@1");
  assert.ok(!MEMORY_USAGE.title.includes("\n"));
  const t = MEMORY_USAGE.text({ session: "s", memory: true });
  for (const w of ["mcp__memory__", "context", "recall", "起動した時", "判断する前", "自動で渡す", "自分では書き込み"]) assert.ok(t.includes(w), w);
  assert.deepEqual(applicableParts({ session: "s" }).map(partLabel), ["master-cap-role@1", "master-cap-availability@1"]);
  assert.deepEqual(applicableParts({ session: "s", memory: false }).map(partLabel), ["master-cap-role@1", "master-cap-availability@1"]);
  assert.deepEqual(applicableParts({ session: "s", memory: true }).map(partLabel), ["master-cap-role@1", "master-cap-availability@1", "memory@1"]);
});

test("buildSystemInstructions: memory 無しの出力は従来どおり（role + availability のみ）。memory ありは末尾に memory@1 が空行区切りで付く", () => {
  const role = MASTER_CAP_ROLE.text({ session: "s" }).trim();
  const avail = MASTER_CAP_AVAILABILITY.text({ session: "s" }).trim();
  assert.equal(buildSystemInstructions({ session: "s" }), `${role}\n\n${avail}`);
  assert.equal(buildSystemInstructions({ session: "s", memory: false }), `${role}\n\n${avail}`);
  assert.equal(buildSystemInstructions({ session: "s", memory: true }), `${role}\n\n${avail}\n\n${MEMORY_USAGE.text({ session: "s" }).trim()}`);
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
  assert.equal(buildSystemInstructions({ session: "x", memory: true }), SYSTEM_INSTRUCTION_PARTS.map((p) => p.text({ session: "x" })).join("\n\n"));
  // when が false の部品は文面も出ない
  const cond = [{ id: "a", version: 1, title: "A", text: () => "A 文" }, { id: "m", version: 1, title: "M", when: (c: { memory?: boolean }) => c.memory === true, text: () => "M 文" }];
  assert.equal(buildSystemInstructions({ session: "s" }, cond), "A 文");
  assert.equal(buildSystemInstructions({ session: "s", memory: true }, cond), "A 文\n\nM 文");
});
