import assert from "node:assert/strict";
import { test } from "node:test";
import { centerSettingsPatchSchema, guardrailSchemaNames, guardrailSchemaOf, guardrailSchemasOf, assertCenterOnly, CENTER_ONLY_MCP_ERROR, LEGACY_KEYS_ERROR, memorySchema, composeAddDirs, composeInstructions, composeOutputStyle, mergeSettings, projectSettingsPatchSchema, readSettings, settingsIssues, withoutLauncherKeys } from "../src/project-settings.js";
import { serverEntryIssues } from "../src/mcp-connections.js";

test("mergeSettings: 省略は変えない・値は上書き・null は削除・instructions の空文字は削除・未知項目は保持。元は変えない", () => {
  const cur = { instructions: "a", x: 1, y: { z: 2 } };
  assert.deepEqual(mergeSettings(cur, {}), cur);
  assert.deepEqual(mergeSettings(cur, { instructions: "b" }), { instructions: "b", x: 1, y: { z: 2 } });
  assert.deepEqual(mergeSettings(cur, { instructions: "" }), { x: 1, y: { z: 2 } });
  assert.deepEqual(mergeSettings(cur, { x: null, y: undefined }), { instructions: "a", y: { z: 2 } });
  assert.deepEqual(mergeSettings(undefined, { future: "v" }), { future: "v" });
  assert.deepEqual(mergeSettings(cur, { s: "" }), { ...cur, s: "" }); // 未知項目の空文字は値として保持
  assert.deepEqual(cur, { instructions: "a", x: 1, y: { z: 2 } });
});

test("projectSettingsPatchSchema: instructions は 16000 文字以内の string か null。未知項目は素通し。object 以外は不正", () => {
  assert.deepEqual(projectSettingsPatchSchema.parse({ instructions: "x", k: [1] }), { instructions: "x", k: [1] });
  assert.equal(projectSettingsPatchSchema.safeParse({ instructions: null }).success, true);
  assert.equal(projectSettingsPatchSchema.safeParse({ instructions: "a".repeat(16_001) }).success, false);
  assert.equal(projectSettingsPatchSchema.safeParse({ instructions: 1 }).success, false);
  assert.equal(projectSettingsPatchSchema.safeParse("x").success, false);
});

test("readSettings: 壊れた値は {}、空の instructions は落とす、未知項目は保持", () => {
  assert.deepEqual(readSettings(undefined), {});
  assert.deepEqual(readSettings([1]), {});
  assert.deepEqual(readSettings({ instructions: "", a: 1 }), { a: 1 });
  assert.deepEqual(readSettings({ instructions: 3, a: 1 }), { a: 1 });
  assert.deepEqual(readSettings({ instructions: "i", a: 1 }), { instructions: "i", a: 1 });
});

test("addDirs: schema は絶対パスの配列（20 個以内）か null。merge は空配列を削除・重複を除く。read は壊れた値を落とす", () => {
  assert.equal(projectSettingsPatchSchema.safeParse({ addDirs: ["/a", "/b/c"] }).success, true);
  assert.equal(projectSettingsPatchSchema.safeParse({ addDirs: null }).success, true);
  assert.equal(projectSettingsPatchSchema.safeParse({ addDirs: [] }).success, true);
  assert.equal(projectSettingsPatchSchema.safeParse({ addDirs: ["rel/x"] }).success, false);
  assert.equal(projectSettingsPatchSchema.safeParse({ addDirs: [""] }).success, false);
  assert.equal(projectSettingsPatchSchema.safeParse({ addDirs: "/a" }).success, false);
  assert.equal(projectSettingsPatchSchema.safeParse({ addDirs: Array.from({ length: 21 }, (_, i) => `/d${i}`) }).success, false);
  assert.deepEqual(mergeSettings({ instructions: "i" }, { addDirs: ["/a", "/b", "/a"] }), { instructions: "i", addDirs: ["/a", "/b"] });
  assert.deepEqual(mergeSettings({ addDirs: ["/a"] }, { addDirs: [] }), {});
  assert.deepEqual(mergeSettings({ addDirs: ["/a"] }, { addDirs: null }), {});
  assert.deepEqual(mergeSettings({ addDirs: ["/a"] }, { instructions: "x" }), { addDirs: ["/a"], instructions: "x" });
  assert.deepEqual(readSettings({ addDirs: ["/a", "", "/a", 3], k: 1 }), { addDirs: ["/a"], k: 1 });
  assert.deepEqual(readSettings({ addDirs: "/a" }), {});
  assert.deepEqual(readSettings({ addDirs: [] }), {});
});

