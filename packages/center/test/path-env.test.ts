import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PATH_BEGIN,
  PATH_END,
  composePath,
  fixedPathCandidates,
  parseLoginShellPath,
  resolveSessionPath,
  type PathResolveDeps,
} from "../src/path-env.js";

const HOME = "/Users/u";
const RUSTUP = "/opt/homebrew/opt/rustup/bin";
const MIN = "/usr/bin:/bin:/usr/sbin:/sbin";
const ALL_MAC = ["/opt/homebrew/bin", "/usr/local/bin", `${HOME}/.local/bin`, `${HOME}/.cargo/bin`, RUSTUP, `${HOME}/.bun/bin`];

const wrap = (p: string): string => `${PATH_BEGIN}${p}${PATH_END}`;

const deps = (o: {
  out?: string | Error;
  dirs?: string[];
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  calls?: { file: string; args: string[]; timeoutMs: number }[];
}): PathResolveDeps => ({
  exec: async (file, args, timeoutMs) => {
    o.calls?.push({ file, args, timeoutMs });
    if (o.out instanceof Error) throw o.out;
    return o.out ?? "";
  },
  isDir: (p) => (o.dirs ?? []).includes(p),
  env: o.env ?? { SHELL: "/bin/zsh", PATH: MIN },
  home: HOME,
  platform: o.platform ?? "darwin",
});

const log = (): void => {};

test("固定候補: macOS は Homebrew 系 + home 配下、Linux は home 配下のみ、他 OS は空", () => {
  assert.deepEqual(fixedPathCandidates("darwin", HOME), ALL_MAC);
  assert.deepEqual(fixedPathCandidates("linux", "/home/u"), ["/home/u/.local/bin", "/home/u/.cargo/bin", "/home/u/.bun/bin"]);
  assert.deepEqual(fixedPathCandidates("win32", "C:\\u"), []);
  assert.deepEqual(fixedPathCandidates("linux", ""), []);
});

test("composePath: 存在する候補だけを、既存 PATH の前に固定順で足す", () => {
  const p = composePath({
    current: MIN,
    loginPath: null,
    platform: "darwin",
    home: HOME,
    isDir: (d) => d === "/opt/homebrew/bin" || d === `${HOME}/.cargo/bin`,
  });
  assert.equal(p, `/opt/homebrew/bin:${HOME}/.cargo/bin:${MIN}`);
});

test("composePath: macOS の rustup dir は ~/.cargo/bin の次、存在する時だけ入る", () => {
  const base = { current: MIN, loginPath: null, platform: "darwin" as const, home: HOME };
  assert.equal(
    composePath({ ...base, isDir: (d) => [`${HOME}/.bun/bin`, RUSTUP, `${HOME}/.cargo/bin`].includes(d) }),
    `${HOME}/.cargo/bin:${RUSTUP}:${HOME}/.bun/bin:${MIN}`,
  );
  assert.equal(composePath({ ...base, isDir: (d) => d === "/opt/homebrew/bin" }), `/opt/homebrew/bin:${MIN}`);
  assert.equal(composePath({ ...base, current: `${RUSTUP}:${MIN}`, isDir: (d) => d === RUSTUP }), `${RUSTUP}:${MIN}`);
  const linux = composePath({ ...base, platform: "linux", isDir: () => true });
  assert.ok(!linux.includes(RUSTUP));
});

