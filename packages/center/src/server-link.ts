import { hostname } from "node:os";
import { createBrokerClient, createMessengerClient } from "@unagents/messenger-client";
import {
  MESSENGER_PROTOCOL,
  PROTOCOL_VERSION,
  SERVER_NAME,
  parseServerReply,
  type CapResultReply,
  type ErrorReply,
  type KickCapCommand,
  type ResumeWorkerCommand,
  type ServerCommandType,
  type StatusReply,
  type WorkerResultReply,
} from "@agent-hand/bantou-protocol";
import type { Config, ServerConfig } from "./config.js";
import type { Logger } from "./log.js";

/** messenger の meta（protocol 名と version）。 */
export interface LinkMeta {
  protocol: string;
  version: string;
}

/** listPeers が返す peer のうち link が使う部分。 */
export interface LinkPeer {
  id: string;
  name: string;
  protocols?: Array<{ name: string; version: string }>;
}

/** 受信 message のうち link が使う部分。 */
export interface LinkInbound {
  from_id?: string;
  from_name: string;
  text: string;
  mode?: string;
  meta?: LinkMeta | null;
}

/** link が使う messenger client の最小形（テストで偽物に差し替える）。 */
export interface LinkClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  send(to: string, text: string, delivery?: "pull" | "push", meta?: LinkMeta): Promise<unknown>;
  /** protocol で peer を絞って列挙する（0.10.0 broker のみ。無い・失敗は名前宛てにフォールバックする）。 */
  listPeers?(scope?: "all" | "host" | "directory" | "repo", filter?: { protocol?: string; version?: string }): Promise<LinkPeer[]>;
  onMessage(handler: (m: LinkInbound) => void | Promise<void>): () => void;
  /** 自分の peer 状態（実 client のみ）。 */
  peer?: { id: string | null };
}

export interface ServerInfo {
  name: string;
  broker: string;
  connected: boolean;
  reachable: boolean;
  /** その broker 上での center 自身の peer id。 */
  peerId: string | null;
  /** 直近に解決した server の送信先（peer id または名前）。未解決は null。 */
  serverPeer: string | null;
}

export type KickCapInput = Omit<KickCapCommand, "bantou" | "type">;
export type ResumeWorkerInput = Omit<ResumeWorkerCommand, "bantou" | "type">;

export interface ServerLink {
  connectAll(): Promise<void>;
  list(): Promise<ServerInfo[]>;
  kickCap(server: string, cmd: KickCapInput): Promise<CapResultReply | ErrorReply>;
  resumeWorker(server: string, cmd: ResumeWorkerInput): Promise<WorkerResultReply | ErrorReply>;
  status(server: string): Promise<StatusReply | ErrorReply>;
  close(): Promise<void>;
}

type ReplyKind = "cap_result" | "worker_result" | "status_result";

interface Pending {
  kind: ReplyKind;
  command: ServerCommandType;
  /** cap_id / worker_id。status は無し。 */
  key?: string;
  resolve: (r: unknown) => void;
  timer: NodeJS.Timeout;
}

interface Slot {
  cfg: ServerConfig;
  client: LinkClient | null;
  unsubscribe: (() => void) | null;
  connected: boolean;
  /** 接続時点の自分の peer id（変化したら返信が届かなくなる）。 */
  peerId: string | null;
  /** 接続処理中の promise（並行 ensure の二重接続を防ぐ）。 */
  connecting: Promise<LinkClient> | null;
  pending: Pending[];
  /** 同じ cap_id / worker_id への指示を直列にするための末尾 promise。 */
  chains: Map<string, Promise<unknown>>;
  /** 直近に解決した server の peer id（返信の送信元照合に使う）。 */
  serverId: string | null;
  /** 直近に解決した送信先（id か名前）。list 表示用。 */
  serverPeer: string | null;
}

/** server の送信先と、meta に載せる version。 */
export interface Target {
  to: string;
  meta: LinkMeta;
}

const KIND_COMMAND: Record<ReplyKind, ServerCommandType> = {
  cap_result: "kick_cap",
  worker_result: "resume_worker",
  status_result: "status",
};

/** version 不一致時に messenger が text 先頭へ付ける警告行（JSON を壊すので除く）。 */
const WARNING_LINE = /^\[agent-messenger warning\][^\n]*\n?/;