test("composeInstructions / composeAddDirs: 共通が先。instructions は空行で結合、addDirs は重複を除く", () => {
  assert.equal(composeInstructions({ instructions: "共通" }, { instructions: "個別" }), "共通\n\n個別");
  assert.equal(composeInstructions({ instructions: "共通" }, {}), "共通");
  assert.equal(composeInstructions(undefined, { instructions: "個別" }), "個別");
  assert.equal(composeInstructions(undefined, undefined), "");
  assert.deepEqual(composeAddDirs({ addDirs: ["/c1", "/both"] }, { addDirs: ["/s1", "/both"] }), ["/c1", "/both", "/s1"]);
  assert.deepEqual(composeAddDirs(undefined, { addDirs: ["/s1"] }), ["/s1"]);
  assert.deepEqual(composeAddDirs({ addDirs: ["/c1"] }, undefined), ["/c1"]);
  assert.deepEqual(composeAddDirs({}, {}), []);
});

test("outputStyle: schema は 32000 文字以内の string か null。merge は空文字・null で削除。read は壊れた値を落とす。compose は session 優先で連結しない", () => {
  assert.equal(projectSettingsPatchSchema.safeParse({ outputStyle: "# style" }).success, true);
  assert.equal(projectSettingsPatchSchema.safeParse({ outputStyle: null }).success, true);
  assert.equal(projectSettingsPatchSchema.safeParse({ outputStyle: "a".repeat(32_001) }).success, false);
  assert.equal(projectSettingsPatchSchema.safeParse({ outputStyle: 1 }).success, false);
  assert.deepEqual(mergeSettings({ instructions: "i" }, { outputStyle: "s" }), { instructions: "i", outputStyle: "s" });
  assert.deepEqual(mergeSettings({ outputStyle: "s" }, { outputStyle: "" }), {});
  assert.deepEqual(mergeSettings({ outputStyle: "s" }, { outputStyle: null }), {});
  assert.deepEqual(readSettings({ outputStyle: "", a: 1 }), { a: 1 });
  assert.deepEqual(readSettings({ outputStyle: 3 }), {});
  assert.deepEqual(readSettings({ outputStyle: "s" }), { outputStyle: "s" });
  assert.equal(composeOutputStyle({ outputStyle: "共通" }, { outputStyle: "個別" }), "個別");
  assert.equal(composeOutputStyle({ outputStyle: "共通" }, {}), "共通");
  assert.equal(composeOutputStyle(undefined, { outputStyle: "個別" }), "個別");
  assert.equal(composeOutputStyle({ outputStyle: "共通" }, { outputStyle: "" }), "共通");
  assert.equal(composeOutputStyle(undefined, undefined), "");
});

