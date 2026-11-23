import { hostname } from "node:os";
import { createMessengerClient } from "@unagents/messenger-client";
import { MESSENGER_PROTOCOL, parseServerInfoReply } from "@agent-hand/bantou-protocol";
import type { AnswerMessage, ApproveMessage, LaunchMessage, RejectMessage, ServerInfoMessage, StopMessage } from "@agent-hand/bantou-protocol";
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
  summary?: string;
  hostname?: string;
  /** broker が付ける登録時刻（ISO 8601）。同名 peer の新旧判定に使う。 */
  registered_at?: string;
  last_seen?: string;
  /** peer が declare している protocol（name + version）。 */
  protocols?: { name: string; version: string }[];
}

/** server_list の 1 行: protocol「bantou」で broker に登録されている peer。 */
export interface ServerListEntry {
  name: string;
  host: string | null;
  /** peer が declare している protocol「bantou」の版。 */
  protocol: string | null;
  last_seen: string | null;
}

/** 受信 message のうち link が使う部分。 */
export interface LinkInbound {
  from_id?: string;
  from_name: string;
  text: string;
  mode?: string;
  meta?: LinkMeta | null;
}

/**
 * 起床の直前の印。眠らせた claude の peer 登録は broker に最大約 60 秒残る。起床後に送る先は「印より後に登録された peer」だけにする（古い peer へ送ると ok になって消える）。
 * since は broker が付けた registered_at の時刻、exclude は印の時点にいた同名 peer の id。
 */
export interface PeerMark {
  exclude: ReadonlySet<string>;
  since?: string;
}

/** link が使う messenger client の最小形（テストで偽物に差し替える）。 */
export interface LinkClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  send(to: string, text: string, delivery?: "pull" | "push", meta?: LinkMeta): Promise<unknown>;
  listPeers?(scope?: "all" | "host" | "directory" | "repo", filter?: { protocol?: string; version?: string }): Promise<LinkPeer[]>;
  onMessage(handler: (m: LinkInbound) => void | Promise<void>): () => void;
  /** 自分の peer 状態（実 client のみ）。 */
  peer?: { id: string | null };
}

/** launch の入力（center が組み立てる。本文の protocol / callType / order は link が付ける）。 */
export interface LaunchInput {
  parentId: string;
  /** 省略すると launch に model を入れない。 */
  model?: string;
  prompt: string;
  ws: string;
}

/** reply の入力。 */
export interface ReplyInput {
  sessionId: string;
  order: "answer" | "approve" | "reject";
  content?: string;
}

/**
 * center -> server の送信と、server-info の答えの受信。protocol「bantou」の本文は JSON 1 つ、meta = MESSENGER_PROTOCOL。
 * 宛先は agent-messenger の名前（server の名前）そのまま。送った事だけを返す（server からの返しは cap の名前に直接届くので、center は受けない）。
 */
export interface ServerLink {
  /** center の agent-messenger 上の名前。 */
  readonly name: string;
  /** broker に繋ぐ。同名が既に在る等で登録に失敗したら投げる（起動しない）。 */
  connect(): Promise<void>;
  launch(server: string, input: LaunchInput): Promise<void>;
  stop(server: string, parentId: string): Promise<void>;
  reply(server: string, input: ReplyInput): Promise<void>;
  /** server-info を送る（答えは onMessage で受け、serverVersionOf に控える）。 */
  requestServerInfo(server: string): Promise<void>;
  /** server-info の答えで控えた、server（名前）の npm bantou の版。未取得は undefined。 */
  serverVersionOf(server: string): string | undefined;
  /**
   * name の名前を持つ messenger peer（master-cap の session）へ text を push で送る。
   * peer が見つからない・送れない時は ok:false と理由を返す（投げない）。bantou protocol の message ではない。
   */
  notifyPeer(name: string, text: string, opts?: { mark?: PeerMark }): Promise<{ ok: true; to: string } | { ok: false; reason: string }>;
  /** broker に protocol「bantou」で登録されている peer（server）の一覧。自分は除く。投げる事がある（未接続・列挙に非対応）。 */
  listServers(): Promise<ServerListEntry[]>;
  /** 起床の直前に控える印（失敗は null）。 */
  peerMarkOf(name: string): Promise<PeerMark | null>;
  close(): Promise<void>;
}

/** version 不一致時に messenger が text 先頭へ付ける警告行（JSON を壊すので除く）。 */
const WARNING_LINE = /^\[agent-messenger warning\][^\n]*\n?/;

/** text 先頭の messenger 警告行を取り除く。 */
export function stripWarning(text: string): string {
  let t = text;
  while (WARNING_LINE.test(t)) t = t.replace(WARNING_LINE, "");
  return t;
}

/** 実 client を作る。名前は center の名前（bantou-center-<key>）。普通の解決（env → config → UDP 発見 → ローカル fallback）で broker につなぐ。 */
export function createClient(name: string, log: Logger): LinkClient {
  return createMessengerClient({
    name,
    summary: `center ${hostname()}`,
    autoStartBroker: false,
    log: (m) => log(`messenger: ${m}`),
  }) as unknown as LinkClient;
}

/** 印が無ければ全部。あれば、印の時点にいなかった peer で、登録が印の since 以後の物だけ（registered_at の無い peer は id だけで見る）。 */
function isNewerPeer(p: { id: string; registered_at?: string }, mark?: PeerMark): boolean {
  if (!mark) return true;
  if (mark.exclude.has(p.id)) return false;
  return mark.since === undefined || p.registered_at === undefined || p.registered_at >= mark.since;
}

