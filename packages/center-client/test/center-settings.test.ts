// Web-side behaviour of the settings (design 5.5): token hiding, unchanged-token rule, env override, file store.

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CenterSettingsError,
  createCenterSettings,
  createFileSettingsStore,
  defaultSettings,
  type CenterSettings,
  type SettingsStore,
} from "../src/index.ts";

const URL_A = "http://host-a:7910/mcp";
const URL_B = "http://host-b:7910/mcp";
const TOKEN_A = "token-for-a-0123456789";
const TOKEN_B = "token-for-b-0123456789";

function memStore(initial?: unknown): SettingsStore & { value: unknown; writes: number } {
  const st = {
    value: initial,
    writes: 0,
    async read() {
      return st.value;
    },
    async write(v: unknown) {
      st.value = JSON.parse(JSON.stringify(v));
      st.writes++;
    },
  };
  return st;
}

const handle = (store: SettingsStore, env: Record<string, string | undefined> = {}, redactSecrets = true) =>
  createCenterSettings({ settingsStore: store, redactSecrets, env });
const withRemote = (url: string, token?: string): CenterSettings => ({
  ...defaultSettings(),
  remote: token === undefined ? { url } : { url, token },
});

test("empty store: defaults, no target, nothing written, no token minted", async () => {
  const store = memStore();
  const h = handle(store);
  const s = await h.get();
  assert.equal(s.enabled, false);
  assert.equal(s.token, "");
  assert.equal(s.tokenSet, false);
  assert.equal(await h.selectTarget(), undefined);
  assert.equal(store.writes, 0);
});

test("get returns no token and returns tokenSet", async () => {
  const store = memStore({ ...withRemote(URL_A, TOKEN_A), token: "" });
  const s = await handle(store).get();
  assert.deepEqual(s.remote, { url: URL_A, token: "", tokenSet: true });
  assert.ok(!JSON.stringify(s).includes(TOKEN_A));
  // no token on the remote
  const s2 = await handle(memStore(withRemote(URL_A))).get();
  assert.deepEqual(s2.remote, { url: URL_A, token: "", tokenSet: false });
  // the target still carries the token (server side only)
  assert.equal((await handle(store).selectTarget())!.token, TOKEN_A);
});

test("get without redactSecrets keeps the desktop shape (token included, no tokenSet)", async () => {
  const s = await handle(memStore(withRemote(URL_A, TOKEN_A)), {}, false).get();
  assert.deepEqual(s.remote, { url: URL_A, token: TOKEN_A });
  assert.equal(s.tokenSet, undefined);
});

test("set: empty token keeps the stored remote token when the url is unchanged", async () => {
  const store = memStore(withRemote(URL_A, TOKEN_A));
  const h = handle(store);
  const out = await h.set({ ...defaultSettings(), remote: { url: "http://host-a:7910", token: "" } });
  assert.deepEqual(out.remote, { url: URL_A, token: "", tokenSet: true });
  assert.equal((store.value as CenterSettings).remote?.token, TOKEN_A);
});

test("set: changing remote.url does not carry the token over (R29)", async () => {
  const store = memStore(withRemote(URL_A, TOKEN_A));
  const h = handle(store);
  const out = await h.set({ ...defaultSettings(), remote: { url: URL_B, token: "" } });
  assert.deepEqual(out.remote, { url: URL_B, token: "", tokenSet: false });
  assert.deepEqual((store.value as CenterSettings).remote, { url: URL_B });
  assert.ok(!JSON.stringify(store.value).includes(TOKEN_A));
  // url and a new token together
  await h.set({ ...defaultSettings(), remote: { url: URL_A, token: TOKEN_B } });
  assert.deepEqual((store.value as CenterSettings).remote, { url: URL_A, token: TOKEN_B });
});

test("set: a remote is removed when the input has none", async () => {
  const store = memStore(withRemote(URL_A, TOKEN_A));
  await handle(store).set(defaultSettings());
  assert.ok(!("remote" in (store.value as object)));
});

test("set: the store never receives bind or tokenSet", async () => {
  const store = memStore();
  await handle(store).set({ ...defaultSettings(), bind: "192.0.2.5", tokenSet: true, remote: { url: URL_A, tokenSet: true } });
  const v = store.value as Record<string, unknown>;
  assert.ok(!("bind" in v) && !("tokenSet" in v));
  assert.deepEqual(v.remote, { url: URL_A });
});

test("set: enabled:true is refused (until work unit S), nothing written", async () => {
  const store = memStore();
  await assert.rejects(handle(store).set({ ...defaultSettings(), enabled: true }), /未対応/);
  assert.equal(store.writes, 0);
});

test("set: validation errors reach the caller and nothing is written", async () => {
  const store = memStore();
  const h = handle(store);
  await assert.rejects(h.set({ ...defaultSettings(), port: 0 }), CenterSettingsError);
  await assert.rejects(h.set({ ...defaultSettings(), workspace: "rel" }), CenterSettingsError);
  await assert.rejects(h.set({ ...defaultSettings(), claudePath: "claude" }), CenterSettingsError);
  await assert.rejects(h.set({ ...defaultSettings(), token: "short" }), CenterSettingsError);
  await assert.rejects(h.set(withRemote("ftp://x")), CenterSettingsError);
  assert.equal(store.writes, 0);
});