/** text 先頭の messenger 警告行を取り除く。 */
export function stripWarning(text: string): string {
  let t = text;
  while (WARNING_LINE.test(t)) t = t.replace(WARNING_LINE, "");
  return t;
}

const errorReply = (message: string, command?: ServerCommandType): ErrorReply => ({
  bantou: PROTOCOL_VERSION,
  type: "error",
  ok: false,
  message,
  ...(command ? { command } : {}),
});

/**
 * 実 client を作る。接続先は設定の broker に固定する。
 * messenger-client は brokers の疎通に失敗すると 127.0.0.1:7901 へ黙ってフォールバックするので、
 * フォールバックの無い HOST/PORT 指定（env）で渡す。
 */
export function createPinnedClient(s: ServerConfig, log: Logger): LinkClient {
  const u = new URL(s.broker);
  return createMessengerClient({
    env: {
      AGENT_MESSENGER_HOST: u.hostname,
      AGENT_MESSENGER_PORT: u.port || "80",
      AGENT_MESSENGER_DISCOVERY: "off",
      AGENT_MESSENGER_TOKEN: s.token ?? "",
    },
    name: "bantou-center",
    summary: `center ${hostname()}`,
    autoStartBroker: false,
    log: (m) => log(`messenger(${s.name}): ${m}`),
  }) as unknown as LinkClient;
}