test("servers: schema は server の名前（agent-messenger の名前）の配列（50 個以内）か null。形式が違うもの・多すぎるものは不正。merge は重複を除き、空配列は保存（= 使わない）、null で削除。read は壊れた値を未設定にする", async () => {
  const { composeServers, serverAllowed, SERVERS_MAX } = await import("../src/project-settings.js");
  assert.equal(projectSettingsPatchSchema.safeParse({ servers: ["lenovo", "mac-200.local", "srv-aaaaaaaaaa"] }).success, true);
  assert.equal(projectSettingsPatchSchema.safeParse({ servers: null }).success, true);
  assert.equal(projectSettingsPatchSchema.safeParse({ servers: [] }).success, true);
  for (const bad of [[""], ["a b"], [".x"], ["host/x"], [1], "lenovo", Array.from({ length: SERVERS_MAX + 1 }, (_, i) => `h${i}`)]) {
    assert.equal(projectSettingsPatchSchema.safeParse({ servers: bad }).success, false, JSON.stringify(bad).slice(0, 30));
  }
  assert.deepEqual(mergeSettings({ instructions: "i" }, { servers: ["a", "b", "a"] }), { instructions: "i", servers: ["a", "b"] });
  assert.deepEqual(mergeSettings({ servers: ["a"] }, { servers: [] }), { servers: [] }, "空配列は保存する（未設定と区別）");
  assert.deepEqual(mergeSettings({ servers: ["a"] }, { servers: null }), {});
  assert.deepEqual(mergeSettings({ servers: ["a"] }, { instructions: "x" }), { servers: ["a"], instructions: "x" });
  assert.deepEqual(readSettings({ servers: ["a", "", "a", 3] }), { servers: ["a"] });
  assert.deepEqual(readSettings({ servers: [] }), { servers: [] });
  assert.deepEqual(readSettings({ servers: "lenovo" }), {}, "壊れた値は未設定（全 server を止めない）");
  // composeServers は session の値だけを見る（共通は引数にも無い）
  assert.equal(composeServers(undefined), undefined);
  assert.equal(composeServers({}), undefined);
  assert.deepEqual(composeServers({ servers: ["s"] }), ["s"]);
  assert.deepEqual(composeServers({ servers: [] }), []);
  // 共通設定: schema に servers は無い。保存済みに残っていても読み捨てる
  const { centerSettingsPatchSchema, readCenterSettings } = await import("../src/project-settings.js");
  assert.equal("servers" in centerSettingsPatchSchema.shape, false);
  assert.deepEqual(readCenterSettings({ instructions: "i", servers: ["a"] }), { instructions: "i" });
  // 範囲の判定: server の名前（agent-messenger の名前。host に渡す）で、大文字小文字を区別しない。undefined は全部
  assert.equal(serverAllowed(undefined, {}), true);
  assert.equal(serverAllowed([], { host: "h" }), false);
  assert.equal(serverAllowed(["LENOVO"], { host: "lenovo" }), true);
  assert.equal(serverAllowed(["srv-a"], { host: "srv-a" }), true);
  assert.equal(serverAllowed(["srv-a"], { host: "srv-b" }), false);
  assert.equal(serverAllowed(["lenovo"], {}), false, "名前が分からない server は指定では通らない");
});

test("memorySchema（CLI の検証）: url は http/https の絶対 URL（user:pass@ 不可・2048 文字以内）、token は header 安全な ASCII（4096 文字以内）、agentId は英数字と _ - （64 文字以内）。null は削除", () => {
  const ok = (memory: unknown) => memorySchema.safeParse(memory).success;
  assert.equal(ok({ url: "http://mem.local:3000/mcp" }), true);
  assert.equal(ok({ url: "https://mem.example/mcp", token: "abc.DEF-123_~+/=", agentId: "pm_1-x" }), true);
  assert.equal(ok({ url: "https://mem.example/mcp", token: "", agentId: "" }), true); // 空は「無し」
  for (const bad of [
    {},
    { url: "" },
    { url: "mem.local/mcp" },
    { url: "/mcp" },
    { url: "ftp://mem.local/mcp" },
    { url: "file:///etc/passwd" },
    { url: "javascript:alert(1)" },
    { url: "http://user:pw@mem.local/mcp" },
    { url: "https://user@mem.local/mcp" },
    { url: " http://h/mcp" },
    { url: "http://h/mcp " },
    { url: "http://h/mcp\n" },
    { url: "http://h/m\ncp" },
    { url: "http://h/m\tcp" },
    { url: "http://h/m cp" },
    { url: "http://h/m\x00cp" },
    { url: "http://h/m\x7fcp" },
    { url: "http://h/mcp?k=${BANTOU_SESSION_TOKEN}" },
    { url: "http://${HOST}/mcp" },
    { url: "wss://h/mcp" },
    { url: "http://" + "a".repeat(2048) + ".example/" },
    { url: "http://m/mcp", token: "a b" },
    { url: "http://m/mcp", token: "a\nb" },
    { url: "http://m/mcp", token: "あ" },
    { url: "http://m/mcp", token: "t".repeat(4097) },
    { url: "http://m/mcp", agentId: "a b" },
    { url: "http://m/mcp", agentId: "日本語" },
    { url: "http://m/mcp", agentId: "a".repeat(65) },
    { url: "http://m/mcp", token: 1 },
    { url: "http://m/mcp", extra: 1 },
    "http://m/mcp",
  ]) assert.equal(ok(bad), false, JSON.stringify(bad).slice(0, 80));
  assert.equal(ok({ url: "http://m/mcp", token: "t".repeat(4096), agentId: "a".repeat(64) }), true);
  assert.equal(ok({ url: "HTTP://H/mcp" }), true);
  assert.equal(ok({ url: "http://h/mcp?a=1%24%7BX%7D" }), true); // エンコード済みは展開されない
});

