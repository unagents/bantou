import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { toNodeListener, createApp, defineEventHandler, toWebRequest } from "h3";
import { runBash, setBashWorkspace, type BashCaller, type BashResult } from "../../../../server/utils/bantou/bash";
import { handleMcpRequest, startMcpListener } from "../../../../server/utils/bantou/mcp";

// 一時 dir は test 専用（cwd 配下。本物の workspace には触れない）
let base: string;
let ws: string;
let outside: string;

const exists = (p: string): Promise<boolean> => lstat(p).then(() => true, () => false);
const put = async (p: string, body = "x"): Promise<void> => {
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, body);
};

const capA: BashCaller = { kind: "cap", capId: "capA" };
const capB: BashCaller = { kind: "cap", capId: "capB" };
const w1: BashCaller = { kind: "worker", capId: "capA", workerId: "w1" };
const w2: BashCaller = { kind: "worker", capId: "capA", workerId: "w2" };

const rmPaths = (c: BashCaller, paths: string[], recursive?: boolean): Promise<BashResult> =>
  runBash(ws, c, { action: "rm", paths, recursive });

before(async () => {
  base = await mkdtemp(join(process.cwd(), ".bash-test-"));
  outside = join(base, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.txt"), "secret");
});
after(async () => {
  setBashWorkspace(undefined);
  await rm(base, { recursive: true, force: true });
});

/** 各 test で作り直す workspace: caps/capA capB, workers/w1 w2 (owner capA), w3 (owner capB) */
async function fresh(): Promise<void> {
  ws = join(base, `ws-${Math.random().toString(36).slice(2)}`);
  for (const [kind, id, owner] of [
    ["caps", "capA"], ["caps", "capB"], ["workers", "w1", "capA"], ["workers", "w2", "capA"], ["workers", "w3", "capB"],
  ] as const) {
    const d = join(ws, kind, id);
    await mkdir(join(d, "logs"), { recursive: true });
    await writeFile(join(d, "state.json"), "{}");
    await writeFile(join(d, "logs", "mcp.json"), "{}");
    if (owner) await writeFile(join(d, "logs", "owner.json"), JSON.stringify({ cap_id: owner }));
  }
}

const w1dir = (): string => join(ws, "workers", "w1");
const reasons = (r: BashResult): string[] => r.skipped.map((s) => s.reason);

test("rm: 自分の dir 配下の file を消す", async () => {
  await fresh();
  await put(join(w1dir(), "a.txt"));
  await put(join(w1dir(), "sub", "b.txt"));
  const r = await rmPaths(w1, ["a.txt", "sub/b.txt"]);
  assert.deepEqual(r, { removed: ["a.txt", "sub/b.txt"], skipped: [] });
  assert.ok(!(await exists(join(w1dir(), "a.txt"))));
  assert.ok(await exists(join(w1dir(), "sub")));
});

test("rm: 存在しない path は skipped", async () => {
  await fresh();
  const r = await rmPaths(w1, ["nope", "no/such/dir/x"]);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(reasons(r), ["存在しない", "存在しない"]);
});

test("rm: 絶対パス・.. ・空文字・自分の dir そのもの・~ は拒否", async () => {
  await fresh();
  await put(join(ws, "workers", "w2", "other.txt"));
  const abs = join(outside, "secret.txt");
  const r = await rmPaths(w1, [abs, "../w2/other.txt", "a/../../w2/other.txt", "", ".", "./", "./.", "sub/..", "~/x", "C:/x", "a\\b"]);
  assert.deepEqual(r.removed, []);
  assert.equal(r.skipped.length, 11);
  assert.ok(await exists(abs));
  assert.ok(await exists(join(ws, "workers", "w2", "other.txt")));
  assert.ok(await exists(w1dir()));
  assert.match(r.skipped[0]!.reason, /絶対パス/);
  assert.match(r.skipped[4]!.reason, /dir そのもの/);
});

test("rm: state.json と logs/ は回避形（./ ・ 末尾 / ・ logs/../ ・ 大文字小文字 ・ 配下）でも拒否", async () => {
  await fresh();
  const paths = ["state.json", "./state.json", "STATE.JSON", "State.Json", "logs", "./logs", "logs/", "LOGS", "Logs/", "logs/mcp.json", "logs/../logs", "x/../logs", "logs/./", "./logs/owner.json"];
  const r = await rmPaths(w1, paths, true);
  assert.deepEqual(r.removed, []);
  assert.equal(r.skipped.length, paths.length);
  assert.ok(await exists(join(w1dir(), "state.json")));
  assert.ok(await exists(join(w1dir(), "logs", "mcp.json")));
  assert.ok(await exists(join(w1dir(), "logs", "owner.json")));
});

test("rm: dir は recursive: true の時だけ消す", async () => {
  await fresh();
  await put(join(w1dir(), "d", "deep", "f.txt"));
  const no = await rmPaths(w1, ["d"]);
  assert.deepEqual(no.removed, []);
  assert.match(no.skipped[0]!.reason, /recursive: true/);
  assert.ok(await exists(join(w1dir(), "d", "deep", "f.txt")));
  const noFalse = await rmPaths(w1, ["d"], false);
  assert.equal(noFalse.removed.length, 0);
  const yes = await rmPaths(w1, ["d/"], true);
  assert.deepEqual(yes.removed, ["d/"]);
  assert.ok(!(await exists(join(w1dir(), "d"))));
});

test("rm: symlink は辿らず link 自体を消す（file / dir 向き、recursive 無しでも）", async () => {
  await fresh();
  await symlink(join(outside, "secret.txt"), join(w1dir(), "lnk-file"));
  await symlink(outside, join(w1dir(), "lnk-dir"));
  const r = await rmPaths(w1, ["lnk-file", "lnk-dir"]);
  assert.deepEqual(r.removed, ["lnk-file", "lnk-dir"]);
  assert.ok(!(await exists(join(w1dir(), "lnk-file"))));
  assert.ok(!(await exists(join(w1dir(), "lnk-dir"))));
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "secret");
});

