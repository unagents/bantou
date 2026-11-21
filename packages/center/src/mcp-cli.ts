/**
 * `bantou-center mcp ...`: MCP の接続の設定・鍵・試す。center の側だけで扱う（MCP・画面からは書けない）。
 *
 * 鍵の値は標準入力か file からだけ受ける。引数に書かれた時は値を出さずに断る。表示・error の文に鍵・header の値・query は出さない。
 * 保存した接続は center が session の起動の --mcp-config に載せる（mcp-session.ts）。外部記憶（役割 memory）への切り替えは別のまとまり。
 * 接続と割り当ての正本は普通の設定（center-settings.json と session の settings の mcpServers）。この CLI が書く mcp-connections.json は旧設定で、
 * center の起動時に普通の設定へ移される（移した後は .migrated に退ける）。鍵の file（mcp secret）と mcp test / list は引き続きここで扱う。
 */
import { dirname, resolve } from "node:path";
import {
  createConnectionsStore,
  effectiveRaw,
  validateAll,
  validateAny,
  validateConnection,
  validateName,
  type AnyConnection,
  configHash,
  type ConnectionsData,
  type ConnOverride,
  type McpConnection,
} from "./mcp-connections.js";
import { dirIsWide, own, setOwn } from "./mcp-json-file.js";
import { probeConnection, type ProbeResult } from "./mcp-probe.js";
import { checkSecretNameNew, checkSecretValue, createSecretsStore } from "./mcp-secrets.js";
import { createStatusStore, statusKey } from "./mcp-status.js";
import { displayUrl } from "./memory-settings.js";
import { isPlain } from "./mcp-connections.js";

/** 普通の MCP の設定（設定の mcpServers に直接書いた物）の 1 行。中身は設定 file にある。 */
const describePlain = (name: string, c: Record<string, unknown>): string => `  ${name}: 普通の MCP の設定（type ${typeof c.type === "string" ? c.type : "stdio"}。中身は設定 file の mcpServers）`;
import { SESSION_NAME } from "./sessions.js";

export const MCP_USAGE = `usage:
  bantou-center mcp list  [--config <path>] [--session <name>]
  bantou-center mcp get   <名前> [--config <path>] [--session <name>]
  bantou-center mcp set   <名前> [--config <path>] [--session <name>]
          [--url <url>] [--auth-header <名前>] [--auth-format <形>] [--secret <鍵の名前>] [--no-auth]
          [--header <名前>=<値>]... [--clear-headers]
          [--identity-header <名前>] [--identity <値>] [--no-identity]
          [--tool-prefix <前置き> | --no-tool-prefix] [--allow <道具>]... [--deny <道具>]... [--clear-tools]
          [--role memory | --no-role] [--expose-memory-write | --no-expose-memory-write]
          [--timeout-ms <n>] [--allow-plain-http] [--off]
  bantou-center mcp unset <名前> [--config <path>] [--session <name>]
  bantou-center mcp secret set <鍵の名前> (--stdin | --file <path>) [--config <path>]
  bantou-center mcp secret unset <鍵の名前> [--config <path>]
  bantou-center mcp secret list [--config <path>]
  bantou-center mcp test  <名前> [--config <path>] [--session <name>] [--json]
--session を省くと全 session 共通。--session を付けた set は項目ごとの上書き（--off はその session では付けない）。
鍵は引数に書けない（--stdin は標準入力、--file は file の中身。末尾の改行は除く）。list / get は鍵の値を出さない。
--secret は接続が使う鍵の「名前」の参照で、値ではない（短い識別子。値らしい形は断る）。鍵を入れるのは secret set <名前> --stdin|--file だけ。<名前> の位置に値を書かない。
名前の検査は値らしい形を断るだけの緩和で、短い値は名前として通りうる。値は必ず標準入力か file で渡す。
この CLI の set / unset が書く mcp-connections.json は旧設定。center は起動時に普通の設定（mcpServers）へ移し、以後は普通の設定が正本になる（README の「追加の MCP の接続」）。
鍵は session の子の env にだけ渡り、表示・log・status には出ない。
claude に直接渡せない設定（--tool-prefix・--allow・--role）の接続は session に載せない。外部記憶（役割 memory）への切り替えはこの版では行わない（今の外部記憶は bantou-center memory の設定）。
test の終了 code: 0 = 道具の一覧が取れた、1 = 取れない、2 = 使い方の誤り。`;

