// 版ごとの定義 hash の記録（messenger/versions.json）と、今の定義の突き合わせ。
// 定義（protocol.json / PROTOCOL.md）を変えたのに版を上げ忘れると、ここが落ちる。
// hash は agent-messenger の protocolHash と同じ: sha256(canonicalJSON({ manifest: <protocol.json を parse した値>, doc: <PROTOCOL.md の文字列> }))。
// server が登録する hash と同じことは packages/server/test/server/utils/bantou/protocol-registration.test.ts が実 broker で確かめる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { MESSENGER_PROTOCOL } from "../dist/index.js";

const dir = new URL("../messenger/", import.meta.url);
const manifestText = readFileSync(new URL("protocol.json", dir), "utf8");
const doc = existsSync(new URL("PROTOCOL.md", dir)) ? readFileSync(new URL("PROTOCOL.md", dir), "utf8") : "";
const manifest = JSON.parse(manifestText);
const versions = JSON.parse(readFileSync(new URL("versions.json", dir), "utf8"));

// agent-messenger (@unagents/messenger-protocol) の canonicalJSON と同じ（キーを昇順、undefined / function / symbol は落とす）
function canonicalJSON(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJSON(v)).join(",")}]`;
  const parts = [];
  for (const k of Object.keys(value).sort()) {
    const v = value[k];
    if (v === undefined || typeof v === "function" || typeof v === "symbol") continue;
    parts.push(`${JSON.stringify(k)}:${canonicalJSON(v)}`);
  }
  return `{${parts.join(",")}}`;
}
const protocolHash = (m, d) => createHash("sha256").update(canonicalJSON({ manifest: m, doc: d })).digest("hex");

const HOWTO = "定義（protocol.json / PROTOCOL.md）を変えたら、protocol.json の version と MESSENGER_PROTOCOL.version（src/server.ts）を上げ、messenger/versions.json に「版: hash」を 1 行足す。同じ版で中身が違うと broker は PROTOCOL_CONFLICT で登録を断る";

// 世に出た版のうち、1 つの版に複数の hash がある例外。ここに無い版に 2 つ目の hash を足して test を通すことはできない。
// 1.6.0: 4b58bb3（34ae8dbc…）→ 0f6bc85 / server 0.6.2（eb42f07e…）。
// 1.8.0: server 0.6.4 / 0.6.5（6c776c34…）と 0.6.6（0f6b7191…）。事故 2026-11-11（PROTOCOL_CONFLICT）。1.8.1 で解消した。
const EXCEPTIONS = {
  "1.6.0": [
    "34ae8dbc4ed82f65ed237f17b37ebf773e6914396b7132d6e3baea2222755b07",
    "eb42f07e72e852c99a6c52fb2c62701cab88ef5e55cbe944531e11a2256d32ae",
  ],
  "1.8.0": [
    "6c776c34082e6232532c5172ede64e7e8a85e07ee755f0e831e6647bc9a610d1",
    "0f6b7191c0273a666c2fea7c221a2f41409de299035c6d6bddcefebc6515fa0f",
  ],
};

test("今の定義の hash が、今の版に記録された hash と一致する", () => {
  const v = manifest.version;
  assert.equal(MESSENGER_PROTOCOL.version, v, "MESSENGER_PROTOCOL.version と protocol.json の version がずれている");
  assert.ok(Object.hasOwn(versions, v), `versions.json に ${v} の記録が無い。${HOWTO}`);
  assert.equal(typeof versions[v], "string", `${v} は今の版なので hash は 1 つの文字列で記録する（例外は過去の版だけ）`);
  assert.equal(
    protocolHash(manifest, doc),
    versions[v],
    `今の定義の hash が versions.json の ${v} と違う。版を上げずに定義を変えた可能性がある。${HOWTO}`,
  );
});

test("versions.json の形: 版は semver、hash は 64 桁 hex、複数 hash を持つのは例外に名指しした版だけ", () => {
  for (const [ver, h] of Object.entries(versions)) {
    assert.match(ver, /^\d+\.\d+\.\d+$/, ver);
    if (Object.hasOwn(EXCEPTIONS, ver)) {
      assert.deepEqual(h, EXCEPTIONS[ver], `${ver} は例外として固定した hash と一致しなければならない`);
    } else {
      assert.equal(typeof h, "string", `${ver} に複数の hash は持てない。同じ版の別定義は broker で衝突する。版を上げる`);
      assert.match(h, /^[0-9a-f]{64}$/, ver);
    }
  }
  assert.ok(!Object.hasOwn(EXCEPTIONS, manifest.version), "今の版は例外にできない");
});

test("hash の計算: 定義の 1 文字違いで hash が変わる（protocol.json は parse 後の値、PROTOCOL.md は 1 byte でも）", () => {
  const base = protocolHash(manifest, doc);
  assert.notEqual(protocolHash({ ...manifest, description: manifest.description + "x" }, doc), base);
  assert.notEqual(protocolHash(manifest, doc + "x"), base);
  // 空白・改行だけの違い（parse 後は同じ）では変わらない
  assert.equal(protocolHash(JSON.parse(JSON.stringify(manifest, null, 4)), doc), base);
});