test("mergeSettings は memory を普通の MCP の設定の形で入れる（旧形式 { url, token, agentId } は読み替える）。null で消す。既存の他の項目は変えない", () => {
  assert.deepEqual(mergeSettings({ instructions: "i" }, { memory: { url: "http://b/mcp" } } as never), { instructions: "i", memory: { type: "http", url: "http://b/mcp" } });
  assert.deepEqual(mergeSettings({ instructions: "i" }, { memory: { url: "http://b/mcp", token: "T1", agentId: "ag" } } as never), {
    instructions: "i",
    memory: { type: "http", url: "http://b/mcp", headers: { Authorization: "Bearer T1", "X-Agent-Id": "ag" } },
  });
  const def = { type: "http", url: "http://m/mcp", headers: { Authorization: "Bearer M" } };
  assert.deepEqual(mergeSettings({ instructions: "i" }, { memory: def } as never), { instructions: "i", memory: def });
  assert.deepEqual(mergeSettings({ instructions: "i", memory: def }, { memory: null } as never), { instructions: "i" });
});

test("readSettings は memory を普通の MCP の設定の形で読む（旧形式は読み替える。object でなければ落とす）", () => {
  assert.deepEqual(readSettings({ instructions: "i", memory: { url: "http://a/mcp", token: "T" } }), {
    instructions: "i",
    memory: { type: "http", url: "http://a/mcp", headers: { Authorization: "Bearer T" } },
  });
  const stdio = { command: "npx", args: ["-y", "mem"], env: { KEY: "V" } };
  assert.deepEqual(readSettings({ memory: stdio }), { memory: stdio });
  assert.deepEqual(readSettings({ instructions: "i", memory: "x" }), { instructions: "i" });
});

test("assertCenterOnly: 起動元以外は memory・mcpServers（null も）を理由つきで断る。起動元は通す。旧設定の項目は誰からも断る。値は文に出さない", () => {
  for (const k of ["memory", "mcpServers"]) {
    assert.throws(() => assertCenterOnly({ [k]: { url: "http://a/mcp", token: "SECRET" } }), (e: Error) => e.message === CENTER_ONLY_MCP_ERROR && !e.message.includes("SECRET"), k);
    assert.throws(() => assertCenterOnly({ [k]: null }), (e: Error) => e.message === CENTER_ONLY_MCP_ERROR, `${k}: null`);
    assert.throws(() => assertCenterOnly({ [k]: {} }, { launcher: false }), (e: Error) => e.message === CENTER_ONLY_MCP_ERROR, `${k}: launcher false`);
    assert.doesNotThrow(() => assertCenterOnly({ [k]: { url: "http://a/mcp" } }, { launcher: true }), k);
    assert.doesNotThrow(() => assertCenterOnly({ [k]: null }, { launcher: true }), `${k}: null`);
  }
  assert.match(CENTER_ONLY_MCP_ERROR, /center を起動した所/);
  for (const k of ["mcp", "mcpConnections", "mcpSecrets", "coordinator"]) {
    assert.throws(() => assertCenterOnly({ [k]: { url: "http://x/?q=SECRETVAL" } }), (e: Error) => e.message === CENTER_ONLY_MCP_ERROR && !e.message.includes("SECRETVAL"), k);
    assert.throws(() => assertCenterOnly({ [k]: null }), (e: Error) => e.message === CENTER_ONLY_MCP_ERROR, `${k}: null`);
    assert.throws(() => assertCenterOnly({ [k]: { url: "http://x/?q=SECRETVAL" } }, { launcher: true }), (e: Error) => e.message === LEGACY_KEYS_ERROR && !e.message.includes("SECRETVAL"), `${k}: launcher`);
  }
  assert.doesNotThrow(() => assertCenterOnly({ instructions: "x" }));
  assert.doesNotThrow(() => assertCenterOnly(undefined));
});

