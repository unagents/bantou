// instructions/*.md を src/instructions.generated.ts に取り込む（build の時に文面を実行 file に入れるため）。
// 実行時に repo の外の file は読まない。build / build:bin の先頭で実行する。生成物は commit し、test が md との一致を確かめる。
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dir = (p) => fileURLToPath(new URL(p, import.meta.url));
const files = [
  ["COMMON_MD", "../instructions/common.md"],
  ["MASTER_CAP_MD", "../instructions/master-cap.md"],
];
const out = ["// 自動生成: scripts/gen-instructions.mjs（instructions/*.md から）。手で直さない。", ""];
for (const [name, rel] of files) out.push(`export const ${name} = ${JSON.stringify(await readFile(dir(rel), "utf8"))};`, "");
await writeFile(dir("../src/instructions.generated.ts"), out.join("\n"));
