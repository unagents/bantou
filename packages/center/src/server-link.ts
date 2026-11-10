import { hostname } from "node:os";
import { createMessengerClient } from "@unagents/messenger-client";
import {
  MESSENGER_PROTOCOL,
  PROTOCOL_VERSION,
  SERVER_NAME,
  parseServerNotice,
  parseServerReply,
  type CapResultReply,
  type ErrorReply,
  type ErrorCode,
  type HelloResultReply,
  type KickCapCommand,
  type ServerNotice,
  type ResumeWorkerCommand,
  type ServerCommandType,
  type TaskCommand,
  type TaskResultReply,
  type WorkerReplyCommand,
  type WorkerReplyResultReply,
  type StatusReply,
  type StopCapCommand,
  type StopResultReply,
  type UpdateResultReply,
  type WorkerResultReply,
} from "@agent-hand/bantou-protocol";
import { DEFAULT_SERVER_TIMEOUT_MS, type Config, type ServerConfig } from "./config.js";
import type { Logger } from "./log.js";
import { ambiguousServerMessage, describeServer, duplicateServerIdMessage, hostOf, identityOfReply, type ServerIdentity } from "./server-identity.js";

/** messenger の meta（protocol 名と version）。 */
export interface LinkMeta {
  protocol: string;
  version: string;
}