test("withoutLauncherKeys: 読みの応答から memory・mcpServers を除く（他の項目は残す。元は変えない）", () => {
  const s = { instructions: "i", memory: { type: "http", url: "u" }, mcpServers: { a: { command: "x" } } };
  assert.deepEqual(withoutLauncherKeys(s), { instructions: "i" });
  assert.ok("memory" in s && "mcpServers" in s);
});

test("settingsIssues: mcpServers は普通の MCP の設定・組み込み・旧形式。stdio は command、url の type は url、args は配列、env・headers は文字列の値。名前の予約・共通の null は不正。値は文に出さない", () => {
  const issues = (patch: object, scope: "common" | "session" = "common") => settingsIssues(patch, scope, serverEntryIssues);
  // 通るもの
  assert.deepEqual(issues({ mcpServers: { s: { command: "npx", args: ["-y", "pkg"], env: { K: "SECRETV" } }, h: { type: "http", url: "https://h/mcp", headers: { Authorization: "Bearer SECRETV" } }, e: { type: "sse", url: "https://e/sse" } } }), []);
  assert.deepEqual(issues({ mcpServers: { "bantou-coordinator": { type: "http", url: "http://127.0.0.1:7911/mcp", headers: { Authorization: "Bearer SECRETV" } } } }, "session"), []);
  // 独自の書き方（transport: builtin・auth.env）は受けない
  assert.notDeepEqual(issues({ mcpServers: { "bantou-coordinator": { transport: "builtin", builtin: "coordinator" } } }, "session"), []);
  assert.notDeepEqual(issues({ mcpServers: { tools: { transport: "http", url: "https://t/mcp", auth: { env: "BANTOU_MCP_KEY_T" } } } }), []);
  assert.deepEqual(issues({ mcpServers: { tools: null } }, "session"), []);
  assert.deepEqual(issues({ mcpServers: { tools: { url: "https://t2/mcp" } } }, "session"), []); // 旧形式の項目ごとの上書き
  assert.deepEqual(issues({ mcpServers: null, memory: null }), []);
  assert.deepEqual(issues({ memory: { type: "http", url: "https://m/mcp", headers: { Authorization: "Bearer SECRETV" } } }), []);
  assert.deepEqual(issues({ memory: { url: "https://m/mcp", token: "SECRETV" } }), []); // 旧形式
  // 断るもの（値は出さない）
  const bad: [object, RegExp, ("common" | "session")?][] = [
    [{ mcpServers: { s: { args: ["SECRETV"] } } }, /mcpServers\.s: stdio の server には command/],
    [{ mcpServers: { s: { args: ["x"] } } }, /mcpServers\.s: stdio の server には command/, "session"],
    [{ mcpServers: { h: { type: "http", headers: { Authorization: "Bearer SECRETV" } } } }, /mcpServers\.h: type http の server には url/],
    [{ mcpServers: { s: { command: "npx", args: "SECRETV" } } }, /mcpServers\.s: args は文字列の配列/],
    [{ mcpServers: { s: { command: "npx", env: { K: 1 } } } }, /mcpServers\.s: env は文字列の値の object/],
    [{ mcpServers: { h: { type: "http", url: "u", headers: { A: 2 } } } }, /mcpServers\.h: headers は文字列の値の object/],
    [{ mcpServers: { s: "SECRETV" } }, /mcpServers\.s:/],
    [{ mcpServers: { s: null } }, /null は session の設定でだけ/],
    [{ mcpServers: { "bad name": { command: "x" } } }, /名前は英数字と _ - のみ/],
    [{ memory: { type: "http", headers: { Authorization: "Bearer SECRETV" } } }, /memory: type http の server には url/],
    [{ memory: { args: ["SECRETV"] } }, /memory: stdio の server には command/],
    [{ mcpServers: [] }, /mcpServers は/],
  ];
  for (const name of ["bantou", "bantou-messenger", "memory"]) bad.push([{ mcpServers: { [name]: { command: "x" } } }, new RegExp(`mcpServers\\.${name}: ${name} は center が組み立てる名前`)]);
  for (const [patch, re, scope] of bad) {
    const out = issues(patch, scope ?? "common");
    assert.ok(out.length > 0, JSON.stringify(patch));
    assert.ok(out.some((i) => re.test(i)), `${JSON.stringify(patch)}: ${out.join(" / ")}`);
    assert.ok(!out.join(" ").includes("SECRETV"), JSON.stringify(patch));
  }
});