export interface McpCliDeps {
  /** 標準入力の全文（--stdin の時だけ呼ぶ）。 */
  readStdin: () => string;
  readFile: (path: string) => string;
  out: (line: string) => void;
  err: (line: string) => void;
  /** 試す本体（test で差し替え可）。 */
  probe?: typeof probeConnection;
  now?: () => Date;
}

class UsageError extends Error {}

/** 値を引数に書かせない flag（値は出さずに断る）。 */
const REFUSED = /^--(value|token|password|secret-value|key|api-key|bearer)(=|$)/;

const VALUE_FLAGS = new Set(["--config", "--session", "--url", "--auth-header", "--auth-format", "--secret", "--header", "--identity-header", "--identity", "--tool-prefix", "--allow", "--deny", "--role", "--timeout-ms", "--file"]);
const BOOL_FLAGS = new Set(["--no-auth", "--clear-headers", "--no-identity", "--no-tool-prefix", "--clear-tools", "--no-role", "--expose-memory-write", "--no-expose-memory-write", "--allow-plain-http", "--off", "--stdin", "--json"]);

const SET_FLAGS = new Set(["--url", "--auth-header", "--auth-format", "--secret", "--header", "--identity-header", "--identity", "--tool-prefix", "--allow", "--deny", "--role", "--timeout-ms", "--no-auth", "--clear-headers", "--no-identity", "--no-tool-prefix", "--clear-tools", "--no-role", "--expose-memory-write", "--no-expose-memory-write", "--allow-plain-http", "--off"]);

interface Parsed {
  positional: string[];
  flags: Map<string, string[]>;
}

function parse(args: string[]): Parsed {
  const p: Parsed = { positional: [], flags: new Map() };
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    if (!k.startsWith("--")) {
      p.positional.push(k);
      continue;
    }
    if (REFUSED.test(k)) throw new UsageError("鍵や値は引数に書けない（鍵は mcp secret set の --stdin か --file を使う）");
    if (VALUE_FLAGS.has(k)) {
      if (i + 1 >= args.length) throw new UsageError(`${k} に値が無い`);
      p.flags.set(k, [...(p.flags.get(k) ?? []), args[++i]]);
    } else if (BOOL_FLAGS.has(k)) p.flags.set(k, ["true"]);
    else {
      // 値が混ざりうるので、引数の中身は出さない（`--名前` の名前の部分だけ出す）
      const name = /^--[A-Za-z][A-Za-z0-9-]*/.exec(k)?.[0];
      throw new UsageError(name ? `不明な引数: ${name}（値を引数に書けない。鍵は標準入力か file を使う）` : "不明な引数");
    }
  }
  return p;
}

const one = (p: Parsed, k: string): string | undefined => p.flags.get(k)?.[p.flags.get(k)!.length - 1];
const has = (p: Parsed, k: string): boolean => p.flags.has(k);

function allowFlags(p: Parsed, allowed: Iterable<string>): void {
  const ok = new Set(["--config", "--session", ...allowed]);
  for (const k of p.flags.keys()) if (!ok.has(k)) throw new UsageError(`${k} はこの command では使えない`);
}

const scopeLabel = (s: string | undefined): string => (s === undefined ? "全 session 共通" : `session ${s}`);

