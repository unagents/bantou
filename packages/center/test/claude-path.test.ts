import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveClaude, type ClaudeResolveDeps } from "../src/claude-path.js";

const HOME = "/home/u";
const LOCAL = "/home/u/.local/bin/claude";
const BREW = "/opt/homebrew/bin/claude";

const deps = (o: {
  out?: string | Error;
  exists?: string[];
  env?: NodeJS.ProcessEnv;
  calls?: { file: string; args: string[]; timeoutMs: number }[];
}): ClaudeResolveDeps => ({
  exec: async (file, args, timeoutMs) => {
    o.calls?.push({ file, args, timeoutMs });
    if (o.out instanceof Error) throw o.out;
    return o.out ?? "";
  },
  isExecutable: async (p) => (o.exists ?? []).includes(p),
  env: o.env ?? { SHELL: "/bin/zsh" },
  home: HOME,
});

const logs: string[] = [];
const log = (m: string): void => void logs.push(m);

test("config 指定はそのまま使い、shell を呼ばない", async () => {
  const calls: { file: string; args: string[]; timeoutMs: number }[] = [];
  const r = await resolveClaude("/x/claude", log, deps({ out: "/y/claude", calls }));
  assert.deepEqual(r, { path: "/x/claude", source: "config" });
  assert.equal(calls.length, 0);
});

test("login shell の結果（最終の非空行）を採用", async () => {
  const calls: { file: string; args: string[]; timeoutMs: number }[] = [];
  const r = await resolveClaude(undefined, log, deps({ out: "motd\n/usr/local/bin/claude\n\n", exists: ["/usr/local/bin/claude"], calls }));
  assert.deepEqual(r, { path: "/usr/local/bin/claude", source: "login-shell" });
  assert.deepEqual(calls, [{ file: "/bin/zsh", args: ["-lc", "command -v claude"], timeoutMs: 5000 }]);
});

test("SHELL 未設定は /bin/sh", async () => {
  const calls: { file: string; args: string[]; timeoutMs: number }[] = [];
  await resolveClaude(undefined, log, deps({ out: "", env: {}, calls }));
  assert.equal(calls[0].file, "/bin/sh");
});

test("shell が相対パス / alias 表記を返すと fallback へ", async () => {
  const r = await resolveClaude(undefined, log, deps({ out: "claude\n", exists: [LOCAL] }));
  assert.deepEqual(r, { path: LOCAL, source: "fallback-path" });
});

test("shell の結果が実行不可なら fallback へ", async () => {
  const r = await resolveClaude(undefined, log, deps({ out: "/gone/claude\n", exists: [BREW] }));
  assert.deepEqual(r, { path: BREW, source: "fallback-path" });
});

test("shell の失敗・タイムアウトは fallback へ", async () => {
  const r1 = await resolveClaude(undefined, log, deps({ out: new Error("exit 1"), exists: [LOCAL] }));
  assert.equal(r1.source, "fallback-path");
  const t = Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" });
  const r2 = await resolveClaude(undefined, log, deps({ out: t, exists: [BREW] }));
  assert.deepEqual(r2, { path: BREW, source: "fallback-path" });
});

test("fallback は ~/.local/bin が /opt/homebrew/bin より先", async () => {
  const r = await resolveClaude(undefined, log, deps({ out: new Error("x"), exists: [BREW, LOCAL] }));
  assert.equal(r.path, LOCAL);
});

test("全部だめなら PATH 任せの claude + 警告", async () => {
  logs.length = 0;
  const r = await resolveClaude(undefined, log, deps({ out: new Error("x") }));
  assert.deepEqual(r, { path: "claude", source: "PATH" });
  assert.ok(logs.some((l) => l.includes("警告")));
});