const G = (schema: string, templates?: Record<string, string>) => ({ schema, ...(templates ? { templates } : {}) });
const N = (schema: string, templates: Record<string, string> = {}) => ({ schema, templates });

test("guardrailSchemas: patch の schema は名前が [A-Za-z0-9][A-Za-z0-9._-]*（大文字小文字は別）・中身は { schema: 文字列, templates?: 相対 path → 文字列 }。項目全体の null・名前の null は可", () => {
  assert.equal(centerSettingsPatchSchema.safeParse({ guardrailSchemas: { "spec-driven_1.v2": G("name: x\n"), Abc: G("", { "a/b.md": "T" }) } }).success, true);
  assert.equal(centerSettingsPatchSchema.safeParse({ guardrailSchemas: { old: null } }).success, true);
  assert.equal(centerSettingsPatchSchema.safeParse({ guardrailSchemas: null }).success, true);
  for (const bad of ["a b", "a/b", "", "日本語", "-a", ".a", "_a", "a%2Fb"]) assert.equal(centerSettingsPatchSchema.safeParse({ guardrailSchemas: { [bad]: G("x") } }).success, false, bad);
  assert.equal(centerSettingsPatchSchema.safeParse({ guardrailSchemas: ["x"] }).success, false);
  assert.equal(centerSettingsPatchSchema.safeParse({ guardrailSchemas: "x" }).success, false);
});

test("guardrailSchemas: patch の定義の形が違えば断る（任意の JSON・schema が文字列でない・templates の中身が文字列でない・相対でない path）", () => {
  const bad = (v: unknown) => centerSettingsPatchSchema.safeParse({ guardrailSchemas: { a: v } }).success;
  assert.equal(bad("A"), false, "文字列だけ");
  assert.equal(bad({ k: [1] }), false, "schema が無い");
  assert.equal(bad({ schema: 1 }), false);
  assert.equal(bad({ schema: "s", templates: { "a.md": 1 } }), false);
  assert.equal(bad({ schema: "s", templates: ["x"] }), false);
  for (const p of ["", "/abs.md", "../x.md", "a/../x.md", "a//b.md", "./a.md", "a\\b.md"]) assert.equal(bad({ schema: "s", templates: { [p]: "T" } }), false, `path ${JSON.stringify(p)}`);
  assert.equal(bad({ schema: "s", templates: { "sub/dir/a.md": "T", "b.yaml": "" } }), true);
});

test("mergeSettings guardrailSchemas: 名前ごとに足す・変える（定義は丸ごと置き換え）・消す。他の名前・他の項目は変えない。空になれば項目ごと消す。元は変えない", () => {
  const cur = { instructions: "i", guardrailSchemas: { a: N("A"), b: N("B", { "t.md": "T" }) } };
  const added = mergeSettings(cur, { guardrailSchemas: { c: G("C") } });
  assert.deepEqual(added, { instructions: "i", guardrailSchemas: { a: N("A"), b: N("B", { "t.md": "T" }), c: N("C") } }, "templates 省略は空で保存");
  assert.deepEqual(mergeSettings(cur, { guardrailSchemas: { b: G("B2") } }).guardrailSchemas, { a: N("A"), b: N("B2") }, "templates も丸ごと置き換わる");
  assert.deepEqual(mergeSettings(cur, { guardrailSchemas: { a: null } }).guardrailSchemas, { b: N("B", { "t.md": "T" }) });
  assert.deepEqual(mergeSettings(cur, { guardrailSchemas: { a: null, b: null } }), { instructions: "i" });
  assert.deepEqual(mergeSettings(cur, { guardrailSchemas: null }), { instructions: "i" });
  assert.deepEqual(mergeSettings(cur, { guardrailSchemas: {} }), cur);
  assert.deepEqual(mergeSettings(cur, { instructions: "j" }).guardrailSchemas, cur.guardrailSchemas);
  assert.deepEqual(mergeSettings(undefined, { guardrailSchemas: { z: G("") } }), { guardrailSchemas: { z: N("") } }, "空文字の schema も値として保存");
  assert.deepEqual(cur, { instructions: "i", guardrailSchemas: { a: N("A"), b: N("B", { "t.md": "T" }) } });
});

