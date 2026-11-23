import { randomBytes } from "node:crypto";
import { z } from "zod";
import { MODEL_PATTERN } from "@agent-hand/bantou-protocol";
import type { Logger } from "./log.js";
import type { ServerLink } from "./server-link.js";
import type { JsonListStore } from "./store.js";
import { capSessionName } from "./session-name.js";
import { serverAllowed } from "./project-settings.js";
import type { CenterMemoryEvents } from "./memory-events.js";
import type { WorkerTracker } from "./worker-ws.js";

/** remote の呼び出し元（master-cap の session 名）を運ぶ HTTP header。 */
export const OWNER_HEADER = "x-bantou-session";
/** header の代わりに URL query で渡す時の名前。 */
export const OWNER_QUERY = "session";

export const OWNER_PATTERN = /^[A-Za-z0-9_-]+$/;
/** remote_wait の既定・上限（秒）。 */
export const WAIT_DEFAULT_SEC = 600;
export const WAIT_MAX_SEC = 1800;
/** 集計の変化（running の件数）を見直す間隔（ms）。60 秒の無音で「止まっている」へ変わる時は、書き込みの event が無い。 */
export const SUMMARY_CHECK_MS = 5_000;

/** running = ws の最後の書き込みから 60 秒以内 / done = 止まっている（60 秒無音）。desktop の画面の値（running / done / failed / unknown）に合わせる。 */
export type RemoteState = "running" | "done";

/** session の集計に載せる 1 件（v2 では center が作らない。desktop の型を保つために残す）。 */
export interface RemoteIssue {
  server: string;
  remoteId: string;
  lastOkAt?: string | null;
  at?: string;
}
export interface RemoteStopIssue {
  server: string;
  remoteId: string;
  kind: "failed" | "no_result";
  at: string;
  taskId?: string;
  detail?: string;
}

/**
 * session ごとの remote の集計（session_list の `remote`）。running = ws が動いている cap の数。
 * waitingReply は常に 0（server からの質問は cap の名前に直接届き、center は受けない）。unreachable / lost / stopped は v2 の center は作らない。
 */
export interface RemoteSummary {
  running: number;
  waitingReply: number;
  unreachable?: RemoteIssue[];
  lost?: RemoteIssue[];
  stopped?: RemoteStopIssue[];
}

/** 控えの remote_id: parent-id（cap の名前）と server の名前の組 `<parent-id>@<server>`（session × server の 1 件で一意）。 */
export const remoteIdOf = (parentId: string, server: string): string => `${parentId}@${server}`;

/**
 * center が保持する控え。session × server ごとに 1 件。remote_id = `<parent-id>@<server>`（parent-id = cap の名前 = capSessionName(session)）。
 * メモリ + 状態ファイル。消すのは remote_stop だけ（再起動では消えない）。state と最後の書き込みの時刻は ws から出す（保存しない）。
 */
export interface RemoteRecord {
  remote_id: string;
  session: string;
  /** server の agent-messenger の名前（launch の宛先そのまま）。 */
  server: string;
  serverName: string;
  /** 最後の launch で渡したモデル。 */
  model?: string;
  createdAt: string;
}

/** remote_list が返す 1 件。desktop の画面に出す項目名は旧 1.x のまま。 */
export type RemoteView = RemoteRecord & {
  state: RemoteState;
  /** 止まっている（state=done）時だけ。ws の最後の書き込みの時刻（ISO）。 */
  finishedAt?: string;
  owners: string[];
  server_label: string;
};

const serverArg = z.string().min(1).describe("server の agent-messenger の名前（そのまま send の宛先になる）");

const noNul = (v: string): boolean => !v.includes("\0");
const noNulMsg = { message: "NUL 文字を含められない" };

/** remote_send の入力（remote_create も同じ）。 */
export const remoteSendSchema = {
  server: serverArg,
  model: z.string().regex(MODEL_PATTERN, "英数字と . _ [ ] - のみ（先頭は - 不可）").optional().describe("worker のモデル。省略すると launch に model を入れない（server は --model を付けない）"),
  prompt: z.string().min(1).refine(noNul, noNulMsg).describe("worker にさせる作業"),
};