test("load repairs a stored remote url and writes it back; a bad stored value gives defaults", async () => {
  const store = memStore(withRemote("http://host-a:7910//mcp", TOKEN_A));
  assert.equal((await handle(store).selectTarget())!.url, URL_A);
  assert.equal((store.value as CenterSettings).remote?.url, URL_A);
  assert.equal(store.writes, 1);
  const bad = memStore({ port: "x", remote: { url: URL_A } });
  assert.equal(await handle(bad).selectTarget(), undefined);
});

test("target follows the store on every call (no restart)", async () => {
  const store = memStore();
  const h = handle(store);
  assert.equal(await h.selectTarget(), undefined);
  store.value = withRemote(URL_A, TOKEN_A);
  assert.deepEqual(await h.selectTarget(), { url: URL_A, token: TOKEN_A, source: "remote" });
  store.value = withRemote(URL_B);
  assert.deepEqual(await h.selectTarget(), { url: URL_B, source: "remote" });
});

test("env: CENTER_URL / CENTER_TOKEN win over the file and cannot be changed", async () => {
  const store = memStore(withRemote(URL_A, TOKEN_A));
  const env = { CENTER_URL: URL_B, CENTER_TOKEN: TOKEN_B };
  const h = handle(store, env);
  assert.deepEqual(h.envLocks(), { remoteUrl: true, remoteToken: true });
  assert.deepEqual(await h.selectTarget(), { url: URL_B, token: TOKEN_B, source: "remote" });
  assert.deepEqual((await h.get()).remote, { url: URL_B, token: "", tokenSet: true });
  // changing the url, the token, or dropping the remote is refused
  await assert.rejects(h.set(withRemote("http://host-c:7910/mcp")), /CENTER_URL/);
  await assert.rejects(h.set(withRemote(URL_B, TOKEN_A)), /CENTER_TOKEN/);
  await assert.rejects(h.set(defaultSettings()), /CENTER_URL/);
  assert.equal(store.writes, 0);
  // the same remote with an empty token is accepted, other items are saved, env values never reach the file
  await h.set({ ...withRemote(URL_B, ""), port: 7920 });
  const saved = store.value as CenterSettings;
  assert.equal(saved.port, 7920);
  assert.deepEqual(saved.remote, { url: URL_A, token: TOKEN_A });
  assert.ok(!JSON.stringify(saved).includes(TOKEN_B));
});

test("env: only CENTER_URL fixes the url, the file token is used with it", async () => {
  const store = memStore(withRemote(URL_A, TOKEN_A));
  const h = handle(store, { CENTER_URL: URL_B });
  assert.deepEqual(h.envLocks(), { remoteUrl: true, remoteToken: false });
  assert.deepEqual(await h.selectTarget(), { url: URL_B, token: TOKEN_A, source: "remote" });
});

test("env: CENTER_URL with an empty file gives a target; a blank env is ignored", async () => {
  const h = handle(memStore(), { CENTER_URL: URL_B, CENTER_TOKEN: TOKEN_B });
  assert.deepEqual(await h.selectTarget(), { url: URL_B, token: TOKEN_B, source: "remote" });
  const blank = handle(memStore(), { CENTER_URL: "  ", CENTER_TOKEN: "" });
  assert.deepEqual(blank.envLocks(), { remoteUrl: false, remoteToken: false });
  assert.equal(await blank.selectTarget(), undefined);
});

