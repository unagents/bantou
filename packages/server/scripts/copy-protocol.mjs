// packages/protocol/messenger/* を packages/server/protocol/ へコピーする（npm package に同梱するため）。
// build / dev / e2e / prepack の先頭で実行する。packages/server/protocol は .gitignore。
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../../protocol/messenger/", import.meta.url));
const dest = fileURLToPath(new URL("../protocol/", import.meta.url));
await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });
console.log(`protocol をコピー: ${src} -> ${dest}`);