/** remote_stop の入力。 */
export const remoteStopSchema = { server: serverArg };

/** worker_reply の入力（desktop の center_call と /mcp/session で共通）。 */
export const workerReplySchema = {
  server: serverArg,
  session_id: z.string().min(1).refine(noNul, noNulMsg).describe("返答先の worker の session-id（server から cap に届いた質問に付いている）"),
  order: z.enum(["answer", "approve", "reject"]).describe("answer = 質問への回答（content）/ approve = 承認 / reject = 却下"),
  content: z.string().refine(noNul, noNulMsg).optional().describe("answer の本文（approve / reject では使わない）"),
};

export const remoteWaitSchema = {
  remote_id: z.string().min(1).refine(noNul, noNulMsg).optional().describe("待つ cap（`<parent-id>@<server>`）。省略時は owner（session）の cap のどれか（最初に止まったもの）"),
  server: serverArg.optional().describe("cap のある server（絞り込み）"),
  timeout_sec: z.number().int().min(1).max(WAIT_MAX_SEC).optional().describe(`待つ秒数。既定 ${WAIT_DEFAULT_SEC}、上限 ${WAIT_MAX_SEC}。超えたら state=running のまま返す`),
};

/** 互換: remote_create の入力は remote_send と同じ。 */
export const remoteCreateSchema = remoteSendSchema;

export interface RemoteSendInput {
  owner: string;
  server: string;
  model?: string;
  prompt: string;
}

/** 返り値は送った事だけ（worker の結果・状態は ws から見る）。 */
export interface RemoteSendResult {
  remote_id: string;
  server: string;
  model?: string;
  sent: true;
}

export interface RemoteStopResult {
  remote_id: string;
  server: string;
  sent: true;
  /** center の控えを消したか（控えが無かった時は false）。 */
  forgotten: boolean;
}

export interface RemoteReplyInput {
  /** 呼び出し元 session（/mcp/session）。desktop の center_call（owner 無し）は省く = 使う server の範囲を見ない。 */
  owner?: string;
  server: string;
  session_id: string;
  order: "answer" | "approve" | "reject";
  content?: string;
}

export interface RemoteManager {
  /** 保存済みの控えを読み込む。remote_id が今の規約（`<parent-id>@<server>`）に合わない旧 1.x の控えは捨てる。 */
  restore(): Promise<void>;
  /** owner（session）の cap の名前を parent-id にして launch を送る。返り値は送った事だけ。 */
  send(input: RemoteSendInput): Promise<RemoteSendResult>;
  /** stop を送り、その cap の控えを消す。 */
  stop(input: { owner: string; server: string }): Promise<RemoteStopResult>;
  /** reply（answer / approve / reject）を送る。 */
  reply(input: RemoteReplyInput): Promise<{ server: string; session_id: string; order: string; sent: true }>;
  /**
   * owner を渡すと、その session の cap だけ。省くと全件。
   * owner の session に servers の範囲があれば、範囲外の server の cap（その session 自身の物）は既定で除く。includeOutOfScope: true で含める。
   */
  list(filter?: { owner?: string; includeOutOfScope?: boolean }): RemoteView[];
  /** owner の session の servers の範囲と、その範囲外になっている自分の cap の件数。範囲の指定が無ければ servers は undefined。 */
  scopeOf(owner: string): { servers: string[] | undefined; out_of_scope: number };
  /** session の remote 集計。 */
  summary(session: string): RemoteSummary;
  /**
   * session 名 name が remote の控えと衝突するか。衝突すれば理由、無ければ null。
   * create: parent-id（cap の名前）が capSessionName(name) の控えを別の session が持つ時。
   * rename（oldName = 改名元）: 改名元以外の session の控えで、session が name か parent-id が capSessionName(name) の物がある時。
   */
  conflictsWith(name: string, mode: "create" | "rename", oldName?: string): string | null;
  /** session の改名に合わせて控えを付け替える（session と、cap の名前を含む remote_id）。付け替えた件数を返す。 */
  renameSession(oldName: string, newName: string): Promise<number>;
  /**
   * cap の worker が止まる（ws の最後の書き込みから 60 秒無音）まで待って返す。remote_id・server 省略時は owner の cap のどれかが止まるまで。
   * timeout なら state=running のまま返す。
   */
  wait(input: { remote_id?: string; server?: string; owner?: string; timeoutSec?: number }): Promise<RemoteView>;
  /** 周期の確認を止める。 */
  close(): void;
}

