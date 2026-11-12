// Inputs and expectations copied from the Rust tests of the desktop (design 5.6 #5).
// R = packages/desktop/src-tauri/src/center.rs, M = .../center_mcp.rs. Host names and IPs are dummies.
// Not ported: the `bind` cases (web has no `bind`), `bind_failure_is_read_from_the_log`, `config_json_*` (sidecar start, work unit S).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CenterSettingsError,
  DEFAULT_PORT,
  MIN_TOKEN_LEN,
  defaultSettings,
  ensureToken,
  mintToken,
  normalizeRemote,
  parseStored,
  redactUrl,
  repairRemoteUrl,
  selectTarget,
  validateSettings,
  type CenterSettings,
} from "../src/index.ts";

const base = (o: Partial<CenterSettings> = {}): CenterSettings => ({ ...defaultSettings(), ...o });
const ok = { allowEnabled: true };

// -- center.rs tests ---------------------------------------------------------

test("R:787 defaults", () => {
  const s = defaultSettings();
  assert.equal(s.enabled, false);
  assert.equal(s.port, 7910);
  assert.equal(s.port, DEFAULT_PORT);
  assert.equal(s.workspace, "~/.bantou");
  assert.doesNotThrow(() => validateSettings(s));
});

test("R:797 partial json uses defaults", () => {
  const s = parseStored({ enabled: true });
  assert.equal(s.enabled, true);
  assert.equal(s.port, 7910);
});

test("R:804 rejects bad port and remote (bind cases dropped: web has no bind)", () => {
  for (const port of [0, 65536]) {
    assert.throws(() => validateSettings(base({ port })), CenterSettingsError);
  }
  const remote = (url: string, token?: string) => base({ remote: token === undefined ? { url } : { url, token } });
  assert.throws(() => validateSettings(remote("ftp://x")), CenterSettingsError);
  // a blank token means "none"; the url is trimmed
  const s = validateSettings(remote(" http://h:1/mcp ", "  "));
  assert.deepEqual(s.remote, { url: "http://h:1/mcp" });
});

test("R:823 saving a remote stores the canonical url", () => {
  const save = (u: string) => validateSettings(base({ remote: { url: u } })).remote!.url;
  for (const u of ["http://h:7910", "http://h:7910/", "http://h:7910//mcp", "http://h:7910/mcp/", " http://h:7910//mcp/ "]) {
    assert.equal(save(u), "http://h:7910/mcp", u);
  }
});

test("R:834 a broken stored remote url is repaired on load", () => {
  const s = parseStored({ remote: { url: "http://h:7910//mcp", token: "abcdefghijkl" } });
  assert.equal(repairRemoteUrl(s), true);
  assert.equal(s.remote!.url, "http://h:7910/mcp");
  assert.equal(s.remote!.token, "abcdefghijkl");
  // already canonical, or no remote: nothing to write back
  assert.equal(repairRemoteUrl(s), false);
  assert.equal(repairRemoteUrl(defaultSettings()), false);
});

test("R:846 token validation and minting", () => {
  const withToken = (t: string) => () => validateSettings(base({ token: t }));
  // empty is allowed here; non-empty must reach the minimum
  assert.doesNotThrow(withToken(""));
  assert.throws(withToken("x".repeat(MIN_TOKEN_LEN - 1)), CenterSettingsError);
  assert.doesNotThrow(withToken("x".repeat(MIN_TOKEN_LEN)));

  const t = mintToken();
  assert.equal(t.length, 32);
  assert.match(t, /^[A-Za-z0-9]+$/);
  const many = new Set(Array.from({ length: 50 }, () => mintToken()));
  assert.equal(many.size, 50);
});

test("R:861 ensure_token mints only when missing or short", () => {
  const first = ensureToken(defaultSettings());
  assert.ok(first.minted && first.settings.token.length === 32);
  const kept = ensureToken(first.settings);
  assert.equal(kept.minted, false);
  assert.equal(kept.settings.token, first.settings.token);
  const short = ensureToken(base({ token: "short" }));
  assert.ok(short.minted && short.settings.token !== "short");
});

test("R:872 old remoteUrl key is dropped on read", () => {
  const s = parseStored({ enabled: true, remoteUrl: "http://old:7910", token: "abcdefghijkl" });
  assert.equal(s.remote, undefined);
  assert.ok(!JSON.stringify(s).includes("remoteUrl"));
});

test("R:880 old connectHost key is dropped on read (web also drops bind)", () => {
  const old = parseStored({ bind: "0.0.0.0", connectHost: "192.0.2.4", token: "abcdefghijkl" });
  assert.ok(!JSON.stringify(old).includes("connectHost"));
  assert.ok(!("bind" in old));
});

// -- center_mcp.rs tests -----------------------------------------------------

const settings = (enabled: boolean, remote?: string): CenterSettings =>
  base({
    enabled,
    ...(remote !== undefined ? { remote: { url: remote, token: "remote-token-123" } } : {}),
    token: "sidecar-token-123",
  });

