import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { COMMON_MD, MASTER_CAP_MD } from "../src/instructions.generated.js";
import {
  BASE_SPEC,
  COMMON_SECTIONS,
  MASTER_CAP_AVAILABILITY,
  MASTER_CAP_SECTIONS,
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
  assert.ok(t.includes("「pm-x-cap」"));
  assert.ok(t.includes("自分では実装"));
  for (const tool of ["remote_send", "remote_wait", "remote_list", "worker_reply", "remote_stop"]) assert.ok(t.includes(tool), tool);
  assert.ok(t.includes("引数は server・prompt・model"));
  assert.ok(t.includes("動きは remote_list で見る"));
  assert.ok(t.includes("server から cap の名前（この session）に直接届く（center は転送しない）"));
  assert.ok(!t.includes("remote_delete"));
  assert.equal(MASTER_CAP_ROLE.version, 7);
});

test("master-cap-availability: 2 つ目に並び、いつでも受けられる・remote_send・background・turn を塞がない旨がある。label は master-cap-availability@2", () => {
  assert.equal(SYSTEM_INSTRUCTION_PARTS.length, 6);
  assert.equal(SYSTEM_INSTRUCTION_PARTS[0], BASE_SPEC);
  assert.equal(SYSTEM_INSTRUCTION_PARTS[1], MASTER_CAP_ROLE);
  assert.equal(SYSTEM_INSTRUCTION_PARTS[2], MASTER_CAP_AVAILABILITY);
  assert.equal(partLabel(MASTER_CAP_AVAILABILITY), "master-cap-availability@2");
  assert.ok(!MASTER_CAP_AVAILABILITY.title.includes("\n"));
  const t = MASTER_CAP_AVAILABILITY.text({ session: "s" });
  for (const w of ["いつでも受けられる", "remote_send", "background", "turn を塞がない", "Agent tool", "run_in_background", "例外"]) assert.ok(t.includes(w), w);
});

test("buildSystemInstructions: 出力で master-cap-availability の文面が master-cap-role の後に空行区切りで並ぶ", () => {
  const out = buildSystemInstructions({ session: "s" });
  const base = BASE_SPEC.text({ session: "s" }).trim();
  const role = MASTER_CAP_ROLE.text({ session: "s" }).trim();
  const avail = MASTER_CAP_AVAILABILITY.text({ session: "s" }).trim();
  assert.equal(out, `${base}\n\n${role}\n\n${avail}`);
  assert.ok(out.indexOf(role) < out.indexOf(avail));
});

test("describeSystemInstructions: 既定は 6 件（base-spec, role, availability, memory, coordinator, resession の順）。memory・coordinator は条件付きだと title で分かる", () => {
  assert.deepEqual(describeSystemInstructions().map((d) => `${d.id}@${d.version}`), ["base-spec@1", "master-cap-role@7", "master-cap-availability@2", "memory@1", "coordinator@4", "resession@3"]);
  assert.ok(describeSystemInstructions()[3]!.title.includes("設定がある session だけ"));
  assert.ok(describeSystemInstructions()[4]!.title.includes("統括の MCP の server"));
});

test("memory@1: memory 設定がある session だけに付く。context / recall を呼ぶ・書き込みは自動で自分では呼ばない旨がある。label は memory@1", () => {
  assert.equal(partLabel(MEMORY_USAGE), "memory@1");
  assert.ok(!MEMORY_USAGE.title.includes("\n"));
  const t = MEMORY_USAGE.text({ session: "s", memory: true });
  for (const w of ["mcp__memory__", "context", "recall", "起動した時", "判断する前", "自動で渡す", "自分では書き込み"]) assert.ok(t.includes(w), w);
  assert.deepEqual(applicableParts({ session: "s" }).map(partLabel), ["base-spec@1", "master-cap-role@7", "master-cap-availability@2"]);
  assert.deepEqual(applicableParts({ session: "s", memory: false }).map(partLabel), ["base-spec@1", "master-cap-role@7", "master-cap-availability@2"]);
  assert.deepEqual(applicableParts({ session: "s", memory: true }).map(partLabel), ["base-spec@1", "master-cap-role@7", "master-cap-availability@2", "memory@1"]);
});

