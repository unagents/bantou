#!/usr/bin/env node
// memory 本体の起動 wrapper。MEMORY_PORT（既定 7930）を Nitro の port にして .output を起動する
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.NITRO_PORT ||= process.env.MEMORY_PORT || "7930";
const here = dirname(fileURLToPath(import.meta.url));
await import(join(here, "..", ".output", "server", "index.mjs"));
