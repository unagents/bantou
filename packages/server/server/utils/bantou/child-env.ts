/**
 * cap / worker の claude に渡す env から、npx / npm が自分の起動のために入れた変数を外す。
 *
 * server は npx（`npx -y bantou@latest`、supervisor は `npx -y --package=<spec> -- bantou ...`）で起動されるので、
 * env に npm_config_package / npm_config_yes / npm_lifecycle_* などが入っている。これが claude とその子
 * （extraMcp の stdio の道具、worker が叩く npx）まで引き継がれると、子の `npx -y foo@1 <args>` が
 * npm_config_package を --package として読み、`foo@1` をコマンドとして探して失敗する。
 *
 * 線:
 * - 外す: その npx の起動にだけ意味がある物。何を実行するか（package / call / yes / workspace 系）、
 *   どの npm がどこで実行したか（user_agent / npm_version / node_gyp / global_prefix / local_prefix）、
 *   npm が実行中の script を表す物（npm_command / npm_execpath / npm_node_execpath / npm_lifecycle_* / npm_package_*）。
 * - 残す: 上記以外の npm_config_*。registry（scope 別を含む）・認証（`//host/:_authToken` など）・proxy・cafile・
 *   userconfig・cache・prefix など「どこから・どう取得するか」の設定で、利用者が env や `npx --registry` で意図して与える物。
 *   外すと私的 registry や認証が子の npx で効かなくなる。npm が既定から解決して入れた値（cache / prefix / userconfig）も
 *   子の npm が自分で解決する値と同じなので残して害が無い。
 * - npm_ で始まらない物（INIT_CWD / NODE / COLOR / EDITOR / PATH）は触らない。子の npm が入れ直す物か、利用者自身の設定でありうる。
 *
 * server 自身の process.env は変えない（自動更新の取得確認と supervisor の npx は従来どおり自分の env で動く）。
 */

/** 外す npm_config_* の key（npm と同じ正規化: 先頭以外の `_` を `-`、小文字）。 */
const DROP_CONFIG_KEYS = new Set([
  // npm exec の対象（何を実行するか）
  "package",
  "call",
  "yes",
  "workspace",
  "workspaces",
  "include-workspace-root",
  // 実行した npm 自身とその場所
  "user-agent",
  "npm-version",
  "node-gyp",
  "global-prefix",
  "local-prefix",
]);

const CONFIG_PREFIX = /^npm_config_/i;
/** npm / run-script が実行中の script を表すために入れる物。npm は小文字で入れる（NPM_TOKEN など利用者の大文字の変数は残す）。 */
const RUN_VARS = /^(npm_command|npm_execpath|npm_node_execpath|npm_lifecycle_.*|npm_package_.*)$/;

/** npm が env の npm_config_* を読む時と同じ正規化（@npmcli/config）。`//` で始まる認証の key はそのまま。 */
function configKey(envKey: string): string {
  const k = envKey.slice("npm_config_".length);
  return k.startsWith("//") ? k : k.replace(/(?!^)_/g, "-").toLowerCase();
}

/** npx / npm が自分の起動のために入れた変数か。 */
export function isNpxOwnEnv(name: string): boolean {
  if (RUN_VARS.test(name)) return true;
  return CONFIG_PREFIX.test(name) && DROP_CONFIG_KEYS.has(configKey(name));
}

/** env から npx / npm が自分の起動のために入れた変数を外した写しを返す（元は変えない）。 */
export function stripNpxEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (!isNpxOwnEnv(k)) out[k] = v;
  }
  return out;
}