test("file store: missing file, atomic write with mode 600, no temp left, rewrite via handle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-settings-"));
  try {
    const path = join(dir, "sub", "center.json");
    const store = createFileSettingsStore(path);
    assert.equal(await store.read(), undefined);
    const h = handle(store);
    await h.set(withRemote(URL_A, TOKEN_A));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(join(dir, "sub")), ["center.json"]);
    const onDisk = JSON.parse(await readFile(path, "utf8")) as CenterSettings;
    assert.deepEqual(onDisk.remote, { url: URL_A, token: TOKEN_A });
    // a file edited by hand takes effect on the next call
    await writeFile(path, JSON.stringify(withRemote(URL_B)));
    assert.equal((await h.selectTarget())!.url, URL_B);
    // not JSON: defaults
    await writeFile(path, "{ nope");
    assert.equal(await h.selectTarget(), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("center-client imports no Nuxt / Nitro / Tauri / browser module", async () => {
  const dir = new URL("../src/", import.meta.url);
  for (const f of await readdir(dir)) {
    if (!f.endsWith(".ts") || f.endsWith(".d.ts")) continue; // the .d.ts shim only names the ui alias in a comment
    const text = await readFile(new URL(f, dir), "utf8");
    for (const m of text.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)) {
      assert.ok(!/^(nuxt|nitro|h3|vue|@nuxt|@tauri-apps|#|~)/.test(m[1]!), `${f}: ${m[1]}`);
    }
  }
});

// -- review 1 ------------------------------------------------------------------

test("M1: with CENTER_TOKEN fixed, changing remote.url drops the file token (R29)", async () => {
  const store = memStore(withRemote(URL_A, TOKEN_A));
  const h = handle(store, { CENTER_TOKEN: TOKEN_B });
  await h.set(withRemote(URL_B, ""));
  assert.deepEqual((store.value as CenterSettings).remote, { url: URL_B });
  assert.ok(!JSON.stringify(store.value).includes(TOKEN_A));
  // same url: the file token stays
  const store2 = memStore(withRemote(URL_A, TOKEN_A));
  await handle(store2, { CENTER_TOKEN: TOKEN_B }).set(withRemote(URL_A, ""));
  assert.deepEqual((store2.value as CenterSettings).remote, { url: URL_A, token: TOKEN_A });
});

const URL_UI = "http://user:pw@host-a:7910/mcp?token=qq";

test("M2: redacted responses show no userinfo / query; the desktop shape (redactSecrets false) is unchanged", async () => {
  const store = memStore(withRemote(URL_UI, TOKEN_A));
  const h = handle(store);
  const got = await h.get();
  assert.deepEqual(got.remote, { url: URL_A, token: "", tokenSet: true });
  const setOut = await h.set({ ...defaultSettings(), port: 7920, remote: { url: URL_A, token: "" } });
  assert.deepEqual(setOut.remote, { url: URL_A, token: "", tokenSet: true });
  for (const secret of ["user", "pw", "qq", TOKEN_A]) assert.ok(!JSON.stringify([got, setOut]).includes(secret), secret);
  // the shown form means "unchanged": the stored url (with userinfo) and token stay
  assert.deepEqual((store.value as CenterSettings).remote, { url: URL_UI, token: TOKEN_A });
  assert.equal((store.value as CenterSettings).port, 7920);
  // desktop shape: as stored
  const raw = await handle(memStore(withRemote(URL_UI, TOKEN_A)), {}, false).get();
  assert.deepEqual(raw.remote, { url: URL_UI, token: TOKEN_A });
});

test("M2: the redacted form of another url is a change (token dropped)", async () => {
  const store = memStore(withRemote(URL_UI, TOKEN_A));
  await handle(store).set(withRemote(URL_B, ""));
  assert.deepEqual((store.value as CenterSettings).remote, { url: URL_B });
});

test("L1: wrong types in set are CenterSettingsError and nothing is written", async () => {
  const store = memStore(withRemote(URL_A, TOKEN_A));
  const h = handle(store);
  for (const bad of [
    { ...defaultSettings(), workspace: undefined },
    { ...defaultSettings(), remote: { url: 5 } },
    { ...defaultSettings(), remote: { url: URL_A, token: 5 } },
    { ...defaultSettings(), token: 5 },
    null,
  ]) {
    await assert.rejects(h.set(bad as unknown as CenterSettings), CenterSettingsError, JSON.stringify(bad));
  }
  assert.equal(store.writes, 0);
});

test("L3: enabled:true file (policy allows): get hides the top-level token, set with an empty token keeps it", async () => {
  const TOP = "top-level-token-0123456789";
  const store = memStore({ ...defaultSettings(), enabled: true, token: TOP });
  const h = createCenterSettings({ settingsStore: store, redactSecrets: true, policy: { allowEnabled: true }, env: {} });
  const s = await h.get();
  assert.equal(s.token, "");
  assert.equal(s.tokenSet, true);
  assert.ok(!JSON.stringify(s).includes(TOP));
  assert.equal((await h.selectTarget())!.token, TOP);
  await h.set({ ...defaultSettings(), enabled: true, port: 7920, token: "" });
  assert.equal((store.value as CenterSettings).token, TOP);
  assert.equal((store.value as CenterSettings).port, 7920);
  // a new token replaces it
  await h.set({ ...defaultSettings(), enabled: true, token: TOKEN_B });
  assert.equal((store.value as CenterSettings).token, TOKEN_B);
});

test("L3: a sidecar-enabled file without a token gets one minted and saved on load", async () => {
  const store = memStore({ ...defaultSettings(), enabled: true });
  const h = createCenterSettings({ settingsStore: store, policy: { allowEnabled: true }, env: {} });
  const t = (await h.selectTarget())!;
  assert.equal(t.token!.length, 32);
  assert.equal((store.value as CenterSettings).token, t.token);
});

test("L3: CENTER_URL fixed and no remote in the file: a token alone is refused, an empty one is fine", async () => {
  const store = memStore();
  const h = handle(store, { CENTER_URL: URL_B });
  await assert.rejects(h.set(withRemote(URL_B, TOKEN_A)), /token だけは保存できない/);
  assert.equal(store.writes, 0);
  await h.set({ ...withRemote(URL_B, ""), port: 7920 });
  const saved = store.value as CenterSettings;
  assert.equal(saved.port, 7920);
  assert.ok(!("remote" in saved));
});

test("L3: the env url is normalized in the effective settings", async () => {
  const h = handle(memStore(), { CENTER_URL: " http://host-b:7910// " });
  assert.equal((await h.get()).remote!.url, URL_B);
  assert.equal((await h.selectTarget())!.url, URL_B);
});
