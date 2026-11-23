import { readFileSync } from "node:fs";
import { SERVER_VERSION_PATTERN } from "@agent-hand/bantou-protocol";

/**
 * この center（= この desktop のビルド）と組になる server の npm 版（npm `bantou`）。移行の橋（1.x の server への update_server）だけが使う。
 * 1. env BANTOU_PAIR_SERVER_VERSION（desktop のビルド `bun build --compile --env=BANTOU_PAIR_*` が埋め込む）
 * 2. 無ければ作業ツリーの packages/server/package.json（src / dist のどちらからでも packages/center/../server/package.json）
 * 3. どちらも無い・不正なら undefined（橋は送らない）
 * 注意: bun の埋め込みは `process.env.BANTOU_PAIR_SERVER_VERSION` というリテラルを置き換えるので、この参照は変えない。
 */
export function resolvePairServerVersion(
  opts: { envValue?: string | undefined; readPackage?: () => string | undefined; warn?: (m: string) => void } = {},
): string | undefined {
  const envValue = "envValue" in opts ? opts.envValue : process.env.BANTOU_PAIR_SERVER_VERSION;
  if (envValue !== undefined && envValue !== "") {
    if (SERVER_VERSION_PATTERN.test(envValue)) return envValue;
    opts.warn?.(`BANTOU_PAIR_SERVER_VERSION が不正（無視する）: ${envValue}`);
  }
  const v = (opts.readPackage ?? readServerPackageVersion)();
  return v !== undefined && SERVER_VERSION_PATTERN.test(v) ? v : undefined;
}

function readServerPackageVersion(): string | undefined {
  try {
    const url = new URL("../../server/package.json", import.meta.url);
    const v = (JSON.parse(readFileSync(url, "utf8")) as { version?: unknown }).version;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}