export function createRemoteManager(opts: {
  link: ServerLink;
  store: JsonListStore<RemoteRecord>;
  log: Logger;
  tracker: WorkerTracker;
  /** launch の `ws`（center の ws の宛先）。決まらない（bind が loopback で publicHost が無い等）時は undefined。 */
  wsUrl: () => string | undefined;
  /** session が使ってよい server の指定（server の名前）。undefined = 全部。呼ぶたびに引くので、設定の更新はすぐ効く。 */
  serversOf?: (owner: string) => string[] | undefined;
  /** 外部記憶への書き込み（launch の送信・reply の送信）。省略時は何もしない。 */
  memoryEvents?: Pick<CenterMemoryEvents, "task" | "reply">;
  /** session の remote 集計（RemoteSummary）が変わった時に呼ぶ。desktop への SSE 通知に使う。 */
  onSummaryChange?: (session: string) => void;
  /** 現在時刻（ms）。テスト用。 */
  now?: () => number;
  /** 集計の見直しの間隔（ms）。0 = 周期なし。既定 SUMMARY_CHECK_MS。 */
  summaryCheckMs?: number;
}): RemoteManager {
  const { link, store, log, tracker } = opts;
  const nowMs = opts.now ?? Date.now;
  const records: RemoteRecord[] = [];
  const waiters = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const persist = (): Promise<void> => {
    emitSummaryChanges();
    return store.save(records).catch((e: unknown) => log(`remotes 保存失敗: ${e instanceof Error ? e.message : String(e)}`));
  };

  /** 控えの parent-id（cap の名前）。ws の書き込みはこの名前で届く。 */
  const parentOf = (r: RemoteRecord): string => capSessionName(r.session);
  const stateOf = (r: RemoteRecord): RemoteState => (tracker.stateOf(parentOf(r)) === "running" ? "running" : "done");

  const viewOf = (r: RemoteRecord): RemoteView => {
    const state = stateOf(r);
    const last = tracker.lastAt(parentOf(r));
    return {
      ...r,
      state,
      ...(state === "done" && last !== undefined ? { finishedAt: new Date(last).toISOString() } : {}),
      owners: [r.session],
      server_label: r.server,
    };
  };

  const summarize = (session: string): RemoteSummary => ({ running: records.filter((r) => r.session === session && stateOf(r) === "running").length, waitingReply: 0 });

  /** 通知済みの集計（メモリのみ。session → running の件数）。 */
  const notified = new Map<string, number>();
  const emitSummaryChanges = (): void => {
    const sessions = new Set<string>(notified.keys());
    for (const r of records) sessions.add(r.session);
    for (const s of sessions) {
      const n = summarize(s).running;
      const prev = notified.get(s) ?? 0;
      if (n === 0) notified.delete(s);
      else notified.set(s, n);
      if (n !== prev) opts.onSummaryChange?.(s);
    }
  };

  const wake = (): void => {
    emitSummaryChanges();
    for (const w of [...waiters]) w();
  };
  tracker.onChange(() => wake());

  const inRange = (server: string, allowed: string[] | undefined): boolean => serverAllowed(allowed, { host: server });
  const notInServers = (what: string, allowed: string[], owner: string): string =>
    `この session の servers に無い: ${what}（session=${owner}, servers=[${allowed.join(", ")}]${allowed.length === 0 ? "。空 = どの server も使わない" : ""}）`;

  const checkOwner = (owner: string): void => {
    if (!OWNER_PATTERN.test(owner)) throw new Error("owner は英数字と _ - のみ");
  };
  const checkServer = (server: string): void => {
    if (server.length === 0 || server.includes("\0")) throw new Error("server が不正（空・NUL 文字は不可）");
  };
  const checkScope = (owner: string, server: string): void => {
    const allowed = opts.serversOf?.(owner);
    if (allowed !== undefined && !inRange(server, allowed)) throw new Error(notInServers(server, allowed, owner));
  };

  const find = (session: string, server: string): RemoteRecord | undefined => records.find((r) => r.session === session && r.server === server);

  /** launch ごとの控え用の id（外部記憶の task event の識別。protocol には出ない）。 */
  const newLaunchId = (): string => `l-${nowMs().toString(36)}-${randomBytes(3).toString("hex")}`;

  return {
    async restore() {
      records.length = 0;
      let dropped = 0;
      for (const r of await store.load()) {
        const ok =
          typeof r?.remote_id === "string" &&
          typeof r.session === "string" &&
          OWNER_PATTERN.test(r.session) &&
          typeof r.server === "string" &&
          r.server.length > 0 &&
          r.remote_id === remoteIdOf(capSessionName(r.session), r.server);
        if (!ok) {
          dropped++;
          continue;
        }
        records.push({
          remote_id: r.remote_id,
          session: r.session,
          server: r.server,
          serverName: r.server,
          ...(typeof r.model === "string" ? { model: r.model } : {}),
          createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date(nowMs()).toISOString(),
        });
      }
      log(`remote の控えを読込: ${records.length} 件${dropped > 0 ? `（旧 1.x の形式の ${dropped} 件は捨てた）` : ""}`);
      if (dropped > 0) await persist();
      const every = opts.summaryCheckMs ?? SUMMARY_CHECK_MS;
      if (timer === undefined && every > 0) {
        timer = setInterval(() => wake(), every);
        timer.unref?.();
      }
    },

    async send(input) {
      checkOwner(input.owner);
      checkServer(input.server);
      if (input.prompt.length === 0 || input.prompt.includes("\0")) throw new Error("prompt が不正（空・NUL 文字は不可）");
      const model = input.model;
      if (model !== undefined && !MODEL_PATTERN.test(model)) throw new Error("model が不正: 英数字と . _ [ ] - のみ（先頭は - 不可）");
      checkScope(input.owner, input.server);
      const ws = opts.wsUrl();
      if (ws === undefined) throw new Error("launch を送れない: center の ws の宛先が決まらない（bind が loopback で、config の publicHost が無い。server から届く宛先を publicHost に書く）");
      const parentId = capSessionName(input.owner);
      await link.launch(input.server, { parentId, ...(model !== undefined ? { model } : {}), prompt: input.prompt, ws });
      let rec = find(input.owner, input.server);
      if (!rec) {
        rec = { remote_id: remoteIdOf(parentId, input.server), session: input.owner, server: input.server, serverName: input.server, ...(model !== undefined ? { model } : {}), createdAt: new Date(nowMs()).toISOString() };
        records.push(rec);
      } else {
        rec.remote_id = remoteIdOf(parentId, input.server);
        if (model !== undefined) rec.model = model;
        else delete rec.model;
      }
      await persist();
      wake();
      opts.memoryEvents?.task(input.owner, { capId: parentId, taskId: newLaunchId(), goal: input.prompt });
      log(`remote launch: parent-id=${parentId} server=${input.server} model=${model ?? "(指定なし)"}`);
      return { remote_id: remoteIdOf(parentId, input.server), server: input.server, ...(model !== undefined ? { model } : {}), sent: true };
    },

    async stop({ owner, server }) {
      checkOwner(owner);
      checkServer(server);
      const rec = find(owner, server);
      const parentId = capSessionName(owner);
      await link.stop(server, parentId);
      let forgotten = false;
      if (rec) {
        records.splice(records.indexOf(rec), 1);
        forgotten = true;
        // 同じ cap の名前（同じ session）で他の server の控えが残っていなければ、ws の記録も消す
        if (!records.some((r) => parentOf(r) === parentId)) tracker.forget(parentId);
        await persist();
      }
      wake();
      log(`remote stop: parent-id=${parentId} server=${server} forgotten=${forgotten}`);
      return { remote_id: remoteIdOf(parentId, server), server, sent: true, forgotten };
    },

    async reply({ owner, server, session_id, order, content }) {
      if (owner !== undefined) checkOwner(owner);
      checkServer(server);
      if (session_id.length === 0 || session_id.includes("\0")) throw new Error("session_id が不正（空・NUL 文字は不可）");
      if (content !== undefined && content.includes("\0")) throw new Error("content が不正（NUL 文字は不可）");
      if (owner !== undefined) checkScope(owner, server);
      await link.reply(server, { sessionId: session_id, order, ...(content !== undefined ? { content } : {}) });
      if (owner !== undefined) {
        const rec = find(owner, server);
        opts.memoryEvents?.reply(owner, { capId: rec?.remote_id ?? remoteIdOf(capSessionName(owner), server), workerId: session_id, text: order === "answer" ? (content ?? "") : order });
      }
      log(`remote reply: server=${server} session-id=${session_id} order=${order}`);
      return { server, session_id, order, sent: true };
    },

    conflictsWith(name, mode, oldName) {
      const cid = capSessionName(name);
      for (const r of records) {
        if (mode === "create") {
          if (parentOf(r) === cid && r.session !== name) return `name の cap の名前（${cid}）を別の session（${r.session}）の remote の控えが持っている。remote_stop で消すまで再利用できない: ${name}`;
        } else if (r.session !== oldName && (r.session === name || parentOf(r) === cid)) {
          return `name に remote の控えが残っている（${r.remote_id} session=${r.session}）。remote_stop で消すまで再利用できない: ${name}`;
        }
      }
      return null;
    },

    async renameSession(oldName, newName) {
      let n = 0;
      for (const r of records) {
        if (r.session !== oldName) continue;
        r.session = newName;
        r.remote_id = remoteIdOf(capSessionName(newName), r.server);
        n++;
      }
      if (n > 0) await persist();
      log(`remote の session を付け替えた: ${oldName} -> ${newName} (控え ${n} 件)`);
      return n;
    },

    summary: summarize,

    list: (filter) => {
      const allowed = filter?.owner !== undefined && filter.includeOutOfScope !== true ? opts.serversOf?.(filter.owner) : undefined;
      return records
        .filter((r) => filter?.owner === undefined || r.session === filter.owner)
        .filter((r) => allowed === undefined || r.session !== filter?.owner || inRange(r.server, allowed))
        .map(viewOf);
    },

    scopeOf: (owner) => {
      const servers = opts.serversOf?.(owner);
      return { servers, out_of_scope: servers === undefined ? 0 : records.filter((r) => r.session === owner && !inRange(r.server, servers)).length };
    },

    async wait({ remote_id, server, owner, timeoutSec }) {
      const sec = Math.min(Math.max(timeoutSec ?? WAIT_DEFAULT_SEC, 1), WAIT_MAX_SEC);
      let targets = records.filter((r) => (owner === undefined || r.session === owner) && (remote_id === undefined || r.remote_id === remote_id) && (server === undefined || r.server === server));
      if (remote_id === undefined && server === undefined && owner === undefined) throw new Error("remote_id を省略するには owner（session）が必要");
      if (targets.length === 0) throw new Error(`待つ remote が無い${remote_id !== undefined ? `: ${remote_id}` : ""}`);
      targets = [...targets];
      const has = (t: RemoteRecord): boolean => records.includes(t);
      const check = (): RemoteView | undefined => {
        for (const t of targets) if (has(t) && stateOf(t) === "done") return viewOf(t);
        return undefined;
      };
      const deadline = nowMs() + sec * 1000;
      for (;;) {
        const hit = check();
        if (hit) return hit;
        const alive = targets.filter(has);
        if (alive.length === 0) throw new Error("待っていた remote が止められた");
        const left = deadline - nowMs();
        if (left <= 0) return viewOf(alive[0]!);
        // 次に「止まっている」へ変わる時刻（最後の書き込み + 無音の長さ）か、書き込み・控えの変化か、timeout の早い方まで待つ
        const nextStop = Math.min(...alive.map((t) => (tracker.lastAt(parentOf(t)) ?? nowMs()) + tracker.silentMs - nowMs()));
        const waitMs = Math.max(10, Math.min(left, nextStop + 10));
        await new Promise<void>((resolve) => {
          const t = setTimeout(done, waitMs);
          const w = (): void => done();
          function done(): void {
            clearTimeout(t);
            waiters.delete(w);
            resolve();
          }
          waiters.add(w);
        });
      }
    },

    close() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