test("mergeSettings guardrailSchemas: YAML・templates の中身は解釈せずそのまま保存。__proto__ という名前・path でも prototype を汚さない。読めない形の値は入れない", () => {
  const yaml = "name: x\nartifacts:\n  - id: a\n    generates: \"${x}\"\n\t# tab と日本語\n";
  assert.equal(mergeSettings({}, { guardrailSchemas: { s: G(yaml, { "w.md": "# {{x}}\n" }) } }).guardrailSchemas?.s?.schema, yaml);
  const patch = JSON.parse('{"guardrailSchemas":{"p":{"schema":"S","templates":{"__proto__":"P"}}}}');
  const out = mergeSettings({}, patch);
  assert.equal(Object.hasOwn(out.guardrailSchemas?.p?.templates ?? {}, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(out.guardrailSchemas?.p?.templates), Object.prototype);
  assert.equal(({} as Record<string, unknown>).P, undefined);
  assert.deepEqual(mergeSettings({}, JSON.parse('{"guardrailSchemas":{"x":"S","y":{"schema":3}}}')), {}, "zod を通らない経路でも読めない形は入れない");
});

test("readSettings / guardrailSchemasOf: 壊れた値・規則外の名前・旧形（任意の JSON）・null は落とす。空は未設定。名前の昇順の一覧と 1 件の取得", () => {
  assert.deepEqual(readSettings({ guardrailSchemas: ["x"] }), {});
  assert.deepEqual(readSettings({ guardrailSchemas: "x" }), {});
  assert.deepEqual(readSettings({ guardrailSchemas: {} }), {});
  assert.deepEqual(readSettings({ guardrailSchemas: { "bad name": G("x"), ok: G("O"), nul: null, old: "A", old2: { k: 1 } } }), { guardrailSchemas: { ok: N("O") } });
  assert.deepEqual(readSettings({ guardrailSchemas: { b: G("1"), a: G("2") }, future: 1 }), { guardrailSchemas: { b: N("1"), a: N("2") }, future: 1 });
  const s = { guardrailSchemas: { b: G("B"), a: G("A", { "t.md": "T" }), C: G("c") } };
  assert.deepEqual(guardrailSchemaNames(s), ["C", "a", "b"]);
  assert.deepEqual(guardrailSchemaOf(s, "a"), N("A", { "t.md": "T" }));
  assert.equal(guardrailSchemaOf(s, "c"), undefined, "大文字小文字は別の名前");
  assert.equal(guardrailSchemaOf(s, "none"), undefined);
  assert.equal(guardrailSchemaOf(s, "toString"), undefined);
  assert.deepEqual(guardrailSchemasOf(undefined), {});
  assert.deepEqual(guardrailSchemaNames({}), []);
});

test("guardrailSchemas は launcher 専用ではない: 起動元以外も書ける。読みの応答からも除かれない", () => {
  assert.doesNotThrow(() => assertCenterOnly({ guardrailSchemas: { a: G("A") } }, { launcher: false }));
  assert.doesNotThrow(() => assertCenterOnly({ guardrailSchemas: null }, { launcher: false }));
  assert.deepEqual(withoutLauncherKeys({ guardrailSchemas: { a: N("A") }, memory: {} }), { guardrailSchemas: { a: N("A") } });
});

test("guardrailSchemas は session の設定には置けない（null＝削除は可）。center 共通の設定では可", () => {
  const check = () => [];
  assert.match(settingsIssues({ guardrailSchemas: { a: G("A") } }, "session", check).join(" "), /guardrailSchemas/);
  assert.deepEqual(settingsIssues({ guardrailSchemas: null }, "session", check), []);
  assert.deepEqual(settingsIssues({ guardrailSchemas: { a: G("A") } }, "common", check), []);
});
