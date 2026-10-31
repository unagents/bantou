import { readFileSync } from "node:fs";
import { MESSENGER_PROTOCOL, isValidServerVersion } from "@agent-hand/bantou-protocol";

/** この center（= この desktop のビルド）と組になる版。 */
export interface Pair {
  /** 組になる server の npm 版（npm `bantou`）。分からなければ undefined（版合わせは無効）。 */
  server: string | undefined;
  /** 組になる protocol `bantou` の版（このバイナリに bundle した protocol の版）。 */
  protocol: string;
}

/**
 * 組の server 版を決める。
 * 1. env BANTOU_PAIR_SERVER_VERSION（desktop のビルド `bun build --compile --env=BANTOU_PAIR_*` が埋め込む）
 * 2. 無ければ作業ツリーの server/package.json（src / dist のどちらからでも develop/server/package.json）
 * 3. どちらも無い・不正なら undefined
 * 注意: bun の埋め込みは `process.env.BANTOU_PAIR_SERVER_VERSION` というリテラルを置き換えるので、この参照は変えない。
 */
export function resolvePair(
  opts: { envValue?: string | undefined; readPackage?: () => string | undefined; warn?: (m: string) => void } = {},
): Pair {
  const envValue = "envValue" in opts ? opts.envValue : process.env.BANTOU_PAIR_SERVER_VERSION;
  const readPackage = opts.readPackage ?? readServerPackageVersion;
  let server: string | undefined;
  if (envValue !== undefined && envValue !== "") {
    if (isValidServerVersion(envValue)) server = envValue;
    else opts.warn?.(`BANTOU_PAIR_SERVER_VERSION が不正（無視する）: ${envValue}`);
  }
  if (server === undefined) {
    const v = readPackage();
    if (v !== undefined && isValidServerVersion(v)) server = v;
  }
  return { server, protocol: MESSENGER_PROTOCOL.version };
}

function readServerPackageVersion(): string | undefined {
  try {
    const url = new URL("../../../server/package.json", import.meta.url);
    const v = (JSON.parse(readFileSync(url, "utf8")) as { version?: unknown }).version;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}
