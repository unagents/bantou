// launcher テスト用の偽の `bantou --supervise`。本物の runSupervisor を偽の子（fake-serve）で動かす。
// FAKE_NEXT=1 なら更新時に偽の次期 supervisor（fake-next）へ引き継ぐ。
import { fileURLToPath } from "node:url";
import { runSupervisor } from "../../bin/supervisor.mjs";

const configPath = process.argv[process.argv.indexOf("--config") + 1];
const serve = fileURLToPath(new URL("./fake-serve.mjs", import.meta.url));
const next = fileURLToPath(new URL("./fake-next.mjs", import.meta.url));
const handoff = process.env.FAKE_NEXT === "1";
try {
  const code = await runSupervisor({
    configPath,
    selfBin: "unused",
    version: "sup-1",
    command: (spec) => ({ cmd: process.execPath, args: [serve, String(spec)] }),
    log: () => {},
    handoff,
    probe: async () => handoff,
    nextCommand: (spec) => ({ cmd: process.execPath, args: [next, spec, configPath] }),
    readyTimeoutMs: 5000,
    handoffSlackMs: 0,
  });
  process.exit(code);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
