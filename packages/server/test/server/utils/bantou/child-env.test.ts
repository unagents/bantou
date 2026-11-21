import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isNpxOwnEnv, stripNpxEnv } from "../../../../server/utils/bantou/child-env";
import { verifyFetch } from "../../../../server/utils/bantou/update";

/** npm 11 の `npx -y --package=<spec> -- <bin>` が子に渡す npm_* の形（値は架空）。 */
const NPX_CHILD_ENV: NodeJS.ProcessEnv = {
  npm_command: "exec",
  npm_config_allow_scripts: "",
  npm_config_cache: "/home/u/.npm",
  npm_config_global_prefix: "/usr/local",
  npm_config_globalconfig: "/usr/local/etc/npmrc",
  npm_config_init_module: "/home/u/.npm-init.js",
  npm_config_local_prefix: "/srv/bantou",
  npm_config_node_gyp: "/usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js",
  npm_config_noproxy: "",
  npm_config_npm_version: "11.0.0",
  npm_config_package: "bantou@0.6.10",
  npm_config_prefix: "/usr/local",
  npm_config_user_agent: "npm/11.0.0 node/v22.0.0 linux x64 workspaces/false",
  npm_config_userconfig: "/home/u/.npmrc",
  npm_config_yes: "true",
  npm_execpath: "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
  npm_lifecycle_event: "npx",
  npm_lifecycle_script: "bantou",
  npm_node_execpath: "/usr/local/bin/node",
  npm_package_json: "/srv/bantou/package.json",
  INIT_CWD: "/srv/bantou",
  NODE: "/usr/local/bin/node",
};

test("stripNpxEnv: npx が自分の起動のために入れた物は外し、取得元・認証の設定と npm_ 以外は残す", () => {
  const env: NodeJS.ProcessEnv = {
    ...NPX_CHILD_ENV,
    // 利用者が意図して与える取得元・認証・proxy
    npm_config_registry: "https://registry.example.test/",
    "npm_config_@scope:registry": "https://scope.example.test/",
    "npm_config_//registry.example.test/:_authToken": "dummy",
    npm_config_https_proxy: "http://proxy.example.test:3128",
    NPM_TOKEN: "dummy",
    // exec の別の引数・大文字の指定も npm は同じに読む
    npm_config_call: "echo hi",
    npm_config_workspace: "a",
    npm_config_include_workspace_root: "true",
    NPM_CONFIG_PACKAGE: "other@1",
    npm_package_name: "x",
    HOME: "/home/u",
    PATH: "/usr/bin",
  };
  const before = { ...env };
  const out = stripNpxEnv(env);
  assert.deepEqual(env, before, "元の env は変えない");

  const dropped = Object.keys(env).filter((k) => !(k in out)).sort();
  assert.deepEqual(dropped, [
    "NPM_CONFIG_PACKAGE",
    "npm_command",
    "npm_config_call",
    "npm_config_global_prefix",
    "npm_config_include_workspace_root",
    "npm_config_local_prefix",
    "npm_config_node_gyp",
    "npm_config_npm_version",
    "npm_config_package",
    "npm_config_user_agent",
    "npm_config_workspace",
    "npm_config_yes",
    "npm_execpath",
    "npm_lifecycle_event",
    "npm_lifecycle_script",
    "npm_node_execpath",
    "npm_package_json",
    "npm_package_name",
  ]);
  for (const k of [
    "npm_config_registry",
    "npm_config_@scope:registry",
    "npm_config_//registry.example.test/:_authToken",
    "npm_config_https_proxy",
    "npm_config_userconfig",
    "npm_config_globalconfig",
    "npm_config_cache",
    "npm_config_prefix",
    "NPM_TOKEN",
    "INIT_CWD",
    "NODE",
    "HOME",
    "PATH",
  ]) {
    assert.equal(out[k], env[k], `${k} は残す`);
  }
  assert.equal(isNpxOwnEnv("npm_config_package"), true);
  assert.equal(isNpxOwnEnv("npm_config_registry"), false);
  assert.equal(isNpxOwnEnv("NPM_TOKEN"), false);
});

// -- 実際の npx で確かめる（npx が無ければ飛ばす。cache は一時 dir、offline） ------------------

