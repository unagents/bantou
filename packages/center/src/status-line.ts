import { HOOK_EVENTS, HOOK_TS_FIELD, SYNC_HOOK_EVENTS } from "./session-activity.js";

/** session の claude の env に入っている session token（center が起動ごとに発行する）。 */
export const SESSION_TOKEN_ENV = "BANTOU_SESSION_TOKEN";

/** statusLine の stdin JSON の POST 先 path。 */
export const statusLinePath = (name: string): string => `/sessions/${name}/status-line`;

/** hook の stdin JSON の POST 先 path。 */
export const hookPath = (name: string): string => `/sessions/${name}/hook`;

/** session 向け MCP 窓口の URL（http://host:port/mcp/session）から、同じ center の status-line の URL を作る。 */
export const statusLineUrl = (mcpUrl: string, name: string): string => new URL(statusLinePath(name), mcpUrl).toString();

/** MCP 窓口の URL から、同じ center の hook 受け口の URL を作る。 */
export const hookUrl = (mcpUrl: string, name: string): string => new URL(hookPath(name), mcpUrl).toString();

const shellQuote = (s: string, platform: NodeJS.Platform): string =>
  platform === "win32" ? `"${s.replace(/"/g, '\\"')}"` : `'${s.replace(/'/g, `'\\''`)}'`;

/** center 自身を再実行する argv。compiled 実行（bun build --compile）は実行ファイル 1 本、node / bun で動かす時は script と execArgv も要る。 */
export function selfCommand(execPath = process.execPath, argv1 = process.argv[1], execArgv = process.execArgv): string[] {
  return /(^|[\\/])(node|bun)(\.exe)?$/i.test(execPath) && argv1 ? [execPath, ...execArgv, argv1] : [execPath];
}

/**
 * claude の statusLine.command に入れる文字列（claude が shell 経由で実行する）。
 * center 自身の `status-line` サブコマンド。token は argv に載せず、claude の env（BANTOU_SESSION_TOKEN）から子が読む。
 * bun / node / curl に依存しない（compiled の center 1 本で動く）。
 */
export function statusLineCommand(url: string, self: string[] = selfCommand(), platform: NodeJS.Platform = process.platform): string {
  return [...self, "status-line", "--url", url].map((a) => shellQuote(a, platform)).join(" ");
}

/** claude の hooks.command に入れる文字列。center 自身の `hook` サブコマンド（token は env から読む）。 */
export function hookCommand(url: string, self: string[] = selfCommand(), platform: NodeJS.Platform = process.platform): string {
  return [...self, "hook", "--url", url].map((a) => shellQuote(a, platform)).join(" ");
}

/**
 * `claude --settings` に渡す JSON 文字列。statusLine と（hookCmd があれば）hooks のキーだけを持つ（他の設定は上書きしない）。
 * hooks は利用者の hooks と足し合わされる（置き換えない）。async: true で claude の動作を待たせない（ただし Stop / StopFailure は同期。async のままだと、claude が Stop 直後に終了する時（-p）に hook が cancel され idle が届かない）。
 */
export const statusLineSettings = (command: string, hookCmd?: string): Record<string, unknown> => ({
  statusLine: { type: "command", command },
  ...(hookCmd
    ? { hooks: Object.fromEntries(HOOK_EVENTS.map((ev) => [ev, [{ hooks: [{ type: "command", command: hookCmd, ...(SYNC_HOOK_EVENTS.has(ev) ? {} : { async: true }), timeout: 10 }] }]])) }
    : {}),
});
export const statusLineSettingsJson = (command: string, hookCmd?: string): string => JSON.stringify(statusLineSettings(command, hookCmd));

/** サブコマンドの POST のタイムアウト。claude は更新のたびに実行し、遅いと実行を打ち切るので短くする。 */
export const STATUS_LINE_TIMEOUT_MS = 2000;
/** stdin の上限（statusLine の JSON は数 KB）。 */
const MAX_STDIN_BYTES = 1024 * 1024;

async function readAll(stdin: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of stdin) {
    const b = typeof c === "string" ? Buffer.from(c) : c;
    size += b.length;
    if (size > MAX_STDIN_BYTES) throw new Error("stdin が大きすぎる");
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * `bantou-center status-line --url <url>`: stdin の JSON を center に POST する。
 * stdout には何も出さない（claude の表示に出ないようにする）。失敗は stderr に 1 行出すだけで、終了コードは常に 0（claude の表示を壊さない）。
 */
export async function runStatusLine(
  argv: string[],
  io: {
    env?: NodeJS.ProcessEnv;
    stdin?: AsyncIterable<Buffer | string>;
    stderr?: (line: string) => void;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    /** 送る body を加工する（hook サブコマンドが発火時刻を足す）。 */
    transform?: (body: string) => string;
  } = {},
): Promise<number> {
  const env = io.env ?? process.env;
  const err = io.stderr ?? ((l: string) => void process.stderr.write(`${l}\n`));
  const i = argv.indexOf("--url");
  const url = i >= 0 ? argv[i + 1] : undefined;
  const token = env[SESSION_TOKEN_ENV];
  if (!url) {
    err("status-line: --url が無い");
    return 0;
  }
  if (!token) {
    err(`status-line: env ${SESSION_TOKEN_ENV} が無い`);
    return 0;
  }
  try {
    const body = await readAll(io.stdin ?? process.stdin);
    const res = await (io.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: io.transform ? io.transform(body) : body,
      signal: AbortSignal.timeout(io.timeoutMs ?? STATUS_LINE_TIMEOUT_MS),
    });
    if (!res.ok) err(`status-line: center が ${res.status} を返した`);
  } catch (e) {
    err(`status-line: 送信失敗 ${e instanceof Error ? e.message : String(e)}`);
  }
  return 0;
}

/** hook の stdin JSON に発火時刻を足す。JSON object でなければそのまま。 */
export function addHookTimestamp(body: string, ts: number = Date.now()): string {
  try {
    const v: unknown = JSON.parse(body);
    if (typeof v === "object" && v !== null && !Array.isArray(v)) return JSON.stringify({ ...v, [HOOK_TS_FIELD]: ts });
  } catch {
    // 壊れた JSON は center が 400 で断る
  }
  return body;
}

/** `bantou-center hook --url <url>`: claude の hook の stdin JSON を center に POST する（発火時刻を足す）。stdout なし・終了コード 0。 */
export function runHook(argv: string[], io: Parameters<typeof runStatusLine>[1] = {}): Promise<number> {
  const ts = Date.now();
  return runStatusLine(argv, { ...io, transform: (b) => addHookTimestamp(b, ts) });
}