function describeConn(name: string, c: McpConnection, secretInfo: (n: string) => string, statusLine: string): string {
  const secretName = c.auth ? (c.auth.secret ?? name) : undefined;
  const parts = [
    `role=${c.role ?? "なし"}`,
    `url=${displayUrl(c.url)}`,
    `auth=${c.auth ? `${c.auth.header ?? "Authorization"}（鍵 ${secretInfo(secretName as string)}）` : "なし"}`,
    `headers=${Object.keys(c.headers ?? {}).join(",") || "なし"}（値は出さない）`,
    `identity=${c.identity ? `${c.identity.header}=${c.identity.value ?? "(session 名)"}` : "なし"}`,
    `toolPrefix=${c.toolPrefix ?? "なし"}`,
    `tools=allow:${c.tools?.allow?.length ?? 0} deny:${c.tools?.deny?.length ?? 0}`,
    ...(c.exposeMemoryWrite ? ["exposeMemoryWrite=true"] : []),
    ...(c.timeoutMs ? [`timeoutMs=${c.timeoutMs}`] : []),
    statusLine,
  ];
  return `  ${name}: ${parts.join(" ")}`;
}


/** `bantou-center mcp ...` の本体。戻り値は exit code（0 成功、2 使い方の誤り、1 失敗）。 */
export async function runMcpCli(argv: string[], defaultConfig: string, deps: McpCliDeps): Promise<number> {
  const fail = (msg: string): number => {
    deps.err(msg);
    deps.err(MCP_USAGE);
    return 2;
  };
  let p: Parsed;
  try {
    p = parse(argv.slice(1));
  } catch (e) {
    return fail(e instanceof UsageError ? e.message : "引数が不正");
  }
  const action = argv[0];
  const session = one(p, "--session");
  if (session !== undefined && !SESSION_NAME.test(session)) return fail("session は英数字と _ - のみ");
  const stateDir = dirname(resolve(one(p, "--config") ?? defaultConfig));
  const log = (m: string): void => deps.err(m);
  const conns = createConnectionsStore(stateDir, log);
  const secrets = createSecretsStore(stateDir, log);
  const status = createStatusStore(stateDir, log);
  const warnDir = (): void => {
    if (dirIsWide(stateDir)) deps.err("警告: 状態 dir の権限が group / other に開いている（鍵の file は 0600 だが、dir は直さない）");
  };
  const secretInfo = (n: string): string => {
    const s = secrets.get(n);
    return s ? `${n}: 設定済み rev ${s.rev}` : `${n}: 未設定`;
  };
  const statusLineOf = (scope: string | undefined, name: string): string => {
    const s = status.get(statusKey(scope, name));
    return s ? `最後に試した結果=${s.result}（${s.checkedAt}）` : "最後に試した結果=未確認";
  };

  try {
    // ---- secret ----
    if (action === "secret") {
      const sub = p.positional[0];
      if (sub !== "set" && sub !== "unset" && sub !== "list") return fail("secret は set / unset / list");
      allowFlags(p, sub === "set" ? ["--stdin", "--file"] : []);
      if (has(p, "--session")) return fail("--session は secret では使えない（session ごとの鍵は名前を <接続名>.<session> にする）");
      const expected = sub === "list" ? 1 : 2;
      if (p.positional.length > expected) return fail("位置引数が多い（鍵の値は引数に書けない。--stdin か --file を使う）");
      if (sub === "list") {
        const sd = secrets.file.load();
        if (sd.problem) deps.err(`鍵の file に問題がある: ${sd.problem}`);
        const cd = conns.read();
        const usedBy = (n: string): string[] => {
          const out: string[] = [];
          for (const [name, c] of Object.entries(cd.common)) if (!isPlain(c) && c.auth && (c.auth.secret ?? name) === n) out.push(name);
          for (const [s, per] of Object.entries(cd.sessions)) for (const [name, o] of Object.entries(per)) if (o && !isPlain(o) && o.auth && (o.auth.secret ?? name) === n) out.push(`${s}/${name}`);
          return out;
        };
        const names = Object.keys(sd.data.secrets);
        if (!names.length) deps.out("鍵なし");
        for (const n of names) deps.out(`${n}: rev ${sd.data.secrets[n].rev} 更新 ${sd.data.secrets[n].updatedAt} 使っている接続: ${usedBy(n).join(", ") || "なし"}`);
        return 0;
      }
      const sname = p.positional[1];
      if (sname === undefined) return fail("鍵の名前が要る");
      // 新しく書く時は値らしさも見る。消す時は、既にある名前なら（値らしくても）消せる
      const nameErr = sub === "unset" && secrets.get(sname) ? undefined : checkSecretNameNew(sname);
      if (nameErr) return fail(nameErr);
      if (sub === "unset") {
        warnDir();
        deps.out(secrets.unset(sname) ? `鍵 ${sname}: 消した` : `鍵 ${sname}: 元から無い`);
        return 0;
      }
      const useStdin = has(p, "--stdin");
      const file = one(p, "--file");
      if (useStdin === (file !== undefined)) return fail("--stdin と --file のどちらか 1 つだけ指定する");
      let raw: string;
      try {
        raw = useStdin ? deps.readStdin() : deps.readFile(file as string);
      } catch {
        deps.err("失敗: 鍵を読めない（標準入力 / file）");
        return 1;
      }
      const value = raw.replace(/\r?\n$/, "");
      const bad = checkSecretValue(value);
      if (bad) return fail(bad);
      warnDir();
      const rev = secrets.set(sname, value, deps.now?.());
      deps.out(`鍵 ${sname}: 設定した（rev ${rev}）。値は表示しない`);
      return 0;
    }

    // ---- list ----
    if (action === "list") {
      allowFlags(p, []);
      if (p.positional.length) return fail("list は名前を取らない");
      const ld = conns.file.load();
      if (ld.problem) deps.err(`接続の file に問題がある: ${ld.problem}`);
      const data = ld.data;
      const show = (scope: string | undefined, header: string): void => {
        const eff = effectiveRaw(data, scope);
        deps.out(header);
        const names = Object.keys(eff);
        if (!names.length) deps.out("  （なし）");
        for (const n of names) {
          const v = validateAny(eff[n], n, { allowPlainHttp: true });
          if (v.ok) deps.out(isPlain(v.value) ? describePlain(n, v.value) : describeConn(n, v.value, secretInfo, statusLineOf(scope, n)));
          else deps.out(`  ${n}: 設定が不正（${v.issues.join(" / ")}）`);
        }
      };
      if (session !== undefined) show(session, `session ${session} で有効な接続:`);
      else {
        show(undefined, "全 session 共通:");
        for (const s of Object.keys(data.sessions)) {
          deps.out(`session ${s} の上書き: ${Object.entries(data.sessions[s]).map(([n, o]) => `${n}${o === null ? "(付けない)" : ""}`).join(", ") || "なし"}`);
          show(s, `session ${s} で有効な接続:`);
        }
      }
      return 0;
    }

    // ---- get / set / unset / test は名前を取る ----
    const name = p.positional[0];
    if (action !== "get" && action !== "set" && action !== "unset" && action !== "test") return fail("command は list / get / set / unset / secret / test");
    if (name === undefined) return fail("接続の名前が要る");
    if (p.positional.length > 1) return fail("位置引数が多い");
    const ne = validateName(name);
    if (ne && action === "set") return fail(`名前が不正: ${ne}`);

    if (action === "get") {
      allowFlags(p, []);
      const ld = conns.file.load();
      if (ld.problem) deps.err(`接続の file に問題がある: ${ld.problem}`);
      const data = ld.data;
      const showEff = (scope: string | undefined): boolean => {
        const raw = effectiveRaw(data, scope)[name];
        if (!raw) return false;
        const v = validateAny(raw, name, { allowPlainHttp: true });
        deps.out(v.ok ? (isPlain(v.value) ? describePlain(name, v.value) : describeConn(name, v.value, secretInfo, statusLineOf(scope, name))).trimStart() : `${name}: 設定が不正（${v.issues.join(" / ")}）`);
        return true;
      };
      if (session !== undefined) {
        const ov = own(own(data.sessions, session), name);
        deps.out(`session ${session}: ${ov === undefined ? "上書きなし" : ov === null ? "この session では付けない" : `上書きの項目 ${Object.keys(ov).join(",") || "なし"}`}`);
        if (!showEff(session)) deps.out(`有効な接続: なし`);
      } else if (!showEff(undefined)) deps.out(`${name}: 共通の接続なし`);
      return 0;
    }

    if (action === "unset") {
      allowFlags(p, []);
      warnDir();
      const ld = conns.file.load();
      if (ld.problem) {
        deps.err(`接続の file が壊れている（手で直す）: ${ld.problem}`);
        return 1;
      }
      const data = ld.data;
      let existed: boolean;
      if (session === undefined) {
        existed = Object.hasOwn(data.common, name);
        const stale = Object.entries(data.sessions).filter(([, per]) => { const o = own(per, name); return o && Object.keys(o).length; }).map(([s]) => s);
        if (existed && stale.length) {
          deps.err(`session の上書きが残っている（先に --session で unset する）: ${stale.join(", ")}`);
          return 1;
        }
        delete data.common[name];
      } else {
        const per = own(data.sessions, session);
        existed = per !== undefined && Object.hasOwn(per, name);
        if (per) {
          delete per[name];
          if (!Object.keys(per).length) delete data.sessions[session];
        }
      }
      conns.file.write(data);
      deps.out(`${scopeLabel(session)}: 接続 ${name} を消した${existed ? "" : "（元から無い）"}。鍵は消さない（mcp secret unset で別に消す）`);
      return 0;
    }

    if (action === "set") {
      allowFlags(p, SET_FLAGS);
      warnDir();
      const ld = conns.file.load();
      if (ld.problem) {
        deps.err(`接続の file が壊れている（手で直してから）: ${ld.problem}`);
        return 1;
      }
      const data = ld.data;
      if (has(p, "--off")) {
        if (session === undefined) return fail("--off は --session と一緒に使う");
        if ([...p.flags.keys()].some((k) => k !== "--off" && k !== "--session" && k !== "--config")) return fail("--off は他の項目と同時に使えない");
        setOwn(data.sessions, session, { ...(own(data.sessions, session) ?? {}), [name]: null });
        conns.file.write(data);
        deps.out(`session ${session}: 接続 ${name} を付けない設定にした（旧設定の file に書いた。center の起動時に普通の設定へ移る）`);
        return 0;
      }
      const base: Record<string, unknown> | undefined = session === undefined ? (own(data.common, name) as Record<string, unknown> | undefined) : effectiveRaw(data, session)[name];
      type Obj = Record<string, unknown>;
      const patch: Obj = {};
      const url = one(p, "--url");
      if (url !== undefined) patch.url = url;
      if (has(p, "--no-auth")) patch.auth = null;
      else if (has(p, "--auth-header") || has(p, "--auth-format") || has(p, "--secret")) {
        const a: Obj = { ...((base?.auth as Obj | undefined) ?? {}) };
        const h = one(p, "--auth-header");
        const f = one(p, "--auth-format");
        const s = one(p, "--secret");
        if (s !== undefined) {
          const e = checkSecretNameNew(s);
          if (e) return fail(e);
        }
        if (h !== undefined) a.header = h;
        if (f !== undefined) a.format = f;
        if (s !== undefined) a.secret = s;
        patch.auth = a;
      }
      if (has(p, "--clear-headers") || has(p, "--header")) {
        const h: Obj = has(p, "--clear-headers") ? {} : { ...((base?.headers as Obj | undefined) ?? {}) };
        for (const kv of p.flags.get("--header") ?? []) {
          const i = kv.indexOf("=");
          if (i <= 0) return fail("--header は <名前>=<値>");
          h[kv.slice(0, i)] = kv.slice(i + 1);
        }
        patch.headers = Object.keys(h).length ? h : null;
      }
      if (has(p, "--no-identity")) patch.identity = null;
      else if (has(p, "--identity-header") || has(p, "--identity")) {
        const prev = (base?.identity as Obj | undefined) ?? {};
        const header = one(p, "--identity-header") ?? (prev.header as string | undefined);
        if (header === undefined) return fail("--identity には --identity-header も要る");
        const value = one(p, "--identity") ?? (prev.value as string | undefined);
        patch.identity = { header, ...(value !== undefined ? { value } : {}) };
      }
      if (has(p, "--no-tool-prefix")) patch.toolPrefix = null;
      else if (has(p, "--tool-prefix")) patch.toolPrefix = one(p, "--tool-prefix");
      if (has(p, "--clear-tools")) patch.tools = null;
      else if (has(p, "--allow") || has(p, "--deny")) {
        const prev = (base?.tools as Obj | undefined) ?? {};
        patch.tools = { ...(has(p, "--allow") ? { allow: p.flags.get("--allow") } : prev.allow ? { allow: prev.allow } : {}), ...(has(p, "--deny") ? { deny: p.flags.get("--deny") } : prev.deny ? { deny: prev.deny } : {}) };
      }
      if (has(p, "--no-role")) patch.role = null;
      else if (has(p, "--role")) patch.role = one(p, "--role");
      if (has(p, "--no-expose-memory-write")) patch.exposeMemoryWrite = null;
      else if (has(p, "--expose-memory-write")) patch.exposeMemoryWrite = true;
      if (has(p, "--timeout-ms")) {
        const t = Number(one(p, "--timeout-ms"));
        if (!Number.isInteger(t)) return fail("--timeout-ms は整数");
        patch.timeoutMs = t;
      }
      if (!Object.keys(patch).length) return fail("変える項目が無い");
      if (base === undefined) patch.transport = "http";
      if (session === undefined && base === undefined && patch.url === undefined) return fail("新しい接続には --url が要る");

      const next: ConnectionsData = structuredClone(data);
      if (session === undefined) {
        const merged: Obj = { ...(base ?? {}) };
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) delete merged[k];
          else merged[k] = v;
        }
        next.common[name] = merged as McpConnection;
      } else {
        const per = own(next.sessions, session);
        const cur = own(per, name);
        setOwn(next.sessions, session, { ...(per ?? {}), [name]: { ...(cur ?? {}), ...patch } as ConnOverride });
      }
      // 触った接続の合成後の検査（形・追加の検査・平文の http）
      const touched = effectiveRaw(next, session)[name];
      const tv = validateConnection(touched, { allowPlainHttp: has(p, "--allow-plain-http") });
      if (!tv.ok) {
        deps.err(`設定が不正: ${tv.issues.join(" / ")}`);
        return 2;
      }
      // 全体の検査: 今までに無かった問題だけで断る（役割 memory の重複・session 側の合成後の崩れ）
      const before = new Set(validateAll(data).map((i) => JSON.stringify(i)));
      const added = validateAll(next).filter((i) => !before.has(JSON.stringify(i)));
      if (added.length) {
        deps.err(`設定が不正: ${[...new Set(added.map((i) => `${i.scope}${i.name ? `/${i.name}` : ""}: ${i.issue}`))].join(" / ")}`);
        return 2;
      }
      conns.file.write(next);
      deps.out(`${scopeLabel(session)}: 接続 ${name} を保存した`);
      if (tv.value.auth && !secrets.get(tv.value.auth.secret ?? name)) deps.out(`注意: 鍵 ${tv.value.auth.secret ?? name} がまだ無い（bantou-center mcp secret set ${tv.value.auth.secret ?? name} --stdin）。保存はした`);
      if (tv.value.role === "memory") deps.out("注意: この版の center は役割 memory の接続をまだ外部記憶には使わない（切り替えは後の版）。今の外部記憶は bantou-center memory の設定");
      else deps.out("注意: 旧設定の file に書いた。center の起動時に普通の設定（mcpServers）へ移り、そこから session に載る。mcp test で先の道具を確かめられる");
      return 0;
    }

    // ---- test ----
    allowFlags(p, ["--json"]);
    const data = conns.file.load().data;
    const raw = effectiveRaw(data, session)[name];
    if (!raw) return fail(`${scopeLabel(session)} に接続 ${name} が無い`);
    const key = statusKey(session, name);
    const json = has(p, "--json");
    const emit = (r: ProbeResult, conn: McpConnection | undefined): number => {
      const server = r.serverName ? `${r.serverName}${r.serverVersion ? ` ${r.serverVersion}` : ""}` : undefined;
      if (json) {
        deps.out(JSON.stringify({ name, scope: session ?? "common", result: r.result, httpStatus: r.httpStatus ?? null, server: server ?? null, toolCount: r.toolCount, visibleTools: r.visibleTools, hasEvent: r.hasEvent ?? null, durationMs: r.durationMs }));
      } else {
        deps.out(`接続 ${name}（${scopeLabel(session)}）: ${r.result}`);
        if (r.httpStatus !== undefined) deps.out(`  HTTP status: ${r.httpStatus}`);
        if (r.result === "config-error") deps.out(conn ? "  設定を確かめる（鍵が無い、または設定が不正。mcp get / mcp secret list）" : "  設定が不正（mcp get で見る）");
        if (r.result === "ok") {
          if (server) deps.out(`  先の server: ${server}`);
          deps.out(`  道具の数: ${r.toolCount}（session に見える: ${r.visibleTools.length}）`);
          deps.out(`  session に見える名前: ${r.visibleTools.map((t) => `mcp__${name}__${t}`).join(", ") || "なし"}`);
          if (r.hasEvent !== undefined) deps.out(`  event（前置き込み）が先に${r.hasEvent ? "ある" : "無い"}（試すだけでは呼ばない）`);
        }
        deps.out(`  所要: ${r.durationMs}ms`);
      }
      return r.result === "ok" ? 0 : 1;
    };
    const v = validateConnection(raw, { allowPlainHttp: true });
    if (!v.ok) {
      deps.err(`設定が不正: ${v.issues.join(" / ")}`);
      const r: ProbeResult = { result: "config-error", toolCount: 0, visibleTools: [], durationMs: 0, configHash: "" };
      return emit(r, undefined);
    }
    const conn = v.value;
    const secretName = conn.auth ? (conn.auth.secret ?? name) : undefined;
    const secret = secretName !== undefined ? secrets.get(secretName)?.value : undefined;
    const r = await (deps.probe ?? probeConnection)({ conn, secret, identity: session ?? "bantou-center-test" });
    try {
      status.put(key, {
        checkedAt: (deps.now?.() ?? new Date()).toISOString(),
        result: r.result,
        ...(r.httpStatus !== undefined ? { httpStatus: r.httpStatus } : {}),
        toolCount: r.toolCount,
        visibleTools: r.visibleTools,
        durationMs: r.durationMs,
        configHash: r.configHash || configHash(conn),
        ...(r.toolsCopy ? { toolsCopy: r.toolsCopy } : {}),
      });
    } catch {
      deps.err("警告: 結果を mcp-status.json に残せなかった");
    }
    return emit(r, conn);
  } catch (e) {
    if (e instanceof UsageError) return fail(e.message);
    // fs の error の message は path だけで値を含まない。それ以外は種類だけ出す
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    deps.err(`失敗: ${typeof code === "string" ? code : e instanceof Error ? e.name : "error"}`);
    return 1;
  }
}