test("rm: 親 dir が範囲外を指す symlink 経由は拒否（脱出防止）", async () => {
  await fresh();
  await symlink(outside, join(w1dir(), "esc"));
  const r = await rmPaths(w1, ["esc/secret.txt", "esc/nope"], true);
  assert.deepEqual(r.removed, []);
  assert.equal(r.skipped.length, 2);
  assert.match(r.skipped[0]!.reason, /範囲外/);
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "secret");
  // 他の worker の dir を指す symlink も同じ
  await put(join(ws, "workers", "w2", "keep.txt"));
  await symlink(join(ws, "workers", "w2"), join(w1dir(), "to-w2"));
  const r2 = await rmPaths(w1, ["to-w2/keep.txt"]);
  assert.deepEqual(r2.removed, []);
  assert.ok(await exists(join(ws, "workers", "w2", "keep.txt")));
});

test("rm: 自分の dir 内の別名 symlink 経由で logs/ を消そうとしても拒否", async () => {
  await fresh();
  await symlink(join(w1dir(), "logs"), join(w1dir(), "alias"));
  const r = await rmPaths(w1, ["alias/mcp.json", "alias/owner.json"], true);
  assert.deepEqual(r.removed, []);
  assert.match(r.skipped[0]!.reason, /logs/);
  assert.ok(await exists(join(w1dir(), "logs", "mcp.json")));
  // alias 自体（link）は消せる
  const r2 = await rmPaths(w1, ["alias"]);
  assert.deepEqual(r2.removed, ["alias"]);
  assert.ok(await exists(join(w1dir(), "logs", "mcp.json")));
});

test("rm: recursive 削除は dir 内の symlink を辿らない（link だけ消え、指す先は残る）", async () => {
  await fresh();
  await put(join(w1dir(), "tree", "f.txt"));
  await symlink(outside, join(w1dir(), "tree", "out-link"));
  await symlink(join(outside, "secret.txt"), join(w1dir(), "tree", "file-link"));
  const r = await rmPaths(w1, ["tree"], true);
  assert.deepEqual(r.removed, ["tree"]);
  assert.ok(!(await exists(join(w1dir(), "tree"))));
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "secret");
});

test("rm: worker は他の worker の path を消せない（相対でも worker: 接頭辞でも）", async () => {
  await fresh();
  await put(join(ws, "workers", "w2", "f.txt"));
  const r = await rmPaths(w1, ["../w2/f.txt", "worker:w2/f.txt", "workers/w2/f.txt"]);
  assert.deepEqual(r.removed, []);
  assert.ok(await exists(join(ws, "workers", "w2", "f.txt")));
  // 逆向きも同じ
  await put(join(w1dir(), "g.txt"));
  const r2 = await rmPaths(w2, ["../w1/g.txt"]);
  assert.deepEqual(r2.removed, []);
  assert.ok(await exists(join(w1dir(), "g.txt")));
});

