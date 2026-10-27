import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Compiles `packages/center` into a single binary and stages it as a Tauri sidecar.
// Tauri requires the `-<target-triple>` suffix (see tauri.conf.json `bundle.externalBin`),
// which it strips when bundling. Usage: bun scripts/build-sidecar.ts [--target <rust-triple>]
// Triple precedence: --target, else env TAURI_ENV_TARGET_TRIPLE (set by the tauri CLI), else `rustc -vV` host.

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(scriptDir, "..");
const packagesDir = join(desktopDir, "..", "packages");

const BUN_TARGETS: Record<string, string> = {
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-arm64",
};

function hostTargetTriple(): string {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const line = out.split("\n").find((l) => l.startsWith("host:"));
  if (!line) {
    throw new Error("could not determine host target triple from `rustc -vV`");
  }
  return line.slice("host:".length).trim();
}

function targetFromArgs(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--target") return argv[i + 1];
    if (argv[i].startsWith("--target=")) return argv[i].slice("--target=".length);
  }
  return undefined;
}

function main() {
  const triple = targetFromArgs(process.argv.slice(2)) || process.env.TAURI_ENV_TARGET_TRIPLE || hostTargetTriple();
  const bunTarget = BUN_TARGETS[triple];
  if (!bunTarget) {
    throw new Error(`unsupported target triple: ${triple} (supported: ${Object.keys(BUN_TARGETS).join(", ")})`);
  }

  const protocolDir = join(packagesDir, "protocol");
  console.log("Building packages/protocol...");
  execFileSync("npm", ["run", "build"], { cwd: protocolDir, stdio: "inherit" });

  const binariesDir = join(desktopDir, "src-tauri", "binaries");
  const dest = join(binariesDir, `bantou-center-${triple}`);
  mkdirSync(binariesDir, { recursive: true });

  console.log(`Building bantou-center (${bunTarget})...`);
  execFileSync(
    "bun",
    ["build", "--compile", join(packagesDir, "center", "src", "cli.ts"), "--target", bunTarget, "--outfile", dest],
    { cwd: desktopDir, stdio: "inherit" },
  );
  chmodSync(dest, 0o755);

  console.log(`Sidecar staged: ${dest}`);
}

main();