test("buildSystemInstructions: memory 無しの出力は base + role + availability のみ。memory ありは末尾に memory@1 が空行区切りで付く", () => {
  const base = BASE_SPEC.text({ session: "s" }).trim();
  const role = MASTER_CAP_ROLE.text({ session: "s" }).trim();
  const avail = MASTER_CAP_AVAILABILITY.text({ session: "s" }).trim();
  assert.equal(buildSystemInstructions({ session: "s" }), `${base}\n\n${role}\n\n${avail}`);
  assert.equal(buildSystemInstructions({ session: "s", memory: false }), `${base}\n\n${role}\n\n${avail}`);
  assert.equal(buildSystemInstructions({ session: "s", memory: true }), `${base}\n\n${role}\n\n${avail}\n\n${MEMORY_USAGE.text({ session: "s" }).trim()}`);
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
  assert.equal(buildSystemInstructions({ session: "x", memory: true }), SYSTEM_INSTRUCTION_PARTS.filter((p) => p.id !== "coordinator" && p.id !== "resession").map((p) => p.text({ session: "x" })).join("\n\n"));
  // when が false の部品は文面も出ない
  const cond = [{ id: "a", version: 1, title: "A", text: () => "A 文" }, { id: "m", version: 1, title: "M", when: (c: { memory?: boolean }) => c.memory === true, text: () => "M 文" }];
  assert.equal(buildSystemInstructions({ session: "s" }, cond), "A 文");
  assert.equal(buildSystemInstructions({ session: "s", memory: true }, cond), "A 文\n\nM 文");
});

test("master-cap-role v3: 受けた指示の計画を立て、作業のまとまりごとに cap を起こし直す・まとまりが終わったら閉じる旨があり、数値の決まりは書かない", () => {
  assert.equal(MASTER_CAP_ROLE.version, 7);
  assert.equal(partLabel(MASTER_CAP_ROLE), "master-cap-role@7");
  const t = MASTER_CAP_ROLE.text({ session: "s" });
  for (const w of ["[計画と cap の起こし直し]", "計画を立てる", "作業のまとまりごとに起こし直す", "使い回し続けない", "remote_stop で止める", "新しい worker", "master-cap が決める"]) assert.ok(t.includes(w), w);
  const section = t.slice(t.indexOf("[計画と cap の起こし直し]"), t.indexOf("[自分でしてよいこと]"));
  assert.ok(!/\d/.test(section), "数値の決まりを書かない");
});

test("session 名の案内は実際に付く名前（<session>-cap）。既に -cap で終わる名前は重ねない", () => {
  assert.ok(buildSystemInstructions({ session: "bantou" }).includes("session「bantou-cap」"));
  assert.ok(!buildSystemInstructions({ session: "bantou" }).includes("session「bantou」"));
  assert.ok(buildSystemInstructions({ session: "x-cap" }).includes("session「x-cap」"));
});

const COMMON_HEADINGS = ["bantou の体制", "窓口", "記録", "権限", "置き場", "待ち"];
const MASTER_CAP_HEADINGS = ["利用者とのやりとり", "判断の材料", "始める時", "委譲", "待ち方", "窓口を預ける時・戻す時"];

