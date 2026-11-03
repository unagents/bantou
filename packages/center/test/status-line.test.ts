import assert from "node:assert/strict";
import { test } from "node:test";
import { runStatusLine, selfCommand, statusLineCommand, statusLineSettingsJson, statusLineUrl } from "../src/status-line.js";

test("statusLineUrl: MCP 窓口の URL から同じ center の status-line を作る", () => {
  assert.equal(statusLineUrl("http://127.0.0.1:4567/mcp/session", "pm1"), "http://127.0.0.1:4567/sessions/pm1/status-line");
  assert.equal(statusLineUrl("http://[::1]:7910/mcp/session", "a-b_c"), "http://[::1]:7910/sessions/a-b_c/status-line");
});

test("selfCommand: compiled は実行ファイル 1 本、node / bun は script と execArgv も", () => {
  assert.deepEqual(selfCommand("/Applications/bantou/bantou-center", "/$bunfs/root/x", []), ["/Applications/bantou/bantou-center"]);
  assert.deepEqual(selfCommand("/usr/bin/node", "/r/src/cli.ts", ["--import", "tsx"]), ["/usr/bin/node", "--import", "tsx", "/r/src/cli.ts"]);
  assert.deepEqual(selfCommand("C:\\bun\\bun.exe", "C:\\r\\cli.ts", []), ["C:\\bun\\bun.exe", "C:\\r\\cli.ts"]);
});

test("statusLineCommand: 各引数を quote（空白・'）。token は含まない。win32 は二重引用符", () => {
  const c = statusLineCommand("http://h/sessions/n/status-line", ["/Users/a b/it's/center"], "linux");
  assert.equal(c, `'/Users/a b/it'\\''s/center' 'status-line' '--url' 'http://h/sessions/n/status-line'`);
  assert.equal(statusLineCommand("http://h/x", ["C:\\p q\\center.exe"], "win32"), `"C:\\p q\\center.exe" "status-line" "--url" "http://h/x"`);
  assert.ok(!/token/i.test(c));
});

test("statusLineSettingsJson: statusLine のキーだけ（他の設定を上書きしない）", () => {
  assert.deepEqual(JSON.parse(statusLineSettingsJson("cmd")), { statusLine: { type: "command", command: "cmd" } });
});

async function* stdin(s: string): AsyncGenerator<Buffer> {
  yield Buffer.from(s);
}

test("runStatusLine: stdin を Bearer token 付きで POST。stdout なし・終了コード 0", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const errs: string[] = [];
  const rc = await runStatusLine(["--url", "http://h/sessions/n/status-line"], {
    env: { BANTOU_SESSION_TOKEN: "tok" },
    stdin: stdin('{"a":1}'),
    stderr: (l) => errs.push(l),
    fetchImpl: (async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response(null, { status: 204 }))) as unknown as typeof fetch,
  });
  assert.equal(rc, 0);
  assert.deepEqual(errs, []);
  assert.equal(calls[0].url, "http://h/sessions/n/status-line");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, '{"a":1}');
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer tok");
});

test("runStatusLine: url / token 無し・送信失敗・非 2xx は stderr に出すだけで 0", async () => {
  const errs: string[] = [];
  const io = { stderr: (l: string) => errs.push(l) };
  assert.equal(await runStatusLine([], { ...io, env: { BANTOU_SESSION_TOKEN: "t" }, stdin: stdin("{}") }), 0);
  assert.equal(await runStatusLine(["--url", "http://h/x"], { ...io, env: {}, stdin: stdin("{}") }), 0);
  assert.equal(
    await runStatusLine(["--url", "http://h/x"], { ...io, env: { BANTOU_SESSION_TOKEN: "t" }, stdin: stdin("{}"), fetchImpl: (async () => { throw new Error("refused"); }) as unknown as typeof fetch }),
    0,
  );
  assert.equal(
    await runStatusLine(["--url", "http://h/x"], { ...io, env: { BANTOU_SESSION_TOKEN: "t" }, stdin: stdin("{}"), fetchImpl: (async () => new Response("no", { status: 401 })) as unknown as typeof fetch }),
    0,
  );
  assert.equal(errs.length, 4);
  assert.ok(errs[2].includes("refused") && errs[3].includes("401"));
});