export function createServerLink(opts: {
  /** center の名前（bantou-center-<key>）。 */
  name: string;
  log: Logger;
  clientFactory?: (name: string) => LinkClient;
}): ServerLink {
  const { log, name } = opts;
  const clientFactory = opts.clientFactory ?? ((n: string): LinkClient => createClient(n, log));
  let client: LinkClient | null = null;
  let unsubscribe: (() => void) | null = null;
  let closed = false;
  const versions = new Map<string, string>();

  const body = (b: LaunchMessage | StopMessage | AnswerMessage | ApproveMessage | RejectMessage | ServerInfoMessage): string => JSON.stringify(b);

  const clientOrThrow = (): LinkClient => {
    if (closed) throw new Error("center 終了");
    if (!client) throw new Error("messenger に接続していない");
    return client;
  };

  const sendTo = async (server: string, message: Parameters<typeof body>[0]): Promise<void> => {
    await clientOrThrow().send(server, body(message), "pull", { protocol: MESSENGER_PROTOCOL.protocol, version: MESSENGER_PROTOCOL.version });
    log(`指示送信: to=${server} ${message.callType}/${message.order}`);
  };

  return {
    name,
    async connect() {
      if (client) return;
      const c = clientFactory(name);
      unsubscribe = c.onMessage((m) => {
        if (m.mode === "ping") return;
        const info = parseServerInfoReply(stripWarning(m.text));
        if (info) {
          versions.set(m.from_name, info.version);
          log(`server-info: ${m.from_name} version=${info.version}`);
        }
      });
      try {
        await c.connect();
      } catch (e) {
        unsubscribe();
        unsubscribe = null;
        await c.close().catch(() => {});
        throw e;
      }
      client = c;
      log(`messenger 接続: name=${name} peer=${c.peer?.id ?? "?"}`);
    },
    launch: (server, i) => sendTo(server, { protocol: "bantou", callType: "invoke", order: "launch", "parent-id": i.parentId, ...(i.model !== undefined ? { model: i.model } : {}), prompt: i.prompt, ws: i.ws }),
    stop: (server, parentId) => sendTo(server, { protocol: "bantou", callType: "invoke", order: "stop", "parent-id": parentId }),
    reply: (server, i) =>
      i.order === "answer"
        ? sendTo(server, { protocol: "bantou", callType: "reply", order: "answer", "session-id": i.sessionId, content: i.content ?? "" })
        : sendTo(server, { protocol: "bantou", callType: "reply", order: i.order, "session-id": i.sessionId }),
    requestServerInfo: (server) => sendTo(server, { protocol: "bantou", callType: "status", order: "server-info" }),
    serverVersionOf: (server) => versions.get(server),
    async listServers() {
      const c = clientOrThrow();
      if (!c.listPeers) throw new Error("broker が peer の列挙に対応していない");
      const own = c.peer?.id ?? null;
      const peers = (await c.listPeers("all", { protocol: MESSENGER_PROTOCOL.protocol })).filter((p) => p.id !== own);
      return peers.map((p) => ({
        name: p.name,
        host: p.hostname ?? null,
        protocol: p.protocols?.find((d) => d.name === MESSENGER_PROTOCOL.protocol)?.version ?? null,
        last_seen: p.last_seen ?? null,
      }));
    },
    async peerMarkOf(peerName) {
      try {
        const c = clientOrThrow();
        if (!c.listPeers) return null;
        const own = c.peer?.id ?? null;
        const all = (await c.listPeers("all")).filter((p) => p.id !== own);
        const since = all.map((p) => p.registered_at ?? "").sort().pop();
        return { exclude: new Set(all.filter((p) => p.name === peerName).map((p) => p.id)), ...(since ? { since } : {}) };
      } catch {
        return null;
      }
    },
    async notifyPeer(peerName, text, o) {
      let c: LinkClient;
      try {
        c = clientOrThrow();
      } catch (e) {
        return { ok: false, reason: `messenger に接続できない: ${(e as Error).message}` };
      }
      if (!c.listPeers) return { ok: false, reason: "broker が peer の列挙に対応していない" };
      try {
        const own = c.peer?.id ?? null;
        const hits = (await c.listPeers("all")).filter((p) => p.name === peerName && p.id !== own && isNewerPeer(p, o?.mark));
        if (hits.length === 0) return { ok: false, reason: `messenger に peer ${peerName} がいない（session が agent-messenger につながっていない${o?.mark?.exclude.size ? `。起床前からの古い登録 ${o.mark.exclude.size} 件は除外` : ""}）` };
        // session の再起動直後は、止まった client の古い登録が heartbeat 失効（60 秒）まで残り同名が並ぶ。最後に登録した peer を選ぶ
        hits.sort((a, b) => (b.registered_at ?? "").localeCompare(a.registered_at ?? ""));
        if (hits.length > 1) log(`通知先の peer が複数: name=${peerName} ${hits.map((p) => p.id).join(",")} -> ${hits[0].id}（最新の登録）`);
        await c.send(hits[0].id, text, "push");
        return { ok: true, to: hits[0].id };
      } catch (e) {
        return { ok: false, reason: `送信失敗: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
    async close() {
      closed = true;
      unsubscribe?.();
      unsubscribe = null;
      const c = client;
      client = null;
      if (c) await c.close().catch(() => {});
    },
  };
}