test("M:526 target none when disabled and no remote", () => {
  assert.equal(selectTarget(settings(false)), undefined);
});

test("M:531 target sidecar when enabled", () => {
  const t = selectTarget({ ...settings(true), port: 7920 });
  assert.deepEqual(t, { url: "http://127.0.0.1:7920/mcp", token: "sidecar-token-123", source: "sidecar" });
});

test("M:540 target sidecar wins over stored remote when enabled", () => {
  const s = settings(true, "http://host-a:7910/mcp");
  const t = selectTarget(s)!;
  assert.equal(t.source, "sidecar");
  assert.equal(t.url, "http://127.0.0.1:7910/mcp");
  assert.equal(t.token, "sidecar-token-123");
  // the stored remote is untouched, and OFF uses it again
  assert.equal(s.remote?.url, "http://host-a:7910/mcp");
  const off = { ...s, enabled: false };
  const t2 = selectTarget(off)!;
  assert.equal(t2.source, "remote");
  assert.equal(t2.url, "http://host-a:7910/mcp");
  assert.equal(t2.token, "remote-token-123");
  assert.ok(off.remote);
});

test("M:557 target without any token sends none", () => {
  const t = selectTarget({ ...settings(true), token: "" })!;
  assert.equal(t.token, undefined);
});

test("M:563 target remote works when sidecar disabled", () => {
  assert.equal(selectTarget(settings(false, "http://host-a:7910"))!.url, "http://host-a:7910/mcp");
});

test("M:569 target remote keeps explicit path", () => {
  assert.equal(selectTarget(settings(false, "http://h:1/custom"))!.url, "http://h:1/custom");
});

test("M:575 sidecar is dialed on loopback whatever ip is picked", () => {
  for (const bind of ["", "0.0.0.0", "192.0.2.5", "fe80::1", "192.0.2.9"]) {
    const t = selectTarget({ ...settings(true), bind })!;
    assert.equal(t.url, "http://127.0.0.1:7910/mcp", bind);
  }
});

test("M:878 normalize_remote gives one form for every spelling", () => {
  for (const [given, want] of [
    ["http://h:7910", "http://h:7910/mcp"],
    ["http://h:7910/", "http://h:7910/mcp"],
    ["http://h:7910//", "http://h:7910/mcp"],
    ["http://h:7910/mcp", "http://h:7910/mcp"],
    ["http://h:7910/mcp/", "http://h:7910/mcp"],
    ["http://h:7910//mcp", "http://h:7910/mcp"],
    ["http://h:7910///mcp//", "http://h:7910/mcp"],
    ["  http://h:7910//mcp  ", "http://h:7910/mcp"],
    ["http://h:7910/custom//x/", "http://h:7910/custom/x"],
    ["https://h//mcp", "https://h/mcp"],
    ["http://[fd7a::5]:7910//mcp/", "http://[fd7a::5]:7910/mcp"],
    ["http://h:7910//mcp?x=1", "http://h:7910/mcp?x=1"],
  ] as const) {
    assert.equal(normalizeRemote(given), want, given);
    // idempotent
    assert.equal(normalizeRemote(want), want, want);
  }
  // not a url: untouched
  assert.equal(normalizeRemote("nope//"), "nope//");
});

test("M:902 select_target normalizes a stored remote", () => {
  for (const stored of ["http://h:7910/", "http://h:7910//mcp", "http://h:7910/mcp/"]) {
    assert.equal(selectTarget(settings(false, stored))!.url, "http://h:7910/mcp", stored);
  }
});

test("M:910 redact_url drops credentials and query", () => {
  assert.equal(redactUrl("http://u:p@h:1/mcp?token=secret#f"), "http://h:1/mcp");
  assert.equal(redactUrl("http://h:1//mcp"), "http://h:1//mcp");
  assert.equal(redactUrl("not a url?token=secret"), "not a url");
});

// -- validate rules from design 5.5 (center.rs:126-160) ---------------------------

test("validate: workspace / claudePath rules", () => {
  assert.equal(validateSettings(base({ workspace: "  " })).workspace, "~/.bantou");
  for (const w of ["~", "~/x", "/abs/dir"]) assert.doesNotThrow(() => validateSettings(base({ workspace: w })), w);
  for (const w of ["rel/dir", "~user/x"]) assert.throws(() => validateSettings(base({ workspace: w })), CenterSettingsError, w);
  assert.throws(() => validateSettings(base({ claudePath: "claude" })), CenterSettingsError);
  assert.equal(validateSettings(base({ claudePath: " /usr/bin/claude " })).claudePath, "/usr/bin/claude");
  assert.ok(!("claudePath" in validateSettings(base({ claudePath: "  " }))));
});

test("validate: enabled:true is refused unless the policy allows it (until work unit S)", () => {
  assert.throws(() => validateSettings(base({ enabled: true })), /未対応/);
  assert.doesNotThrow(() => validateSettings(base({ enabled: true }), ok));
});