test("rm: cap は自分の dir と、自分が持ち主の worker の中を消せる", async () => {
  await fresh();
  await put(join(ws, "caps", "capA", "tmp", "x.txt"));
  await put(join(w1dir(), "clone", "y.txt"));
  const r = await rmPaths(capA, ["tmp", "worker:w1/clone", "worker:w1/./clone2"], true);
  assert.deepEqual(r.removed, ["tmp", "worker:w1/clone"]);
  assert.deepEqual(reasons(r), ["存在しない"]);
  assert.ok(!(await exists(join(ws, "caps", "capA", "tmp"))));
  assert.ok(!(await exists(join(w1dir(), "clone"))));
  assert.ok(await exists(join(w1dir(), "state.json")));
});

test("rm: cap は他の cap の worker・他の cap の dir を消せない", async () => {
  await fresh();
  await put(join(ws, "workers", "w3", "z.txt"));
  await put(join(ws, "caps", "capB", "z.txt"));
  const r = await rmPaths(capA, ["worker:w3/z.txt", "../capB/z.txt", "worker:nope/x", "worker:../x", "worker:"]);
  assert.deepEqual(r.removed, []);
  assert.equal(r.skipped.length, 5);
  assert.match(r.skipped[0]!.reason, /別の cap の worker/);
  assert.ok(await exists(join(ws, "workers", "w3", "z.txt")));
  assert.ok(await exists(join(ws, "caps", "capB", "z.txt")));
  // capB 側から w1 も同じく不可
  await put(join(w1dir(), "k.txt"));
  const r2 = await rmPaths(capB, ["worker:w1/k.txt"]);
  assert.deepEqual(r2.removed, []);
});

test("rm: cap は自分の dir そのもの・state.json・logs/ ・worker の dir そのもの / logs/ を消せない", async () => {
  await fresh();
  const r = await rmPaths(capA, [".", "", "state.json", "logs", "logs/x", "worker:w1", "worker:w1/", "worker:w1/.", "worker:w1/logs", "worker:w1/state.json", "worker:w1/LOGS/owner.json"], true);
  assert.deepEqual(r.removed, []);
  assert.equal(r.skipped.length, 11);
  for (const d of [join(ws, "caps", "capA"), w1dir()]) {
    assert.ok(await exists(join(d, "state.json")));
    assert.ok(await exists(join(d, "logs")));
  }
  assert.ok(await exists(join(w1dir(), "logs", "owner.json")));
});

test("rm: 検査と削除の間に親が symlink に差し替わっても外は消えない（削除直前の再検査）", async () => {
  await fresh();
  await put(join(w1dir(), "p", "victim.txt"));
  await put(join(outside, "p-victim.txt"));
  // 実際の競合は再現できないので、差し替え後の状態（p が外を指す symlink）で拒否されることを確かめる
  await rm(join(w1dir(), "p"), { recursive: true });
  await symlink(outside, join(w1dir(), "p"));
  const r = await rmPaths(w1, ["p/p-victim.txt"]);
  assert.deepEqual(r.removed, []);
  assert.ok(await exists(join(outside, "p-victim.txt")));
});

test("rm: 全部拒否でも throw せず skipped に理由、重複 path は 2 つ目が存在しない", async () => {
  await fresh();
  await put(join(w1dir(), "d.txt"));
  const r = await rmPaths(w1, ["d.txt", "d.txt", "../x"]);
  assert.deepEqual(r.removed, ["d.txt"]);
  assert.equal(r.skipped.length, 2);
});

test("bash: 未知 action は throw（handler 表に無い、prototype 名も不可）", async () => {
  await fresh();
  await assert.rejects(runBash(ws, w1, { action: "mv", paths: ["a"] }), /未知の action/);
  await assert.rejects(runBash(ws, w1, { action: "constructor", paths: ["a"] }), /未知の action/);
  await assert.rejects(runBash(ws, w1, { action: "toString", paths: ["a"] }), /未知の action/);
});

// -- MCP 経由 ---------------------------------------------------------------------