function hasNpx(): boolean {
  try {
    execFileSync("npx", ["--version"], { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

function runNpx(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("npx", args, { env, cwd, encoding: "utf8", timeout: 120_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

/** bin を持つ手元の package を作る。bins は名前 → node の本文。 */
async function makePackage(dir: string, name: string, version: string, bins: Record<string, string>): Promise<string> {
  await mkdir(dir, { recursive: true });
  const bin: Record<string, string> = {};
  for (const [b, body] of Object.entries(bins)) {
    const file = `${b}.js`;
    bin[b] = file;
    await writeFile(join(dir, file), `#!/usr/bin/env node\n${body}\n`);
    await chmod(join(dir, file), 0o755);
  }
  await writeFile(join(dir, "package.json"), JSON.stringify({ name, version, bin }));
  return dir;
}

test("実 npx: npx で起動した server の env を外せば worker の npx が通り、自動更新の取得確認も通る", { skip: !hasNpx() && "npx が無い" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "bantou-child-env-test-"));
  const savedEnv = process.env;
  try {
    // server 本体の代わり（npx で起動され、受け取った env を書き出す）
    const outer = await makePackage(join(dir, "outer"), "bantou-test-outer", "0.0.1", {
      "bantou-test-dump-env": `require("node:fs").writeFileSync(process.argv[2], JSON.stringify(process.env));`,
      bantou: `console.log("0.0.1");`,
    });
    // worker が npx で起動する道具（superbash の代わり）
    const tool = await makePackage(join(dir, "tool"), "bantou-test-tool", "1.0.0", {
      "bantou-test-tool": `console.log("TOOL OK registry=" + (process.env.npm_config_registry ?? ""));`,
    });
    // 自動更新の更新先
    const next = await makePackage(join(dir, "next"), "bantou-test-next", "0.3.1", {
      bantou: `console.log("0.3.1");`,
    });
    await writeFile(join(dir, "npmrc"), "");

    // server を起動する側の env（npm_* の無い所から。利用者は registry を指定している）
    const base: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!/^npm_/i.test(k)) base[k] = v;
    Object.assign(base, {
      npm_config_cache: join(dir, "cache"),
      npm_config_userconfig: join(dir, "npmrc"),
      npm_config_offline: "true",
      npm_config_update_notifier: "false",
      npm_config_registry: "https://registry.example.test/",
    });

    // supervisor と同じ形で npx から起動された server が受け取る env
    const dumpFile = join(dir, "server-env.json");
    const launched = await runNpx(["-y", `--package=file:${outer}`, "--", "bantou-test-dump-env", dumpFile], base, dir);
    assert.equal(launched.code, 0, launched.stderr);
    const serverEnv = JSON.parse(await readFile(dumpFile, "utf8")) as NodeJS.ProcessEnv;
    assert.equal(serverEnv.npm_config_package, `file:${outer}`, "npx は子に npm_config_package を渡す（前提）");

    // そのまま引き継ぐと worker の `npx -y <spec>` は npm_config_package を読んで失敗する（症状の再現）
    const leaked = await runNpx(["-y", `file:${tool}`], serverEnv, dir);
    assert.notEqual(leaked.code, 0, "外さないと失敗する");
    // spec をコマンドとして探している（linux の sh は not found、mac は No such file）
    assert.ok(leaked.stderr.includes(`file:${tool}`) && /not found|No such file/.test(leaked.stderr), leaked.stderr);

    // 外した env では通り、利用者の registry は道具まで届く
    const childEnv = stripNpxEnv(serverEnv);
    assert.equal(childEnv.npm_config_package, undefined);
    const ok = await runNpx(["-y", `file:${tool}`], childEnv, dir);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /TOOL OK registry=https:\/\/registry\.example\.test\//);

    // 自動更新の取得確認は server 自身の env（npx から受け取ったまま）で動き、明示の --package が勝つ
    process.env = { ...serverEnv };
    await verifyFetch(`file:${next}`, "0.3.1");
    assert.equal(process.env.npm_config_package, `file:${outer}`, "server 自身の env は変えていない");
  } finally {
    process.env = savedEnv;
    await rm(dir, { recursive: true, force: true });
  }
});
