import { execFileSync } from "node:child_process";

import { MOCK_BUNDLE, PROJECT_DIR } from "./paths";

/** Bundle the browser-side mock once per run (plain IIFE for addInitScript). */
export default function globalSetup() {
  execFileSync(
    "bun",
    ["build", "e2e/mock/install.ts", "--target=browser", "--format=iife", `--outfile=${MOCK_BUNDLE}`],
    { cwd: PROJECT_DIR, stdio: "inherit" },
  );
}
