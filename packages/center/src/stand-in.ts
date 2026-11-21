/**
 * スリープ中の session の身代わり peer を、center とは別の process で出す。
 *
 * messenger の broker は、同じ pid・host の peer を 1 つだけ保つ（register で同じ pid の古い peer を消す）。
 * 身代わりを center の中に置くと、center 自身の peer と互いに追い出し合い、同名の peer が並ぶ。そのため 1 session = 1 子 process にする。
 * 子は `bantou-center stand-in --name <peer 名>`。peer を登録し、届いた message を 1 行の JSON で stdout に出す。
 * 親（center）の終了（stdin が閉じる）・SIGTERM で peer を外して終わる。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { hostname } from "node:os";
import { createBrokerClient, createMessengerClient, loadConfig, resolveBroker } from "@unagents/messenger-client";
import type { LinkClient, LinkInbound } from "./server-link.js";
import type { Logger } from "./log.js";
import { selfCommand } from "./status-line.js";

export const STAND_IN_USAGE = "usage: bantou-center stand-in --name <peer name>";
const READY = "ready";

/** broker への POST の最小形（テストで偽物に差し替える）。 */
export type BrokerPost = (path: "/list-peers" | "/unregister", body: Record<string, unknown>) => Promise<unknown>;

/**
 * 眠らせた claude の古い登録を broker から外す。
 * claude が SIGKILL・強制終了などで止まると、その messenger client が登録を外せず、broker に約 60 秒残る。同名が並ぶと名前宛ての送信は
 * `Name "<name>" is ambiguous` で失敗し、身代わりに届かない。身代わりは眠っている間だけ置くので、同じ host の同名の自分以外の peer はすべて古い登録。
 * 外した peer の id の一覧を返す。失敗は投げない（外せなければ従来どおり、約 60 秒後の失効に任せる）。
 */
export async function evictStaleSameName(post: BrokerPost, name: string, ownId: string | null, host: string, log: (m: string) => void): Promise<string[]> {
  const evicted: string[] = [];
  try {
    const r = (await post("/list-peers", { scope: "all", ...(ownId ? { exclude_id: ownId } : {}) })) as { peers?: Array<{ id: string; name?: string; hostname?: string }> };
    for (const p of r.peers ?? []) {
      if (p.name !== name || p.id === ownId || (p.hostname !== undefined && p.hostname !== host)) continue;
      try {
        await post("/unregister", { id: p.id });
        evicted.push(p.id);
      } catch (e) {
        log(`古い同名の登録を外せない: peer=${p.id} ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    log(`同名の登録を調べられない: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (evicted.length > 0) log(`眠らせた claude の古い同名の登録を外した: name=${name} peer=${evicted.join(",")}`);
  return evicted;
}

/** 子 process 側。登録できたら {"ready":true}、message が届くたびに {"message":{...}} を 1 行ずつ出す。 */
export async function runStandIn(argv: string[], io: { out: (l: string) => void; err: (l: string) => void }): Promise<number | "serving"> {
  const i = argv.indexOf("--name");
  const name = i >= 0 ? argv[i + 1] : undefined;
  if (!name) {
    io.err(STAND_IN_USAGE);
    return 2;
  }
  const client = createMessengerClient({
    name,
    summary: `center ${hostname()} (スリープ中の session の身代わり)`,
    autoStartBroker: false,
    log: (m) => io.err(m),
  });
  client.onMessage((m) => {
    const msg = m as unknown as LinkInbound;
    io.out(JSON.stringify({ message: { from_id: msg.from_id, from_name: msg.from_name, text: msg.text, mode: msg.mode, meta: msg.meta ?? null } }));
  });
  try {
    await client.connect();
  } catch (e) {
    io.err(`messenger に接続できない: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  // 古い同名の登録を外してから ready を出す（親は ready の後に名前宛ての message を受け付ける）
  try {
    const cfg = loadConfig(process.env);
    const broker = createBrokerClient(cfg.token);
    await resolveBroker(cfg, broker, (m) => io.err(m));
    await evictStaleSameName((path, body) => broker.post(path as "/unregister", body as { id: string }), name, client.peer.id, hostname(), (m) => io.err(m));
  } catch (e) {
    io.err(`古い同名の登録の掃除に失敗: ${e instanceof Error ? e.message : String(e)}`);
  }
  io.out(JSON.stringify({ [READY]: true }));
  const done = (): void => {
    void client.close().catch(() => {}).finally(() => process.exit(0));
  };
  process.stdin.on("end", done);
  process.stdin.on("close", done);
  process.stdin.resume();
  process.once("SIGTERM", done);
  process.once("SIGINT", done);
  return "serving";
}

/** 親（center）側。LinkClient の形で身代わりの子 process を扱う（connect = 子を起動して登録を待つ、close = 子を止める）。 */
export function createProcessStandInClient(
  peerName: string,
  log: Logger,
  opts: { command?: string[]; env?: NodeJS.ProcessEnv; readyTimeoutMs?: number } = {},
): LinkClient {
  let child: ChildProcess | null = null;
  const handlers = new Set<(m: LinkInbound) => void | Promise<void>>();
  const stop = (): void => {
    const c = child;
    child = null;
    if (!c) return;
    c.stdin?.end();
    c.kill("SIGTERM");
  };
  return {
    connect: () =>
      new Promise<void>((resolve, reject) => {
        const [cmd, ...rest] = opts.command ?? [...selfCommand(), "stand-in", "--name", peerName];
        const c = spawn(cmd, rest, { env: opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
        child = c;
        let settled = false;
        const settle = (err?: Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) {
            if (child === c) stop();
            reject(err);
          } else resolve();
        };
        const timer = setTimeout(() => settle(new Error("身代わりの peer の登録がタイムアウト")), opts.readyTimeoutMs ?? 30_000);
        timer.unref();
        c.stdin?.on("error", () => {});
        c.stderr?.on("data", (d: Buffer) => {
          for (const l of d.toString("utf8").split("\n")) if (l.trim()) log(`messenger(${peerName} 身代わり): ${l.trim()}`);
        });
        createInterface({ input: c.stdout! }).on("line", (line) => {
          let v: { ready?: boolean; message?: LinkInbound };
          try {
            v = JSON.parse(line) as typeof v;
          } catch {
            return;
          }
          if (v.ready) settle();
          else if (v.message) for (const h of handlers) void Promise.resolve(h(v.message)).catch((e) => log(`身代わり peer の受信処理が失敗: ${e instanceof Error ? e.message : String(e)}`));
        });
        c.once("error", (e) => settle(new Error(`身代わりの子 process を起動できない: ${e.message}`)));
        c.once("exit", (code, signal) => {
          if (child === c) child = null;
          settle(new Error(`身代わりの子 process が終了（code=${code ?? "-"} signal=${signal ?? "-"}）`));
        });
      }),
    close: async () => {
      stop();
    },
    send: async () => {
      throw new Error("身代わり peer は送信しない");
    },
    onMessage: (h) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
  };
}
