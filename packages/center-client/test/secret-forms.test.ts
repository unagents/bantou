// Spellings of a secret that come back in free text (review of 3d, L1).

import assert from "node:assert/strict";
import { test } from "node:test";
import { maskSecrets, scrub } from "../src/index.ts";

const TOKEN = 'Ab"Cd\\Ef-0123456789/+x';
const clean = (text: string, secret = TOKEN) => {
  const out = maskSecrets(text, [secret]);
  assert.ok(out.includes("***"), `not masked: ${text}`);
  return out;
};
const b64 = (s: string, k = 0) => Buffer.concat([Buffer.alloc(k), Buffer.from(s)]).toString("base64");

test("exact form", () => assert.equal(clean(`x ${TOKEN} y`), "x *** y"));
test("other letter case", () => assert.ok(!clean(`x ${TOKEN.toUpperCase()} ${TOKEN.toLowerCase()}`).match(/ab"cd/i)));
test("JSON-escaped form (quote and backslash)", () => {
  const esc = JSON.stringify(TOKEN).slice(1, -1);
  assert.notEqual(esc, TOKEN);
  assert.equal(clean(`{"a":"${esc}"}`), '{"a":"***"}');
});
test("percent-encoded form, either case of the hex", () => {
  const enc = encodeURIComponent(TOKEN);
  assert.equal(clean(`?t=${enc}&`), "?t=***&");
  assert.equal(clean(`?t=${enc.toLowerCase()}&`), "?t=***&");
});
test("\\uXXXX form, either case of the hex", () => {
  const u = [...TOKEN].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  assert.equal(clean(`"${u}"`), '"***"');
  assert.equal(clean(`"${u.toUpperCase()}"`), '"***"');
});
test("base64 form, standard and url-safe, at every alignment inside a longer base64 text", () => {
  for (const k of [0, 1, 2]) {
    for (const [name, enc] of [
      ["std", (s: string) => Buffer.from(s).toString("base64")],
      ["url", (s: string) => Buffer.from(s).toString("base64url")],
    ] as const) {
      const wrapped = enc(`${"p".repeat(k)}${TOKEN}${"s".repeat(2 - k)}`);
      const out = maskSecrets(`a ${wrapped} b`, [TOKEN]);
      assert.ok(out.includes("***"), `${name} k=${k}: ${out}`);
    }
  }
  assert.ok(!maskSecrets(b64(TOKEN), [TOKEN]).includes(b64(TOKEN).slice(0, 12)));
});
test("a plain secret of 12 chars: base64 and URL forms too", () => {
  const t = "abcdefghijkl";
  assert.ok(!maskSecrets(`Bearer ${b64(t)}`, [t]).includes(b64(t)));
  assert.ok(!maskSecrets(`x ${t.toUpperCase()}`, [t]).includes(t.toUpperCase()));
});
test("a short secret (under 4 chars) is masked in its exact form only; text around it is not shredded", () => {
  assert.equal(maskSecrets("ab AB cab", ["ab"]), "*** AB c***");
  assert.equal(maskSecrets("a1b2 A1B2", ["a1b"]), "a1b2 A1B2".replace("a1b", "***"));
  assert.equal(maskSecrets("nothing here", ["abcdefgh"]), "nothing here");
});
test("regex characters in a secret are literal", () => {
  assert.equal(maskSecrets("a.*+?^${}()|[]x", [".*+?^${}()|[]"]), "a***x");
  assert.equal(maskSecrets("abc", [".*+?^${}()|[]"]), "abc");
});
test("scrub (mcp.ts) uses the same forms for the token and the URL password", () => {
  const url = "http://user:Pw%2Fx9Qq7@127.0.0.1:1/mcp";
  const out = scrub(`t=${TOKEN.toUpperCase()} p=${encodeURIComponent("Pw/x9Qq7")} q=${b64("Pw/x9Qq7")}`, url, TOKEN);
  assert.ok(!out.toLowerCase().includes("ab\"cd"));
  assert.ok(!out.includes("Pw%2Fx9Qq7") && !out.includes(b64("Pw/x9Qq7")));
});
