// 指示文の md を server/utils/bantou/instructions.generated.ts に取り込む（build の時に文面を package に入れるため）。
// 共通の文面の元は packages/center/instructions/common.md（1 つだけ。ここへは生成で入る）。
// 実行時に repo の外の file は読まない。build / dev / e2e / prepack の先頭で実行する。生成物は commit し、test が md との一致を確かめる。
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dir = (p) => fileURLToPath(new URL(p, import.meta.url));
const files = [
  ["COMMON_MD", "../../center/instructions/common.md"],
  ["WORKER_MD", "../instructions/worker.md"],
];
const out = ["// 自動生成: scripts/gen-instructions.mjs（instructions/*.md と packages/center/instructions/common.md から）。手で直さない。", ""];
for (const [name, rel] of files) out.push(`export const ${name} = ${JSON.stringify(await readFile(dir(rel), "utf8"))};`, "");
await writeFile(dir("../server/utils/bantou/instructions.generated.ts"), out.join("\n"));