test("基盤仕様: 共通の md の節見出しがそろい、base-spec の文面に全部入る。master-cap の md の節は部品の出力に全部入る", () => {
  assert.deepEqual([...COMMON_SECTIONS.keys()], COMMON_HEADINGS);
  assert.deepEqual([...MASTER_CAP_SECTIONS.keys()], MASTER_CAP_HEADINGS);
  const base = BASE_SPEC.text({ session: "s" });
  for (const h of COMMON_HEADINGS) assert.ok(base.includes(`[${h}]`), h);
  const all = buildSystemInstructions({ session: "s" });
  for (const h of [...COMMON_HEADINGS, ...MASTER_CAP_HEADINGS]) assert.ok(all.includes(`\n[${h}]\n`) || all.startsWith(`[${h}]\n`), h);
  // 節の本文が欠けずに入る（md の各行）
  for (const line of [...COMMON_MD.split("\n"), ...MASTER_CAP_MD.split("\n")].filter((l) => l.trim() !== "")) assert.ok(all.includes(line), line);
  assert.ok(!all.includes("質問しない。止まらず最後まで進む"), "worker の文面は master-cap に入らない");
});

test("基盤仕様: 待ち方に状態を読む道具の名前（remote_list と task_status）があり、turn を塞がない旨と重ならず 1 回だけ", () => {
  const t = MASTER_CAP_AVAILABILITY.text({ session: "s" });
  assert.ok(t.includes("状態を読む道具は remote_list と task_status"));
  assert.equal(t.split("[待ち方]").length, 2);
  assert.ok(!t.includes("この Mac"));
  assert.ok(t.includes("center が動いている host でしかできない作業"));
  assert.ok(t.includes("利用者の判断が要る点が出たら、他にできる事を先に進めてから聞く"));
  assert.ok(!MASTER_CAP_ROLE.text({ session: "s" }).includes("短い読み取り"));
});

test("生成物: instructions.generated.ts は md と一致する（md を直したら node scripts/gen-instructions.mjs）", () => {
  const read = (f: string): string => readFileSync(new URL(`../instructions/${f}`, import.meta.url), "utf8");
  assert.equal(COMMON_MD, read("common.md"));
  assert.equal(MASTER_CAP_MD, read("master-cap.md"));
});

test("基盤仕様: 3 層共通の md は server の指示文の元と同じ内容（server の md は共通の文面を持たない）", () => {
  const serverGen = readFileSync(new URL("../../server/server/utils/bantou/instructions.generated.ts", import.meta.url), "utf8");
  assert.ok(serverGen.includes(JSON.stringify(COMMON_MD)));
});

test("resession v2: session_resession が付く session（resession: true）だけに付く。最初の入力の本文を読む一本化で、memory の有無で文が変わらず、handoff を引かせない", async () => {
  const { RESESSION_USAGE } = await import("../src/system-instructions.js");
  assert.equal(partLabel(RESESSION_USAGE), "resession@3");
  assert.ok(!applicableParts({ session: "s" }).includes(RESESSION_USAGE));
  assert.ok(applicableParts({ session: "s", resession: true }).includes(RESESSION_USAGE));
  const t = RESESSION_USAGE.text({ session: "s", resession: true, memory: true });
  for (const w of ["session_resession", "handoff", "返事を待っている時", "turn を終える", "center が渡した引継ぎの本文", "取り出せなかった", "スリープの依頼", "スリープから起こした"]) assert.ok(t.includes(w), w);
  // 引かせる指示が無い（center が渡す）。memory の有無で文が変わらない
  assert.ok(!t.includes("mcp__memory__"));
  assert.ok(!t.includes("eventId"));
  assert.equal(RESESSION_USAGE.text({ session: "s", resession: true }), t);
});

test("指示文: 範囲の指定がある session だけ「使う server の範囲」の節が出る（範囲・置き場・remote_stop の片付け）。指定が無ければ出ない", () => {
  const on = buildSystemInstructions({ session: "s", servers: ["srv-a", "srv-x"] });
  assert.match(on, /\[使う server の範囲\]/);
  assert.match(on, /srv-a, srv-x（server の名前）/);
  assert.match(on, /settings\.servers/);
  assert.match(on, /server を指して remote_stop/);
  assert.doesNotMatch(on, /remote_delete/);
  assert.match(buildSystemInstructions({ session: "s", servers: [] }), /使える server は無い/);
  assert.doesNotMatch(buildSystemInstructions({ session: "s" }), /使う server の範囲\]/);
});