test("composePath: 重複を除く（先に出た方を残す）。既に入っている候補は動かさない", () => {
  const p = composePath({
    current: "/usr/bin:/opt/homebrew/bin:/usr/bin::/bin",
    loginPath: null,
    platform: "darwin",
    home: HOME,
    isDir: (d) => d === "/opt/homebrew/bin" || d === "/usr/local/bin",
  });
  assert.equal(p, "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
});

test("composePath: 存在する候補が無ければ PATH は変わらない。PATH 未設定でも落ちない", () => {
  assert.equal(composePath({ current: MIN, loginPath: null, platform: "linux", home: HOME, isDir: () => false }), MIN);
  assert.equal(composePath({ current: undefined, loginPath: null, platform: "linux", home: HOME, isDir: (d) => d.endsWith(".local/bin") }), `${HOME}/.local/bin`);
});

test("composePath: login shell の PATH があれば先頭、その後に現在の PATH、未掲載の固定候補は最後", () => {
  const p = composePath({
    current: MIN,
    loginPath: ["/opt/homebrew/bin", "/usr/bin", "/custom/bin"],
    platform: "darwin",
    home: HOME,
    isDir: (d) => d === "/opt/homebrew/bin" || d === "/usr/local/bin",
  });
  assert.equal(p, `/opt/homebrew/bin:/usr/bin:/custom/bin:/bin:/usr/sbin:/sbin:/usr/local/bin`);
});

test("composePath: win32 など対象外 OS は現在の PATH をそのまま返す", () => {
  assert.equal(composePath({ current: "C:\\a;C:\\b", loginPath: ["/x"], platform: "win32", home: "C:\\u", isDir: () => true }), "C:\\a;C:\\b");
});

test("parseLoginShellPath: 目印の間だけを採る。前後の余計な出力・複数組・相対パスを扱う", () => {
  assert.deepEqual(parseLoginShellPath(`motd\n${wrap("/a:/b")}\nbye\n`), ["/a", "/b"]);
  assert.deepEqual(parseLoginShellPath(`${wrap("/first")}noise${wrap("/x::rel/bin:/y")}`), ["/x", "/y"]);
  assert.equal(parseLoginShellPath("/a:/b\n"), null);
  assert.equal(parseLoginShellPath(wrap("")), null);
  assert.equal(parseLoginShellPath(wrap("rel:./x")), null);
});

test("resolveSessionPath: login shell を 1 回、timeout 付きで呼び、結果を優先する", async () => {
  const calls: { file: string; args: string[]; timeoutMs: number }[] = [];
  const r = await resolveSessionPath(
    log,
    deps({ out: `banner\n${wrap(`/opt/homebrew/bin:${MIN}`)}\n`, dirs: ALL_MAC, calls }),
  );
  assert.equal(r.source, "login-shell");
  assert.ok(r.path.startsWith(`/opt/homebrew/bin:${MIN}:`));
  assert.ok(r.path.includes(`${HOME}/.local/bin`));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "/bin/zsh");
  assert.equal(calls[0].args[0], "-lc");
  assert.equal(calls[0].timeoutMs, 5000);
});

test("resolveSessionPath: SHELL 未設定は /bin/sh", async () => {
  const calls: { file: string; args: string[]; timeoutMs: number }[] = [];
  await resolveSessionPath(log, deps({ out: wrap("/a"), env: { PATH: MIN }, calls }));
  assert.equal(calls[0].file, "/bin/sh");
});

test("resolveSessionPath: login shell 失敗（reject / 目印なし / 空）は固定リストに落ちる", async () => {
  for (const out of [new Error("timeout"), "no markers here\n", wrap("")]) {
    const r = await resolveSessionPath(log, deps({ out, dirs: ["/opt/homebrew/bin", `${HOME}/.bun/bin`] }));
    assert.equal(r.source, "fixed-list");
    assert.equal(r.path, `/opt/homebrew/bin:${HOME}/.bun/bin:${MIN}`);
  }
});

test("resolveSessionPath: 失敗理由と結果を log に残す", async () => {
  const logs: string[] = [];
  await resolveSessionPath((m) => void logs.push(m), deps({ out: new Error("boom"), dirs: ["/opt/homebrew/bin"] }));
  assert.ok(logs.some((l) => l.includes("boom")));
  assert.ok(logs.some((l) => l.includes("source=fixed-list")));
});

test("resolveSessionPath: Linux は home 配下だけ。対象外 OS は shell を呼ばない", async () => {
  const r = await resolveSessionPath(
    log,
    { ...deps({ out: new Error("x"), dirs: ["/opt/homebrew/bin", "/home/u/.cargo/bin"], platform: "linux" }), home: "/home/u" },
  );
  assert.equal(r.path, `/home/u/.cargo/bin:${MIN}`);
  const calls: { file: string; args: string[]; timeoutMs: number }[] = [];
  const w = await resolveSessionPath(log, deps({ platform: "win32", env: { PATH: "C:\\a" }, calls }));
  assert.deepEqual(w, { path: "C:\\a", source: "unchanged" });
  assert.equal(calls.length, 0);
});
