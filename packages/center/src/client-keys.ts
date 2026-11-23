import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { dirname } from "node:path";
import { MIN_TOKEN_LEN } from "./config.js";
import { createJsonListStore } from "./store.js";
import type { Logger } from "./log.js";

/**
 * client の鍵（docs/design/center-graphql-server.md 2.4・決定 7）。
 * 鍵を取る接続（POST KEY_PATH）は、設定した IP の範囲からかどうかだけを見て鍵を渡す。それ以外の通信は鍵が無いと受け付けない。
 * 鍵の失効は扱わない。file には鍵の hash だけを置く。
 */
export const KEY_PATH = "/auth/key";

/** IP の範囲の 1 項目（`192.168.1.0/24`・`10.0.0.5`・`fd00::/8` など）が書式として正しいか。 */
export function parseRange(entry: string): { net: string; prefix?: number; family: "ipv4" | "ipv6" } | undefined {
  const [net, p, ...rest] = entry.split("/");
  if (rest.length > 0) return undefined;
  const v = isIP(net);
  if (v === 0) return undefined;
  const family = v === 4 ? "ipv4" : "ipv6";
  if (p === undefined) return { net, family };
  if (!/^\d+$/.test(p)) return undefined;
  const prefix = Number(p);
  if (prefix > (v === 4 ? 32 : 128)) return undefined;
  return { net, prefix, family };
}

/** 範囲の判定器を作る。範囲が空なら、どの接続元も入らない。 */
export function createRangeCheck(ranges: readonly string[]): (remote: string | undefined) => boolean {
  const list = new BlockList();
  for (const r of ranges) {
    const p = parseRange(r);
    if (!p) throw new Error(`IP の範囲が不正: ${r}`);
    if (p.prefix === undefined) list.addAddress(p.net, p.family);
    else list.addSubnet(p.net, p.prefix, p.family);
  }
  return (remote) => {
    if (!remote) return false;
    // IPv4 を IPv6 の socket で受けると `::ffff:a.b.c.d` で来る
    const addr = remote.startsWith("::ffff:") && isIP(remote.slice(7)) === 4 ? remote.slice(7) : remote;
    const v = isIP(addr);
    if (v === 0) return false;
    return list.check(addr, v === 4 ? "ipv4" : "ipv6");
  };
}

/**
 * center 自身が使う token（統括の MCP の子・worker の ws・schema server）。config に `token` が無い起動（bantou-center の本番）で使う。
 * file（0600）に 1 度だけ作り、以後は同じ値を読む（再起動しても worker の ws の宛先が変わらない）。client には渡さない。
 */
export async function ensureInternalToken(file: string): Promise<string> {
  try {
    const t = (await readFile(file, "utf8")).trim();
    if (t.length >= MIN_TOKEN_LEN) return t;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const t = randomBytes(32).toString("hex");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${t}\n`, { mode: 0o600 });
  return t;
}

export interface ClientKeys {
  /** 新しい鍵を発行して覚える（鍵そのものは返り値だけ。保存するのは hash）。 */
  issue(): Promise<string>;
  /** `Authorization: Bearer <鍵>` が発行済みの鍵か。 */
  verify(header: string | undefined): boolean;
}

interface KeyRecord {
  hash: string;
  issuedAt: string;
}

const hashOf = (s: string): string => createHash("sha256").update(s).digest("hex");

/** 発行済みの鍵を `file`（0600）に覚える。起動時に読み込む。 */
export async function createClientKeys(file: string, log: Logger): Promise<ClientKeys> {
  const store = createJsonListStore<KeyRecord>(file, log);
  const records = (await store.load()).filter((r) => typeof r?.hash === "string");
  const hashes = new Set(records.map((r) => r.hash));
  let chain: Promise<unknown> = Promise.resolve();
  return {
    issue() {
      const key = randomBytes(32).toString("hex");
      const hash = hashOf(key);
      // 保存に成功してから鍵を渡す（渡した鍵が再起動で消えない）。書込は順番に行う
      const done = chain.then(async () => {
        records.push({ hash, issuedAt: new Date().toISOString() });
        await store.save(records);
        hashes.add(hash);
        return key;
      });
      chain = done.catch(() => {});
      return done;
    },
    verify(header) {
      if (!header?.startsWith("Bearer ")) return false;
      return hashes.has(hashOf(header.slice("Bearer ".length)));
    },
  };
}