/** listPeers が返す peer のうち link が使う部分。 */
export interface LinkPeer {
  id: string;
  name: string;
  /** peer の summary（server は `<host> <workspace>`。peer id が変わっても同じ server を指す key に使う）。 */
  summary?: string;
  hostname?: string;
  /** broker が付ける登録時刻・最終 heartbeat（ISO 8601）。同名 peer の新旧判定に使う。 */
  registered_at?: string;
  last_seen?: string;
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

export interface ServerInfo extends ServerIdentity {
  name: string;
  connected: boolean;
  reachable: boolean;
  /** その broker 上での center 自身の peer id。 */
  peerId: string | null;
  /** 直近に解決した server の送信先（peer id または名前）。未解決は null。 */
  serverPeer: string | null;
  /** serverPeer の識別（server_id / host / user / workspace）。その peer から hello_result / status_result で学んだものだけ（未学習・旧 server は無い）。 */
}

export type KickCapInput = Omit<KickCapCommand, "bantou" | "type">;
export type ResumeWorkerInput = Omit<ResumeWorkerCommand, "bantou" | "type">;
export type StopCapInput = Omit<StopCapCommand, "bantou" | "type">;
export type TaskInput = Omit<TaskCommand, "bantou" | "type">;
export type WorkerReplyInput = Omit<WorkerReplyCommand, "bantou" | "type">;

/** config.servers に依存せず、messenger の発見（protocol bantou）で選んだ server の peer。 */
export interface ServerPeer extends ServerIdentity {
  /** 今の到達先（messenger の peer id。server が再登録すると変わる）。server の識別は server_id（旧 server は無い）。 */
  id: string;
  name: string;
  summary?: string;
  hostname?: string;
  /** peer が宣言している bantou protocol の version（無ければ undefined）。 */
  version?: string;
}

/** 版が違っても送る制御メッセージ（server の更新に使う）。protocol の版の門を通さない。 */
const CONTROL_COMMANDS: readonly ServerCommandType[] = ["hello", "update_server"];

/** hello / update_server の返信待ち。 */
export const FOLLOW_TIMEOUT_MS = 10_000;

/**
 * 送信前の門。protocol の版が合わない、または更新待ちの server への指示を、送る前に断る。
 * 断る時は retryable な error 返信（code 付き）を返す。通すなら undefined。
 */
export type Gate = (peer: { id: string; version?: string }, command: ServerCommandType) => ErrorReply | undefined;

/** stop_cap の返信待ち（server は kill を待つので、通常の指示より短く切る）。 */
export const STOP_TIMEOUT_MS = 30_000;

export interface ServerLink {
  connectAll(): Promise<void>;
  list(): Promise<ServerInfo[]>;
  kickCap(server: string, cmd: KickCapInput): Promise<CapResultReply | ErrorReply>;
  resumeWorker(server: string, cmd: ResumeWorkerInput): Promise<WorkerResultReply | ErrorReply>;
  status(server: string): Promise<StatusReply | ErrorReply>;
  /** config.servers を使わず、protocol bantou で発見できる server の一覧。0.9 broker など発見不能なら空。 */
  peers(): Promise<ServerPeer[]>;
  /**
   * 発見ベースの server 選択。sel は server_id → peer id → host 名 → messenger の名前の順に一致を探す。省略時は先頭。
   * 見つからない、または同じ段で複数に一致（同じ host に server が 2 つなど）する時は投げる（候補は user と workspace 付き）。
   */
  selectPeer(sel?: string): Promise<ServerPeer>;
  /** 指定 peer へ kick_cap を送り、返信（cap_result / error）まで待つ。 */
  kickCapOn(peer: ServerPeer, cmd: KickCapInput): Promise<CapResultReply | ErrorReply>;
  /** 指定 peer へ task を送り、返信（task_result / error）まで待つ。同じ task_id の task_result が後から重ねて届く分は onLateReply へ渡る。 */
  taskOn(peer: ServerPeer, cmd: TaskInput): Promise<TaskResultReply | ErrorReply>;
  /** 指定 peer へ worker_reply を送り、返信（worker_reply_result / error）を待つ（FOLLOW_TIMEOUT_MS で切る）。 */
  workerReplyOn(peer: ServerPeer, cmd: WorkerReplyInput): Promise<WorkerReplyResultReply | ErrorReply>;
  /**
   * 指定 peer へ status を送り、status_result（または error）を待つ（cap の有無の確認用。FOLLOW_TIMEOUT_MS で切る）。
   * cap_id を付けると、server はこの center をその cap の通知先にする（protocol 1.6.0。center の再起動後に通知先を取り戻すのに使う）。
   */
  statusOn(peer: ServerPeer, opts?: { cap_id?: string }): Promise<StatusReply | ErrorReply>;
  /** 指定 peer へ stop_cap を送り、返信（stop_result / error）まで待つ。 */
  stopCapOn(peer: ServerPeer, cmd: StopCapInput): Promise<StopResultReply | ErrorReply>;
  /**
   * peers() に server_id / host / user / workspace を載せたもの。識別が未取得（hello 未確認）の peer へは hello を送って取得する
   * （旧 server の返信 = 識別なしも「取得済み」とし、再送しない。届かなかった peer は IDENTIFY_RETRY_MS 後に再試行）。
   * 無い link（テストの偽物）では peers() を使う。
   */
  identifiedPeers?(): Promise<ServerPeer[]>;
  /** 学習済みの識別（hello_result / status_result の返信から）。peer id → 識別。未学習は undefined。 */
  identityOf?(peerId: string): ServerIdentity | undefined;
  /** 指定 peer へ hello を送り、hello_result（または error）を待つ。protocol の版の門は通らない。 */
  hello(peer: ServerPeer): Promise<HelloResultReply | ErrorReply>;
  /** 指定 peer へ update_server を送り、update_result（または error）を待つ。protocol の版の門は通らない。 */
  updateServer(peer: ServerPeer, version: string): Promise<UpdateResultReply | ErrorReply>;
  /**
   * name の名前を持つ messenger peer（owner の session）へ text を push で送る。
   * peer が見つからない・送れない時は ok:false と理由を返す（投げない）。bantou protocol の指示ではないので版の門は通らない。
   */
  notifyPeer(name: string, text: string): Promise<{ ok: true; to: string } | { ok: false; reason: string }>;
  /** 送る前の門（protocol の版と更新待ち）。断るなら error 返信、通すなら undefined。 */
  gate(peer: ServerPeer, command: ServerCommandType): ErrorReply | undefined;
  /** 追加の門（更新待ちの判定）を差し込む。protocol の版の門はこの前に常に効く。 */
  setGate(g: Gate | undefined): void;
  close(): Promise<void>;
}

type ReplyKind = "cap_result" | "task_result" | "worker_reply_result" | "worker_result" | "stop_result" | "status_result" | "hello_result" | "update_result";

interface Pending {
  kind: ReplyKind;
  command: ServerCommandType;
  /** cap_id / worker_id（worker_reply は cap_id:worker_id）。status は無し。 */
  key?: string;
  /** task の task_id（task_result の照合に使う）。 */
  taskId?: string;
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
  /**
   * serverPeer から最後に学習した識別（list 表示用）。identities（発見から消えた peer id は捨てる）とは別に持つので、
   * 再登録で旧 peer id が一覧から消えても、serverPeer が更新されるまでは残る。serverPeer が別の peer に変わって未学習なら空。
   */
  identity: ServerIdentity;
}

/** server の送信先と、meta に載せる version。 */
export interface Target {
  to: string;
  meta: LinkMeta;
  /** 宛先が宣言している protocol の版（発見で分かった時のみ。名前宛てのフォールバックでは undefined = 不明）。 */
  declared?: string;
  /** 宛先の peer id（発見で分かった時のみ）。 */
  peerId?: string;
}

const KIND_COMMAND: Record<ReplyKind, ServerCommandType> = {
  cap_result: "kick_cap",
  task_result: "task",
  worker_reply_result: "worker_reply",
  worker_result: "resume_worker",
  stop_result: "stop_cap",
  status_result: "status",
  hello_result: "hello",
  update_result: "update_server",
};

/** config.servers に無い、発見ベースの要求に使う内部 slot の名前。list / connectAll には出さない。 */
const DISCOVERY_SLOT = "(discovery)";

/** 識別を取れなかった peer（hello が届かない）を再試行するまでの間隔。 */
export const IDENTIFY_RETRY_MS = 60_000;
/** 同じ server_id を名乗る peer の生存確認（hello）を、同じ顔ぶれに対してやり直す最小の間隔。 */
export const DUP_RECHECK_MS = 30_000;
/** 識別の取得（hello）の返信待ち。 */
export const IDENTIFY_TIMEOUT_MS = 3_000;

/**
 * sel に一致する peer。server_id → peer id → host 名（server が名乗った host、無ければ messenger の hostname）→ 名前、の順で
 * 最初に 1 件以上一致した段の全件を返す（複数 = 曖昧）。
 */
export function matchServerPeers(peers: ServerPeer[], sel: string): ServerPeer[] {
  const tiers: Array<(p: ServerPeer) => boolean> = [
    (p) => p.server_id === sel,
    (p) => p.id === sel,
    (p) => hostOf({ host: p.host, hostname: p.hostname })?.toLowerCase() === sel.toLowerCase(),
    (p) => p.name === sel,
  ];
  for (const t of tiers) {
    const hit = peers.filter(t);
    if (hit.length > 0) return hit;
  }
  return [];
}

/** peer と同じ server_id を名乗る peer（peer 自身を含む）。server_id が無ければ peer だけ。 */
const sameServerIdPeers = (peers: ServerPeer[], peer: ServerPeer): ServerPeer[] =>
  peer.server_id === undefined ? [peer] : peers.filter((p) => p.server_id === peer.server_id);

/** 候補の 1 行（識別があれば host(server_id) user= workspace=、無ければ従来の name(peer id)）。 */
const peerLabel = (p: ServerPeer): string =>
  p.server_id !== undefined || p.host !== undefined ? describeServer({ ...p, peerId: p.id }) : `${p.name}(${p.id})`;

/** version 不一致時に messenger が text 先頭へ付ける警告行（JSON を壊すので除く）。 */
const WARNING_LINE = /^\[agent-messenger warning\][^\n]*\n?/;

/** text 先頭の messenger 警告行を取り除く。 */
export function stripWarning(text: string): string {
  let t = text;
  while (WARNING_LINE.test(t)) t = t.replace(WARNING_LINE, "");
  return t;
}

const errorReply = (message: string, command?: ServerCommandType, extra: { code?: ErrorCode; retryable?: boolean } = {}): ErrorReply => ({
  bantou: PROTOCOL_VERSION,
  type: "error",
  ok: false,
  message,
  ...(command ? { command } : {}),
  ...(extra.code ? { code: extra.code } : {}),
  ...(extra.retryable !== undefined ? { retryable: extra.retryable } : {}),
});

/** protocol の版が合わない server への指示を断る error。 */
export function versionMismatchError(declared: string | undefined, command: ServerCommandType): ErrorReply {
  return errorReply(
    `server の protocol の版が合わない（server=${declared ?? "不明"}, center=${MESSENGER_PROTOCOL.version}）。版が揃うまで指示を送らない。server の更新後に再送`,
    command,
    { code: "version_mismatch", retryable: true },
  );
}

/**
 * 実 client を作る。普通の agent-messenger client として、通常の解決
 * （env → config → UDP 発見 → ローカル fallback）で broker につなぐ。broker の URL は指名しない。
 * 解決結果は messenger のログ（broker=... via ...）に出る。
 */
export function createClient(s: ServerConfig, log: Logger): LinkClient {
  return createMessengerClient({
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
  /** broker への到達確認（既定は接続を確保できるか）。 */
  healthCheck?: (server: ServerConfig) => Promise<boolean>;
  /** peer id の変化を見る間隔（既定 5 秒）。 */
  peerWatchMs?: number;
  /** identify の hello の返信待ち（既定 IDENTIFY_TIMEOUT_MS）。 */
  identifyTimeoutMs?: number;
  /** 現在時刻（ms）。テスト用。 */
  now?: () => number;
  /** server からの通知（activity）。返信ではないので pending とは照合しない。 */
  onNotice?: (n: ServerNotice, fromId?: string) => void;
  /**
   * 待ちの無い cap_result / task_result / kick_cap・task の error（report 起因の再開の結果など、最初の返信の後に server が送ってくるもの）。
   * 対応する待ちが無い返信を捨てずに渡す。
   */
  onLateCapReply?: (r: CapResultReply | TaskResultReply | ErrorReply, fromId?: string) => void;
}): ServerLink {
  const { config, log } = opts;
  let extraGate: Gate | undefined;
  const clientFactory = opts.clientFactory ?? ((s: ServerConfig): LinkClient => createClient(s, log));
  const healthCheck =
    opts.healthCheck ??
    (async (s: ServerConfig): Promise<boolean> => {
      await ensure(slotOf(s.name));
      return true;
    });

  let closed = false;
  const slots = new Map<string, Slot>();
  for (const s of config.servers.length > 0 ? config.servers : [{ name: DISCOVERY_SLOT, timeoutMs: DEFAULT_SERVER_TIMEOUT_MS } as ServerConfig]) {
    slots.set(s.name, { cfg: s, client: null, unsubscribe: null, connected: false, peerId: null, connecting: null, pending: [], chains: new Map(), serverId: null, serverPeer: null, identity: {} });
  }
  const slotOf = (name: string): Slot => {
    const s = slots.get(name);
    if (!s) throw new Error(`未定義の server: ${name}`);
    return s;
  };

  /** peer id → 学習済みの識別（メモリのみ）。hello_result / status_result の返信と、identify の hello で埋まる。 */
  const identities = new Map<string, ServerIdentity>();
  /** 識別の取得に失敗した時刻（peer id → ms）。IDENTIFY_RETRY_MS の間は再送しない。 */
  const identifyFailedAt = new Map<string, number>();
  /** 直近の発見で居た peer id。同じ server_id を名乗る別の peer が今も居る間は、識別を捨てない（捨てると互いに取り直して揺れる）。 */
  let liveIds = new Set<string>();
  const identifyTimeoutMs = opts.identifyTimeoutMs ?? IDENTIFY_TIMEOUT_MS;
  const nowMs = opts.now ?? Date.now;

  /** 返信から peer の識別を学ぶ。同じ server_id の別の peer id（再登録前の旧 id）の記録は整理する。 */
  const learnIdentity = (peerId: string, r: ServerIdentity): void => {
    const ident = identityOfReply(r);
    if (ident.server_id !== undefined) {
      for (const [other, v] of [...identities]) {
        if (other !== peerId && v.server_id === ident.server_id && !liveIds.has(other)) {
          identities.delete(other);
          log(`旧 peer id の識別を整理: server_id=${ident.server_id} ${other} -> ${peerId}`);
        }
      }
    }
    // 識別の無い返信（旧 server・一部だけ載せる返信）で、学習済みの識別を消さない
    if (Object.keys(ident).length > 0 || !identities.has(peerId)) identities.set(peerId, ident);
    identifyFailedAt.delete(peerId);
    // この peer が link の直近の送信先なら、list 用に slot 側へも写す（識別の無い返信では消さない）
    if (Object.keys(ident).length > 0) for (const slot of slots.values()) if (slot.serverPeer === peerId) slot.identity = ident;
  };

  /** 発見ベースの要求に使う slot。config.servers があれば先頭の client を共有し、無ければ内部 slot を使う。 */
  const discoveryName = config.servers[0]?.name ?? DISCOVERY_SLOT;
  const isConfigured = (slot: Slot): boolean => slot.cfg.name !== DISCOVERY_SLOT;
  const peerTarget = (peer: ServerPeer): Target => ({
    to: peer.id,
    meta: { protocol: MESSENGER_PROTOCOL.protocol, version: peer.version ?? MESSENGER_PROTOCOL.version },
    ...(peer.version ? { declared: peer.version } : {}),
    peerId: peer.id,
  });

  /** 門。制御メッセージは通す。宣言された protocol の版が違えば断り、次に更新待ちの判定。版が不明（名前宛て）は通す。 */
  const gateOf = (peer: { id: string; version?: string }, command: ServerCommandType): ErrorReply | undefined => {
    if (CONTROL_COMMANDS.includes(command)) return undefined;
    if (peer.version !== undefined && peer.version !== MESSENGER_PROTOCOL.version) return versionMismatchError(peer.version, command);
    return extraGate?.(peer, command);
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
    // hello / update_server は送り先の peer id が key。その peer からの返信は server の返信として受ける
    (m.from_id !== undefined && slot.pending.some((p) => (p.kind === "hello_result" || p.kind === "update_result") && p.key === m.from_id)) ||
    m.meta?.protocol === MESSENGER_PROTOCOL.protocol ||
    m.from_name === SERVER_NAME ||
    (slot.cfg.peer !== undefined && (m.from_name === slot.cfg.peer || m.from_id === slot.cfg.peer));

  const onInbound = (slot: Slot, m: LinkInbound): void => {
    if (m.mode === "ping") return;
    const body = stripWarning(m.text);
    const notice = parseServerNotice(body);
    if (notice && fromServer(slot, m)) {
      try {
        opts.onNotice?.(notice, m.from_id);
      } catch (e) {
        log(`通知の処理に失敗: server=${slot.cfg.name} type=${notice.type} ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
    const r = parseServerReply(body);
    if (!r || !fromServer(slot, m)) {
      log(`無視: server=${slot.cfg.name} from=${m.from_name} text=${m.text.replace(/\s+/g, " ").slice(0, 120)}`);
      return;
    }
    if ((r.type === "hello_result" || r.type === "status_result") && m.from_id !== undefined) learnIdentity(m.from_id, r);
    // hello を知らない旧 server の error: 識別なしとして扱う（再送しない）
    else if (r.type === "error" && r.command === "hello" && m.from_id !== undefined) learnIdentity(m.from_id, {});
    let target: Pending | undefined;
    if (r.type === "cap_result") {
      target = slot.pending.find((p) => p.kind === "cap_result" && p.key === r.cap_id);
    } else if (r.type === "task_result") {
      target = slot.pending.find((p) => p.kind === "task_result" && p.key === r.cap_id && p.taskId === r.task_id);
    } else if (r.type === "worker_reply_result") {
      target = slot.pending.find((p) => p.kind === "worker_reply_result" && p.key === `${r.cap_id}:${r.worker_id}`);
    } else if (r.type === "worker_result") {
      target = slot.pending.find((p) => p.kind === "worker_result" && p.key === r.worker_id);
    } else if (r.type === "stop_result") {
      target = slot.pending.find((p) => p.kind === "stop_result" && p.key === r.cap_id);
    } else if (r.type === "status_result") {
      target = slot.pending.find((p) => p.kind === "status_result");
    } else if (r.type === "hello_result" || r.type === "update_result") {
      // 複数 server へ同時に送るので、送り先の peer id（from_id）で照合する
      target = slot.pending.find((p) => p.kind === r.type && (m.from_id === undefined || p.key === m.from_id));
    } else if (r.command === "hello" || r.command === "update_server") {
      target = slot.pending.find((p) => p.command === r.command && (m.from_id === undefined || p.key === m.from_id));
    } else if (r.command === "stop_cap" && r.cap_id !== undefined) {
      // stop_cap の error は、同じ cap_id の kick_cap の待ちと取り違えない
      target = slot.pending.find((p) => p.kind === "stop_result" && p.key === r.cap_id);
    } else if (r.command === "task") {
      // task の error は task_id（無ければ cap_id）で照合する
      target = slot.pending.find((p) => p.kind === "task_result" && (r.cap_id === undefined || p.key === r.cap_id) && (r.task_id === undefined || p.taskId === r.task_id));
    } else if (r.command === "worker_reply") {
      target = slot.pending.find((p) => p.kind === "worker_reply_result" && (r.cap_id === undefined || r.worker_id === undefined || p.key === `${r.cap_id}:${r.worker_id}`));
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
      if (r.type === "cap_result" || r.type === "task_result" || (r.type === "error" && (r.command === "kick_cap" || r.command === "task") && r.cap_id !== undefined)) {
        try {
          opts.onLateCapReply?.(r, m.from_id);
        } catch (e) {
          log(`遅れた返信の処理に失敗: server=${slot.cfg.name} ${e instanceof Error ? e.message : String(e)}`);
        }
      }
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
    log(`server 接続: ${slot.cfg.name} peer=${client.peer?.id ?? "?"}`);
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
      slot.identity = {};
      return { to: slot.cfg.peer, meta };
    }
    if (client.listPeers) {
      try {
        const peers = await client.listPeers("all", { protocol: MESSENGER_PROTOCOL.protocol });
        const pick = peers.find((p) => p.name === SERVER_NAME) ?? peers[0];
        if (pick) {
          if (peers.length > 1) log(`bantou server が複数: server=${slot.cfg.name} ${peers.map((p) => peerLabel({ id: p.id, name: p.name, ...(identities.get(p.id) ?? {}), ...(p.hostname ? { hostname: p.hostname } : {}) })).join(",")} -> ${pick.name}(${pick.id})`);
          const v = pick.protocols?.find((p) => p.name === MESSENGER_PROTOCOL.protocol)?.version;
          slot.serverId = pick.id;
          // 送信先が別の peer に変わったら古い識別は捨てる（別 server に付けない）。同じ peer なら最後に学習したものを保つ
          if (slot.serverPeer !== pick.id) slot.identity = identities.get(pick.id) ?? {};
          slot.serverPeer = pick.id;
          return {
            to: pick.id,
            meta: { protocol: meta.protocol, version: v ?? meta.version },
            ...(v ? { declared: v } : {}),
            peerId: pick.id,
          };
        }
        log(`protocol 発見 0 件、名前宛てにフォールバック: server=${slot.cfg.name}`);
      } catch (e) {
        log(`protocol 発見失敗、名前宛てにフォールバック: server=${slot.cfg.name} ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    slot.serverId = null;
    slot.serverPeer = SERVER_NAME;
    slot.identity = {};
    return { to: SERVER_NAME, meta };
  };

  /** 同じ key の指示を直列化し、返信（またはタイムアウト）まで待つ。 */
  const request = <R>(
    server: string,
    kind: ReplyKind,
    key: string | undefined,
    payload: object,
    opts: { target?: Target; timeoutMs?: number; taskId?: string } = {},
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
      const target = opts.target ?? (await resolveTarget(slot, client));
      if (closed) return errorReply("center 終了", command);
      // 版の門: protocol の版が合わない server、更新待ちの server へは送らない（hello / update_server は別）
      const blocked = gateOf({ id: target.peerId ?? target.to, ...(target.declared ? { version: target.declared } : {}) }, command);
      if (blocked) {
        log(`指示を送らない: server=${server} to=${target.to} type=${command} ${blocked.code ?? ""} ${blocked.message}`);
        return blocked;
      }
      return new Promise<R | ErrorReply>((resolve) => {
        const timeoutMs = opts.timeoutMs ?? slot.cfg.timeoutMs;
        const p: Pending = {
          kind,
          command,
          key,
          ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
          resolve: resolve as (r: unknown) => void,
          timer: setTimeout(() => {
            log(`タイムアウト: server=${server} type=${command}${key ? ` id=${key}` : ""}`);
            settle(slot, p, errorReply(`タイムアウト (${timeoutMs}ms)`, command));
          }, timeoutMs),
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

  const discoverPeers = async (): Promise<ServerPeer[]> => {
    let client: LinkClient;
    try {
      client = await ensure(slotOf(discoveryName));
    } catch (e) {
      throw new Error(`messenger に接続できない: ${(e as Error).message}`);
    }
    if (!client.listPeers) return [];
    const peers = await client.listPeers("all", { protocol: MESSENGER_PROTOCOL.protocol });
    // 発見できなくなった peer（旧 peer id を含む）の識別は捨てる。到達先のキャッシュを残さない
    const listed = new Set(peers.map((p) => p.id));
    liveIds = listed;
    for (const id of [...identities.keys()]) {
      if (!listed.has(id)) {
        identities.delete(id);
        identifyFailedAt.delete(id);
      }
    }
    return peers.map((p) => {
      const version = p.protocols?.find((x) => x.name === MESSENGER_PROTOCOL.protocol)?.version;
      return {
        id: p.id,
        name: p.name,
        ...(p.summary ? { summary: p.summary } : {}),
        ...(p.hostname ? { hostname: p.hostname } : {}),
        ...(version ? { version } : {}),
        ...(identities.get(p.id) ?? {}),
      };
    });
  };

  /** 識別が未取得の peer へ hello を送って取得する（並列）。返信は onInbound が学習する。届かない peer は IDENTIFY_RETRY_MS 後に再試行。 */
  const identify = async (peers: ServerPeer[]): Promise<ServerPeer[]> => {
    const todo = peers.filter((p) => !identities.has(p.id) && nowMs() - (identifyFailedAt.get(p.id) ?? -Infinity) >= IDENTIFY_RETRY_MS);
    if (todo.length === 0) return peers;
    await Promise.all(
      todo.map(async (p) => {
        const reply = await request<HelloResultReply>(discoveryName, "hello_result", p.id, {}, { target: peerTarget(p), timeoutMs: identifyTimeoutMs });
        if (identities.has(p.id)) return; // 返信は onInbound が学習済み（hello_result、または hello を知らない旧 server の error = 識別なし）
        identifyFailedAt.set(p.id, nowMs());
        log(`server の識別を取れない（hello が届かない）: ${p.name}(${p.id}) ${reply.type === "error" ? reply.message : ""}`);
      }),
    );
    return peers.map((p) => ({ ...p, ...(identities.get(p.id) ?? {}) }));
  };
  /**
   * 同じ server_id を名乗る peer が複数いる時、その全員へ hello を送り直し、応答した peer だけを残す。
   * server が再起動・再登録すると、死んだ旧 peer id が発見に残る間（messenger 側の失効待ち）、新旧が同じ server_id を名乗る。
   * 旧 peer は hello に答えず落ちるので、新 peer だけが残り、重複エラーにならない。全員が応答した時だけ重複（本当のコピー）として残す。
   * 誰も応答しなければ何も落とさない（生きている peer が分からない）。同じ顔ぶれへの再確認は DUP_RECHECK_MS に 1 回まで、同時実行は 1 つにまとめる。
   */
  const dupChecks = new Map<string, { at: number; alive: Set<string> }>();
  const dupInflight = new Map<string, Promise<Set<string>>>();
  const aliveOnly = async (peers: ServerPeer[]): Promise<ServerPeer[]> => {
    const groups = new Map<string, ServerPeer[]>();
    for (const p of peers) if (p.server_id !== undefined) groups.set(p.server_id, [...(groups.get(p.server_id) ?? []), p]);
    const drop = new Set<string>();
    await Promise.all(
      [...groups.values()].filter((g) => g.length > 1).map(async (g) => {
        const key = g.map((p) => p.id).sort().join(",");
        const cached = dupChecks.get(key);
        let alive: Set<string>;
        if (cached && nowMs() - cached.at < DUP_RECHECK_MS) alive = cached.alive;
        else {
          let pr = dupInflight.get(key);
          if (!pr) {
            pr = (async () => {
              const rs = await Promise.all(
                g.map(async (p) => {
                  const r = await request<HelloResultReply>(discoveryName, "hello_result", p.id, {}, { target: peerTarget(p), timeoutMs: identifyTimeoutMs });
                  return r.type === "hello_result" ? p.id : undefined;
                }),
              );
              const a = new Set(rs.filter((x): x is string => x !== undefined));
              for (const [k, v] of dupChecks) if (nowMs() - v.at >= DUP_RECHECK_MS * 10) dupChecks.delete(k);
              // 誰も応答しなかった結果は保持しない（全員が一時的に無応答→復帰した時に、間隔の間エラーが残らない）
              if (a.size > 0) dupChecks.set(key, { at: nowMs(), alive: a });
              return a;
            })().finally(() => dupInflight.delete(key));
            dupInflight.set(key, pr);
          }
          alive = await pr;
        }
        if (alive.size === 0) return;
        for (const p of g) if (!alive.has(p.id)) drop.add(p.id);
      }),
    );
    if (drop.size > 0) log(`hello に答えない peer を除く（同じ server_id の旧 peer id）: ${[...drop].join(",")}`);
    return drop.size > 0 ? peers.filter((p) => !drop.has(p.id)) : peers;
  };
  const identifiedPeers = async (): Promise<ServerPeer[]> => aliveOnly(await identify(await discoverPeers()));

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
        [...slots.values()].filter(isConfigured).map((slot) =>
          ensure(slot).then(
            () => undefined,
            (e: unknown) => log(`server 接続失敗: ${slot.cfg.name} ${e instanceof Error ? e.message : String(e)}`),
          ),
        ),
      );
    },
    async list() {
      return Promise.all(
        [...slots.values()].filter(isConfigured).map(async (slot) => ({
          name: slot.cfg.name,
          connected: slot.connected,
          reachable: await healthCheck(slot.cfg).catch(() => false),
          peerId: slot.connected ? (slot.client?.peer?.id ?? null) : null,
          serverPeer: slot.serverPeer,
          ...slot.identity,
        })),
      );
    },
    kickCap: (server, cmd) => request<CapResultReply>(server, "cap_result", cmd.cap_id, cmd),
    resumeWorker: (server, cmd) => request<WorkerResultReply>(server, "worker_result", cmd.worker_id, cmd),
    status: (server) => request<StatusReply>(server, "status_result", undefined, {}),
    peers: discoverPeers,
    identifiedPeers,
    identityOf: (peerId) => identities.get(peerId),
    async selectPeer(sel) {
      let peers = await discoverPeers();
      if (peers.length === 0) throw new Error("protocol bantou の server が見つからない（server が起動・protocol 登録済みか、同じ broker につながっているか確認）");
      if (sel === undefined) {
        // 同じ server_id を名乗る peer の検知には識別が要る（2 つ以上居る時だけ取る。取得済みは再送しない）
        if (peers.length > 1) peers = await aliveOnly(await identify(peers));
        const dup = sameServerIdPeers(peers, peers[0]);
        if (dup.length > 1) throw new Error(duplicateServerIdMessage(dup[0].server_id!, dup.map((p) => ({ ...p, peerId: p.id }))));
        return peers[0];
      }
      let hits = matchServerPeers(peers, sel);
      // 一致しない、または識別が未取得の peer が混ざる時は、識別を取り直して引き直す（server_id での指定は識別が要る）
      if (hits.length === 0 || peers.some((p) => !identities.has(p.id) && hits.includes(p))) {
        peers = await identify(peers);
        hits = matchServerPeers(peers, sel);
      }
      // peer id の指定は常に通す（生存確認で除かれる旧 peer も、利用者が明示したなら指せる）
      const exact = peers.find((p) => p.id === sel);
      if (exact) return exact;
      // 同じ server_id を名乗る peer が複数いるなら、応答しない旧 peer を除いてから判定する
      peers = await aliveOnly(peers);
      hits = matchServerPeers(peers, sel);
      if (hits.length === 0) throw new Error(`server が見つからない: ${sel}（候補: ${peers.map(peerLabel).join(", ")}）`);
      // 同じ server_id を名乗る peer 同士の曖昧さは、見分けが付かない表示にならないよう peer id を添えて断る
      if (hits.length > 1 && hits[0].server_id !== undefined && hits.every((p) => p.server_id === hits[0].server_id)) {
        throw new Error(duplicateServerIdMessage(hits[0].server_id, hits.map((p) => ({ ...p, peerId: p.id }))));
      }
      if (hits.length > 1) throw new Error(ambiguousServerMessage(sel, hits.map((p) => ({ ...p, peerId: p.id }))));
      return hits[0];
    },
    kickCapOn: (peer, cmd) =>
      request<CapResultReply>(discoveryName, "cap_result", cmd.cap_id, cmd, { target: peerTarget(peer) }),
    taskOn: (peer, cmd) =>
      request<TaskResultReply>(discoveryName, "task_result", cmd.cap_id, cmd, { target: peerTarget(peer), taskId: cmd.task_id }),
    workerReplyOn: (peer, cmd) =>
      request<WorkerReplyResultReply>(discoveryName, "worker_reply_result", `${cmd.cap_id}:${cmd.worker_id}`, cmd, { target: peerTarget(peer), timeoutMs: FOLLOW_TIMEOUT_MS }),
    statusOn: (peer, opts) =>
      request<StatusReply>(discoveryName, "status_result", undefined, opts?.cap_id !== undefined ? { cap_id: opts.cap_id } : {}, { target: peerTarget(peer), timeoutMs: FOLLOW_TIMEOUT_MS }),
    stopCapOn: (peer, cmd) =>
      request<StopResultReply>(discoveryName, "stop_result", cmd.cap_id, cmd, { target: peerTarget(peer), timeoutMs: STOP_TIMEOUT_MS }),
    hello: (peer) =>
      request<HelloResultReply>(discoveryName, "hello_result", peer.id, {}, { target: peerTarget(peer), timeoutMs: FOLLOW_TIMEOUT_MS }),
    updateServer: (peer, version) =>
      request<UpdateResultReply>(discoveryName, "update_result", peer.id, { version }, { target: peerTarget(peer), timeoutMs: FOLLOW_TIMEOUT_MS }),
    async notifyPeer(name, text) {
      let client: LinkClient;
      try {
        client = await ensure(slotOf(discoveryName));
      } catch (e) {
        return { ok: false, reason: `messenger に接続できない: ${(e as Error).message}` };
      }
      if (!client.listPeers) return { ok: false, reason: "broker が peer の列挙に対応していない" };
      try {
        const own = client.peer?.id ?? null;
        const hits = (await client.listPeers("all")).filter((p) => p.name === name && p.id !== own);
        if (hits.length === 0) return { ok: false, reason: `messenger に peer ${name} がいない（session が agent-messenger につながっていない）` };
        // session の再起動直後は、止まった client の古い登録が heartbeat 失効（60 秒）まで残り同名が並ぶ。最後に登録した peer を選ぶ
        hits.sort((a, b) => (b.registered_at ?? "").localeCompare(a.registered_at ?? ""));
        if (hits.length > 1) log(`通知先の peer が複数: name=${name} ${hits.map((p) => p.id).join(",")} -> ${hits[0].id}（最新の登録）`);
        await client.send(hits[0].id, text, "push");
        return { ok: true, to: hits[0].id };
      } catch (e) {
        return { ok: false, reason: `送信失敗: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
    gate: (peer, command) => gateOf(peer, command),
    setGate: (g) => {
      extraGate = g;
    },
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