function rpc(url: string, body: object, headers: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}
const callBash = (args: unknown) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bash", arguments: args } });
type ToolReply = { result?: { content: Array<{ text: string }>; isError?: boolean }; error?: unknown };

test("mcp bash: cap / worker の両方に載り、返り値・isError の規則に従う", async () => {
  await fresh();
  setBashWorkspace(ws);
  await put(join(w1dir(), "a.txt"));
  await put(join(w1dir(), "keep", "b.txt"));
  const app = createApp().use("/mcp", defineEventHandler((e) => handleMcpRequest(toWebRequest(e))));
  const l = await startMcpListener(toNodeListener(app), { port: 0, bind: "127.0.0.1" });
  try {
    const url = `http://127.0.0.1:${l.port}/mcp`;
    const hw = { "x-bantou-cap-id": "capA", "x-bantou-worker-id": "w1" };
    const hc = { "x-bantou-cap-id": "capA" };
    const names = async (h: Record<string, string>): Promise<string[]> =>
      ((await (await rpc(url, { jsonrpc: "2.0", id: 1, method: "tools/list" }, h)).json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    assert.deepEqual(await names(hw), ["report", "bash"]);
    assert.ok((await names(hc)).includes("bash"));

    // 一部成功・一部拒否は isError でない
    const ok = (await (await rpc(url, callBash({ action: "rm", paths: ["a.txt", "../x", "keep"] }), hw)).json()) as ToolReply;
    assert.ok(!ok.result!.isError);
    const body = JSON.parse(ok.result!.content[0]!.text) as BashResult;
    assert.deepEqual(body.removed, ["a.txt"]);
    assert.equal(body.skipped.length, 2);
    assert.ok(await exists(join(w1dir(), "keep", "b.txt")));

    // 全部拒否でも isError でない
    const all = (await (await rpc(url, callBash({ action: "rm", paths: ["logs", "state.json"] }), hw)).json()) as ToolReply;
    assert.ok(!all.result!.isError);
    assert.equal((JSON.parse(all.result!.content[0]!.text) as BashResult).skipped.length, 2);

    // cap は worker: 接頭辞で自分の worker を消せる
    const cap = (await (await rpc(url, callBash({ action: "rm", paths: ["worker:w1/keep"], recursive: true }), hc)).json()) as ToolReply;
    assert.deepEqual((JSON.parse(cap.result!.content[0]!.text) as BashResult).removed, ["worker:w1/keep"]);

    // 未知 action は isError
    const unk = (await (await rpc(url, callBash({ action: "mv", paths: ["a"] }), hw)).json()) as ToolReply;
    assert.equal(unk.result?.isError, true);
    assert.match(unk.result!.content[0]!.text, /未知の action/);

    // 引数の形の不正は isError（SDK が検証エラーを返す）
    for (const bad of [
      { action: "rm" },
      { action: "rm", paths: [] },
      { action: "rm", paths: "a" },
      { action: "rm", paths: [1] },
      { action: "rm", paths: ["a"], recursive: "yes" },
      { action: "rm", paths: Array.from({ length: 101 }, (_, i) => `f${i}`) },
      { action: "rm", paths: ["a".repeat(1025)] },
      { paths: ["a"] },
    ]) {
      const r = (await (await rpc(url, callBash(bad), hw)).json()) as ToolReply;
      assert.ok(r.error !== undefined || r.result?.isError === true, JSON.stringify(bad).slice(0, 60));
      if (r.result) assert.equal(r.result.isError, true);
    }
    // 100 件ちょうど・1024 文字ちょうどは受理（skipped で返る）
    const edge = (await (await rpc(url, callBash({ action: "rm", paths: Array.from({ length: 100 }, (_, i) => `f${i}`) }), hw)).json()) as ToolReply;
    assert.ok(!edge.result!.isError);

    // header 無しは isError（tool 自体が載らない or 拒否）
    const none = (await (await rpc(url, callBash({ action: "rm", paths: ["a"] }), {})).json()) as ToolReply;
    assert.ok(none.error !== undefined || none.result?.isError === true);

    // workspace 未設定（起動中・終了中）は isError
    setBashWorkspace(undefined);
    const down = (await (await rpc(url, callBash({ action: "rm", paths: ["a"] }), hw)).json()) as ToolReply;
    assert.equal(down.result?.isError, true);
  } finally {
    setBashWorkspace(undefined);
    await l.close();
  }
});