export function createServerLink(opts: {
  config: Config;
  log: Logger;
  clientFactory?: (server: ServerConfig) => LinkClient;
  /** broker の到達確認（既定は /health）。 */
  healthCheck?: (server: ServerConfig) => Promise<boolean>;
  /** peer id の変化を見る間隔（既定 5 秒）。 */
  peerWatchMs?: number;
}): ServerLink {
  const { config, log } = opts;
  const clientFactory = opts.clientFactory ?? ((s: ServerConfig): LinkClient => createPinnedClient(s, log));
  const healthCheck =
    opts.healthCheck ??
    (async (s: ServerConfig): Promise<boolean> => {
      const h = await createBrokerClient(s.token ?? "").health(s.broker);
      return h !== null;
    });

  let closed = false;
  const slots = new Map<string, Slot>();
  for (const s of config.servers) {
    slots.set(s.name, { cfg: s, client: null, unsubscribe: null, connected: false, peerId: null, connecting: null, pending: [], chains: new Map(), serverId: null, serverPeer: null });
  }
  const slotOf = (name: string): Slot => {
    const s = slots.get(name);
    if (!s) throw new Error(`未定義の server: ${name}`);
    return s;
  };

  /** pending を取り出して解決する。 */
  const settle = (slot: Slot, p: Pending, value: unknown): void => {
    const i = slot.pending.indexOf(p);
    if (i >= 0) slot.pending.splice(i, 1);
    clearTimeout(p.timer);
    p.resolve(value);
  };

  /** 送信元が server か。解決済みの peer id、bantou protocol の meta、SERVER_NAME、servers[].peer のいずれか。 */
  const fromServer = (slot: Slot, m: LinkInbound): boolean =>
    (m.from_id !== undefined && m.from_id === slot.serverId) ||
    m.meta?.protocol === MESSENGER_PROTOCOL.protocol ||
    m.from_name === SERVER_NAME ||
    (slot.cfg.peer !== undefined && (m.from_name === slot.cfg.peer || m.from_id === slot.cfg.peer));

  const onInbound = (slot: Slot, m: LinkInbound): void => {
    if (m.mode === "ping") return;
    const r = parseServerReply(stripWarning(m.text));
    if (!r || !fromServer(slot, m)) {
      log(`無視: server=${slot.cfg.name} from=${m.from_name} text=${m.text.replace(/\s+/g, " ").slice(0, 120)}`);
      return;
    }
    let target: Pending | undefined;
    if (r.type === "cap_result") {
      target = slot.pending.find((p) => p.kind === "cap_result" && p.key === r.cap_id);
    } else if (r.type === "worker_result") {
      target = slot.pending.find((p) => p.kind === "worker_result" && p.key === r.worker_id);
    } else if (r.type === "status_result") {
      target = slot.pending.find((p) => p.kind === "status_result");
    } else if (r.cap_id !== undefined || r.worker_id !== undefined) {
      // id 付きの error は id で照合する（同じ command の別 id と取り違えない）
      target = slot.pending.find((p) =>
        r.cap_id !== undefined
          ? p.kind === "cap_result" && p.key === r.cap_id
          : p.kind === "worker_result" && p.key === r.worker_id,
      );
    } else {
      target = r.command
        ? slot.pending.find((p) => p.command === r.command)
        : slot.pending[0];
    }
    if (!target) {
      log(`対応する待ちなし: server=${slot.cfg.name} type=${r.type}`);
      return;
    }
    settle(slot, target, r);
  };

  /** 接続を確保する。切れていれば client を作り直す。 */
  const ensure = (slot: Slot): Promise<LinkClient> => {
    if (closed) return Promise.reject(new Error("center 終了"));
    if (slot.client && slot.connected) return Promise.resolve(slot.client);
    slot.connecting ??= connectSlot(slot).finally(() => {
      slot.connecting = null;
    });
    return slot.connecting;
  };

  const connectSlot = async (slot: Slot): Promise<LinkClient> => {
    await dropClient(slot);
    const client = clientFactory(slot.cfg);
    slot.unsubscribe = client.onMessage((m) => onInbound(slot, m));
    slot.client = client;
    try {
      await client.connect();
    } catch (e) {
      await dropClient(slot);
      throw e;
    }
    if (closed) {
      await dropClient(slot, "center 終了");
      throw new Error("center 終了");
    }
    slot.connected = true;
    slot.peerId = client.peer?.id ?? null;
    log(`server 接続: ${slot.cfg.name} broker=${slot.cfg.broker} peer=${client.peer?.id ?? "?"}`);
    return client;
  };

  /** client を捨てる。その client 宛ての待ちは返信が来ないので即エラーにする。 */
  const dropClient = async (slot: Slot, reason = "接続を作り直したため中断"): Promise<void> => {
    slot.connected = false;
    slot.peerId = null;
    for (const p of [...slot.pending]) settle(slot, p, errorReply(reason, p.command));
    slot.unsubscribe?.();
    slot.unsubscribe = null;
    const c = slot.client;
    slot.client = null;
    if (c) await c.close().catch(() => {});
  };

  /**
   * 送信先を解決する（リクエストごと。peer id は再登録で変わるため）。
   * servers[].peer 指定があればそれ（名前指定）。無ければ listPeers の protocol 絞り込みで発見し、
   * 複数なら name が SERVER_NAME のものを優先、次に先頭。0 件・失敗（0.9 broker など）は SERVER_NAME へ。
   * meta の version は発見した peer の宣言を使う（不一致警告を避ける）。
   */
  const resolveTarget = async (slot: Slot, client: LinkClient): Promise<Target> => {
    const meta: LinkMeta = { protocol: MESSENGER_PROTOCOL.protocol, version: MESSENGER_PROTOCOL.version };
    if (slot.cfg.peer) {
      slot.serverId = null;
      slot.serverPeer = slot.cfg.peer;
      return { to: slot.cfg.peer, meta };
    }
    if (client.listPeers) {
      try {
        const peers = await client.listPeers("all", { protocol: MESSENGER_PROTOCOL.protocol });
        const pick = peers.find((p) => p.name === SERVER_NAME) ?? peers[0];
        if (pick) {
          if (peers.length > 1) log(`bantou server が複数: server=${slot.cfg.name} ${peers.map((p) => `${p.name}(${p.id})`).join(",")} -> ${pick.name}(${pick.id})`);
          const v = pick.protocols?.find((p) => p.name === MESSENGER_PROTOCOL.protocol)?.version;
          slot.serverId = pick.id;
          slot.serverPeer = pick.id;
          return { to: pick.id, meta: { protocol: meta.protocol, version: v ?? meta.version } };
        }
        log(`protocol 発見 0 件、名前宛てにフォールバック: server=${slot.cfg.name}`);
      } catch (e) {
        log(`protocol 発見失敗、名前宛てにフォールバック: server=${slot.cfg.name} ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    slot.serverId = null;
    slot.serverPeer = SERVER_NAME;
    return { to: SERVER_NAME, meta };
  };

  /** 同じ key の指示を直列化し、返信（またはタイムアウト）まで待つ。 */
  const request = <R>(
    server: string,
    kind: ReplyKind,
    key: string | undefined,
    payload: object,
  ): Promise<R | ErrorReply> => {
    let slot: Slot;
    try {
      slot = slotOf(server);
    } catch (e) {
      return Promise.reject(e);
    }
    const command = KIND_COMMAND[kind];
    const run = async (): Promise<R | ErrorReply> => {
      if (closed) return errorReply("center 終了", command);
      let client: LinkClient;
      try {
        client = await ensure(slot);
      } catch (e) {
        return errorReply(`server に接続できない: ${server} (${(e as Error).message})`, command);
      }
      if (closed) return errorReply("center 終了", command);
      const target = await resolveTarget(slot, client);
      if (closed) return errorReply("center 終了", command);
      return new Promise<R | ErrorReply>((resolve) => {
        const p: Pending = {
          kind,
          command,
          key,
          resolve: resolve as (r: unknown) => void,
          timer: setTimeout(() => {
            log(`タイムアウト: server=${server} type=${command}${key ? ` id=${key}` : ""}`);
            settle(slot, p, errorReply(`タイムアウト (${slot.cfg.timeoutMs}ms)`, command));
          }, slot.cfg.timeoutMs),
        };
        slot.pending.push(p);
        client
          .send(target.to, JSON.stringify({ bantou: PROTOCOL_VERSION, type: command, ...payload }), "pull", target.meta)
          .then(
            () => log(`指示送信: server=${server} to=${target.to} type=${command}${key ? ` id=${key}` : ""} meta=${target.meta.protocol}@${target.meta.version}`),
            (e: unknown) => {
              // 送信失敗は接続が壊れている可能性が高いので、次回使用時に作り直す
              if (slot.client === client) slot.connected = false;
              settle(slot, p, errorReply(`送信失敗: ${e instanceof Error ? e.message : String(e)}`, command));
            },
          );
      });
    };
    if (key === undefined) return run();
    const chainKey = `${kind}:${key}`;
    const prev = slot.chains.get(chainKey) ?? Promise.resolve();
    const next = prev.then(run, run);
    slot.chains.set(chainKey, next);
    void next.finally(() => {
      if (slot.chains.get(chainKey) === next) slot.chains.delete(chainKey);
    });
    return next;
  };

  // 再登録などで peer id が変わると、旧 id 宛ての返信は届かない。待ちを即エラーにして作り直す
  const watcher = setInterval(() => {
    for (const slot of slots.values()) {
      if (!slot.connected || !slot.client) continue;
      const now = slot.client.peer?.id ?? null;
      if (now === slot.peerId) continue;
      log(`peer id 変化: server=${slot.cfg.name} ${slot.peerId ?? "?"} -> ${now ?? "?"}`);
      void dropClient(slot, "peer id が変わったため中断");
    }
  }, opts.peerWatchMs ?? 5000);
  watcher.unref();

  return {
    async connectAll() {
      await Promise.all(
        [...slots.values()].map((slot) =>
          ensure(slot).then(
            () => undefined,
            (e: unknown) => log(`server 接続失敗: ${slot.cfg.name} ${e instanceof Error ? e.message : String(e)}`),
          ),
        ),
      );
    },
    async list() {
      return Promise.all(
        [...slots.values()].map(async (slot) => ({
          name: slot.cfg.name,
          broker: slot.cfg.broker,
          connected: slot.connected,
          reachable: await healthCheck(slot.cfg).catch(() => false),
          peerId: slot.connected ? (slot.client?.peer?.id ?? null) : null,
          serverPeer: slot.serverPeer,
        })),
      );
    },
    kickCap: (server, cmd) => request<CapResultReply>(server, "cap_result", cmd.cap_id, cmd),
    resumeWorker: (server, cmd) => request<WorkerResultReply>(server, "worker_result", cmd.worker_id, cmd),
    status: (server) => request<StatusReply>(server, "status_result", undefined, {}),
    async close() {
      closed = true;
      clearInterval(watcher);
      for (const slot of slots.values()) {
        for (const p of [...slot.pending]) settle(slot, p, errorReply("center 終了", p.command));
        await dropClient(slot);
      }
    },
  };
}
