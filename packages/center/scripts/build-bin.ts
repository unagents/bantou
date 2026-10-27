/**
 * 単体バイナリを作る: `bun build --compile src/cli.ts`。
 * 使い方: bun scripts/build-bin.ts [--target <bun-target>] [--outfile <path>]
 * 例: npm run build:bin -- --target=bun-darwin-arm64 --outfile dist-bin/bantou-center-darwin-arm64
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let target: string | undefined;
let outfile = join(root, "dist-bin", "bantou-center");

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const m = /^(--target|--outfile)(?:=(.*))?$/.exec(argv[i]);
  const value = m ? (m[2] ?? argv[++i]) : undefined;
  if (!m || !value) {
    console.error("usage: build-bin.ts [--target <bun-target>] [--outfile <path>]");
    process.exit(2);
  }
  if (m[1] === "--target") target = value;
  else outfile = value;
}

const args = ["build", "--compile", join(root, "src", "cli.ts"), "--outfile", outfile];
if (target) args.push("--target", target);
console.error(`bun ${args.join(" ")}`);
const r = spawnSync("bun", args, { cwd: root, stdio: "inherit" });
process.exit(r.status ?? 1);
