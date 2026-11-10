import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  AGENT_ID_PATTERN,
  MODEL_PATTERN,
  type CapResultReply,
  type ErrorReply,
  type StatusReply,
  type TaskCommand,
  type TaskResultReply,
  type WorkerReportNotice,
} from "@agent-hand/bantou-protocol";
import type { ActivityStore, RemoteActivity } from "./activity.js";
import { loadConfigSync, type ServerConfig } from "./config.js";
import type { Logger } from "./log.js";
import { matchServerPeers, type ServerLink, type ServerPeer, type TaskInput } from "./server-link.js";
import { ambiguousServerMessage, describeServer, duplicateServerIdMessage, hostOf, type ServerRef } from "./server-identity.js";
import type { JsonListStore } from "./store.js";
import { sessionCapId } from "./center-id.js";
import { serverAllowed } from "./project-settings.js";

/** remote の呼び出し元（master-cap の session 名）を運ぶ HTTP header。 */
export const OWNER_HEADER = "x-bantou-session";
/** header の代わりに URL query で渡す時の名前。 */
export const OWNER_QUERY = "session";

export const OWNER_PATTERN = /^[A-Za-z0-9_-]+$/;
/** 保存・返却する結果テキストの上限。 */
const RESULT_MAX = 8000;
/** 未完了の指示に残す prompt の先頭の長さ。 */
export const PROMPT_HEAD_MAX = 200;
/** 通知に載せる指示の先頭の長さ。 */
const NOTIFY_PROMPT_MAX = 80;
/** 記録・返却する worker_report の最大件数（到着順で、古いものから捨てる）。 */
export const WORKER_REPORTS_MAX = 20;
/** progress の push を同じ worker から間引く間隔（ms）。ask / approve / done は間引かない。 */
export const PROGRESS_THROTTLE_MS = 60_000;
/** push に載せる worker_report の本文の長さ。 */
export const NOTIFY_REPORT_MAX = 2000;

/** unknown = server に届かない・status も取れず、cap の状態が分からない（次に status が取れた時に running / done に戻る）。 */
export type RemoteState = "running" | "done" | "failed" | "unknown";

/** cap_result を受けた後、次の activity を待つ猶予（ms）。server の activity 通知は 5 秒ごとなので 3 回分。超えたら status で判定する。 */
export const SETTLE_GRACE_MS = 15_000;
/** status で追従する間隔（ms）。unknown の再試行・再起動後や cap 再開中の追従。 */
export const PROBE_POLL_MS = 15_000;

/**
 * 記録に保存する worker_report。replied_at = ask / approve に worker_reply を送った時刻（ISO。無ければ未返答）。
 * superseded_at = 返答なしで、同じ cap の同じ worker から progress 以外の後続の report が来て解消と見なした時刻（ISO）。
 */
export type StoredWorkerReport = WorkerReportNotice & { replied_at?: string; superseded_at?: string };

/** 返答待ちの ask / approve（返答済みでも解消済みでもない）。 */
const isOpenAsk = (w: StoredWorkerReport): boolean => (w.kind === "ask" || w.kind === "approve") && w.replied_at === undefined && w.superseded_at === undefined;

/** session ごとの remote の集計（session_list の `remote`）。 */
export interface RemoteSummary {
  /** その session の cap で、未完了の指示（pending）がある server の数。 */
  running: number;
  /** その session の cap の ask / approve で、worker_reply がまだ返っていない数（動いている cap のものだけ）。 */
  waitingReply: number;
}

/** 未完了の指示（完了したら消す）。通知先 = owner の session。 */
export interface PendingInstruction {
  /** 指示を送った時刻。 */
  at: string;
  /** 指示を送った session 名（完了の通知先）。 */
  owner: string;
  /** goal の先頭（PROMPT_HEAD_MAX 文字）。 */
  prompt: string;
  /** この指示で送った task の task_id。 */
  task_id?: string;
}

/**
 * center が保持する「server の cap」の記録。session × server ごとに 1 件、remote_id = cap_id（`c-<center-id>-<session 名>`）。
 * session が無い記録 = 引き継いだ旧共有 cap（`c-<center-id>` など。server ごとに 1 つを全 session で共有していた）。新しい指示は送らず、remote_delete で消せる。
 * メモリ + 状態ファイル。記録を消すのは remote_delete だけ（再起動では消えない）。
 */
export interface RemoteRecord {
  remote_id: string;
  /** この cap を持つ session（master-cap）の名前。無い = 引き継いだ旧共有 cap。 */
  session?: string;
  /**
   * server の識別。server_id が分かっていればそれ（server が再登録して peer id が変わっても同じ server と分かる）。
   * server_id が無い旧形式の記録（まだ hello を返す server と突き合わせられていない）は最後に使った peer id。区別は `server_id` の有無。
   */
  server: string;
  /** server が名乗った server_id（protocol 1.7.0 で追加され、現行 1.8.0 の server も名乗る）。旧形式の記録・旧 server では無い。 */
  server_id?: string;
  /** 今の到達先（最後に確認できた messenger の peer id）。再登録で変わるので都度更新する。長く確認できない時は消す（server_id は残る）。 */
  peer?: string;
  /** peer を最後に確認した時刻（ISO 8601）。 */
  peer_seen_at?: string;
  serverName: string;
  /** server が名乗った host 名（旧 server は messenger の hostname）。表示の主。 */
  serverHost?: string;
  serverUser?: string;
  serverWorkspace?: string;
  state: RemoteState;
  /** cap を作った時（最初の kick_cap）に渡したモデル。渡していなければ無い。 */
  model?: string;
  /** cap を作った時に渡した worker の既定モデル。 */
  worker_model?: string;
  createdAt: string;
  finishedAt?: string;
  /** 最新の task_result（または cap_result）の本文（task_result は summary）。 */
  result?: string;
  /** 最新の task_result 本体。 */
  task_result?: TaskResultReply;
  /** 直近の worker_report（最大 WORKER_REPORTS_MAX 件、到着順）。 */
  worker_reports?: StoredWorkerReport[];
  /** 最新の task_result（または cap_result）を受けた時刻。 */
  result_at?: string;
  /** 最新の失敗。成功の結果で消える。 */
  error?: string;
  /** 最新の失敗の時刻。 */
  error_at?: string;
  /** 未完了の指示（古い順）。完了したら消す。履歴は持たない。 */
  pending: PendingInstruction[];
}

/** remote_list が返す 1 件。通知がまだ無ければ activity は無い。 */
export type RemoteView = Omit<RemoteRecord, "worker_reports"> & {
  owners: string[];
  worker_reports: StoredWorkerReport[];
  activity?: RemoteActivity;
  /** 表示用の server。host 名を主にして server_id（無ければ peer id）を添える。同じ host 名の server が複数ある時は user と workspace も付く。 */
  server_label: string;
};

/** 通知に載せる result の先頭の長さ。 */
export const NOTIFY_RESULT_MAX = 500;
/** remote_wait の既定・上限（秒）。 */
export const WAIT_DEFAULT_SEC = 600;
export const WAIT_MAX_SEC = 1800;

const serverArg = z
  .string()
  .min(1)
  .optional()
  .describe("server の指定。server_id、host 名、peer id のどれでもよい（server_id → peer id → host 名 → messenger の名前の順に探す）。host 名が複数の server に一致する時は error（候補を user と workspace 付きで返す。server_id で指定し直す）。省略時は protocol bantou で発見した先頭");

export const remoteWaitSchema = {
  remote_id: z.string().regex(AGENT_ID_PATTERN, "英数字と _ - のみ").optional().describe("待つ cap。省略時は owner（session）の cap のうち未完了の指示があるもののどれか（最初に終わったもの）"),
  server: serverArg.describe("cap のある server（複数の server に同じ remote_id がある時の絞り込み）"),
  timeout_sec: z.number().int().min(1).max(WAIT_MAX_SEC).optional().describe(`待つ秒数。既定 ${WAIT_DEFAULT_SEC}、上限 ${WAIT_MAX_SEC}。超えたら state=running のまま返す`),
};

/** 通知の本文を作る。 */
export function formatDoneNotice(r: { remote_id: string; state: string; result?: string; error?: string; instructions?: string[] }): string {
  const head = r.result === undefined ? "" : r.result.length > NOTIFY_RESULT_MAX ? `${r.result.slice(0, NOTIFY_RESULT_MAX)}…(省略。全文は remote_list)` : r.result;
  return [
    `[bantou] remote 完了 remote_id=${r.remote_id} state=${r.state}`,
    ...(r.instructions?.length ? [`指示: ${r.instructions.map((p) => (p.length > NOTIFY_PROMPT_MAX ? `${p.slice(0, NOTIFY_PROMPT_MAX)}…` : p)).join(" / ")}`] : []),
    `result: ${head}`,
    ...(r.error ? [`error: ${r.error}`] : []),
  ].join("\n");
}

/** worker_report の push 本文を作る。 */
export function formatWorkerReportNotice(remoteId: string, n: WorkerReportNotice): string {
  const head = n.text.length > NOTIFY_REPORT_MAX ? `${n.text.slice(0, NOTIFY_REPORT_MAX)}…(省略。全文は remote_list の worker_reports)` : n.text;
  return [
    `[bantou] worker_report remote_id=${remoteId} worker=${n.worker_id} kind=${n.kind}${n.task_id ? ` task_id=${n.task_id}` : ""}`,
    head,
    ...(n.kind === "ask" || n.kind === "approve" ? [`返答: worker_reply(worker_id="${n.worker_id}", text)`] : []),
  ].join("\n");
}

/** center が採番する task_id（TASK_ID_PATTERN と同じ文字種）。 */
const newTaskId = (): string => `t-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;

const modelArg = (what: string) =>
  z.string().regex(MODEL_PATTERN, "英数字と . _ [ ] - のみ（先頭は - 不可）").optional().describe(what);
const noNul = (v: string): boolean => !v.includes("\0");
const noNulMsg = { message: "NUL 文字を含められない" };
const notDash = (v: string): boolean => !v.startsWith("-");
const plain = z.string().refine(noNul, noNulMsg);
const plainList = z.array(plain);
const agentIdArg = z.string().regex(AGENT_ID_PATTERN, "英数字と _ - のみ");
const branchArg = z.string().min(1).refine(notDash, { message: "- で始められない" }).refine(noNul, noNulMsg);

/** remote_send（別名 remote_create）の入力。worker_model の既定は config の servers[]（送信のたびに読み直す）。 */
export const remoteSendSchema = {
  goal: z.string().min(1).refine(noNul, noNulMsg).describe("server の remote-cap に渡す task の目的（自然言語）。他の項目を省けば goal だけで動く（分担は既定の implement + review の最低 2 体）"),
  repo: z.string().min(1).refine(noNul, noNulMsg).optional().describe("作業の元になる git URL"),
  branch: branchArg.optional().describe("作業の基点 branch"),
  deliverables: z
    .object({ branch: branchArg.optional(), report_path: plain.optional(), other: plainList.optional() })
    .optional()
    .describe("成果物。branch（worker が push する branch）/ report_path / other。省略時 {}"),
  verify: z.object({ tests: plainList.optional(), steps: plainList.optional() }).optional().describe("確認方法。tests（実行するテスト）/ steps（手順）。省略時 {}"),
  constraints: plainList.optional().describe("制約（1 件 1 要素）。省略時 []"),
  workers: z
    .object({
      items: z
        .array(
          z.object({
            id: agentIdArg.optional(),
            role: z.enum(["implement", "review", "docs", "test", "other"]),
            scope: z.string().min(1).refine(noNul, noNulMsg),
            model: z.string().regex(MODEL_PATTERN, "英数字と . _ [ ] - のみ（先頭は - 不可）").optional(),
            depends_on: z.array(agentIdArg).optional(),
          }),
        )
        .optional(),
    })
    .optional()
    .describe("worker の分担。items 無し = 既定（implement + review の最低 2 体）。省略時 {}"),
  server: serverArg,
  worker_model: modelArg("worker の既定モデル（task に載せる。items[].model が優先）。省略時、新規の cap は config servers[].workerModel、既存の cap は送らない（server の記憶のまま）"),
};
/** worker_reply の入力（desktop の center_call と /mcp/session で共通）。remote_id 省略時は記録が 1 件ならその cap。 */
export const workerReplySchema = {
  remote_id: z.string().regex(AGENT_ID_PATTERN, "英数字と _ - のみ").optional().describe("返答先の remote（cap）。省略時は呼び出し元 session の cap（server が複数なら server で絞る）。旧共有 cap へは remote_id で明示する"),
  worker_id: z.string().regex(AGENT_ID_PATTERN, "英数字と _ - のみ").describe("返答する worker（worker_report の worker_id）"),
  text: z.string().min(1).refine(noNul, noNulMsg).describe("worker への返答（ask への回答、approve の承認・却下など）"),
  server: serverArg.describe("remote_id が複数の server にある時の絞り込み"),
};

/** 互換: remote_create の入力は remote_send と同じ。 */
export const remoteCreateSchema = remoteSendSchema;

export interface RemoteSendResult {
  remote_id: string;
  /** server の識別（server_id。無い旧 server は peer id）。 */
  server: string;
  server_id?: string;
  /** 今の到達先（peer id）。 */
  peer: string;
  /** host 名（server が名乗ったもの、無ければ messenger の hostname）。 */
  host?: string;
  serverName: string;
  state: RemoteState;
  /** この指示で cap を作った（server に cap が無かった。最初の task で server が作る）。 */
  created: boolean;
  /** この指示の task_id（center が採番。task_result・worker_report と照合する）。 */
  task_id: string;
  worker_model?: string;
}

export interface RemoteSendInput {
  owner: string;
  goal: string;
  server?: string;
  repo?: string;
  branch?: string;
  deliverables?: TaskCommand["deliverables"];
  verify?: TaskCommand["verify"];
  constraints?: string[];
  workers?: TaskCommand["workers"];
  worker_model?: string;
}

export interface RemoteManager {
  /**
   * 保存済みの記録を読み込む。running と未完了の指示はそのまま復元し、server の status で cap と worker の状態を取り直して追従する
   * （取れなければ unknown。再起動後に届く cap_result は applyLateReply が反映する。messenger の peer 名が再起動前と同じ前提）。
   * あわせて、全ての記録の server へ status（cap_id 付き）を送り、server の通知先（activity / task_result / worker_report の送り先）を取り戻す
   * （server が居なければ再試行する。状態の追従で status を送る記録はそれが兼ねる）。
   * session の記録（session あり）はそのまま復元する。session の無い記録（旧共有 cap `c-<center-id>`・作業ごとの cap・history 形式など）は、session 無しの旧共有 cap として引き継ぐ（cap_id はそのまま。新しい指示は送らない。remote_delete で消せる）。
   * 旧共有 cap が同じ server に複数あれば、動いている記録（isActiveRec）を最優先、同順位なら最新の 1 件を残し、他は stop_cap を送って（届かなくても）記録を消す（作業ごとの cap の後始末。1 回限り。結果は center.log）。session の記録には触れない。
   */
  restore(): Promise<void>;
  /**
   * owner（session）の cap（remote_id = `c-<center-id>-<session>`）へ次の指示を送る。
   * server の status で cap の有無を確かめ（新規の cap の worker_model の既定は config の servers[]）、task を送る。task_id は center が採番。
   * 返信（task_result）は待たず、running で返る。cap が実行中なら server 側で直列に待たされる。
   */
  send(input: RemoteSendInput): Promise<RemoteSendResult>;
  /** worker_reply を server へ送る（owner を渡すとその session の cap だけが対象。remote_id 省略時は owner の cap）。版が合わない server へは送らず投げる。 */
  workerReply(input: { remote_id?: string; server?: string; worker_id: string; text: string; owner?: string }): Promise<{ remote_id: string; server: string; worker_id: string; accepted: true }>;
  /** server から worker_report を受けた時に呼ぶ。記録に積み、未完了の指示の owner へ push する（progress は同じ worker から 60 秒に 1 回）。 */
  onWorkerReport(report: WorkerReportNotice, fromId?: string): void;
  /** stop_cap を送って記録を外す。owner（session）を渡すと対象はその session の cap（と、remote_id で明示した旧共有 cap）だけ。remote_id 省略時は owner の cap（server が複数なら server で絞る）。 */
  delete(input: { remote_id?: string; server?: string; force?: boolean; owner?: string }): Promise<{ remote_id: string; deleted: true; stopped: boolean; warning?: string }>;
  /**
   * 最初の返信の後に server が送ってきた task_result / cap_result / error（task・kick_cap。report 起因の再開など）を記録に反映する。
   * 記録が無い（delete 済み・cap_kick の cap・旧形式）・まだ最初の返信待ちの時は何もしない。反映したら true。
   * fromId = 送ってきた server の peer id（同じ cap_id が複数 server にある時の取り違え防止）。
   */
  applyLateReply(reply: CapResultReply | TaskResultReply | ErrorReply, fromId?: string): boolean;
  /**
   * 古くなった記録の整理。消すのは center の記録だけで、server には何も送らない。
   * (1) 同じ server_id・同じ remote_id の重複（再登録前の旧 peer id の記録）は 1 件にまとめる（動いている記録、同順位なら最新を残す）。
   * (2) 長く確認できない到達先（peer）は消す（peer_seen_at から peerTtlMs 経過し、今の発見にも居ない）。server_id・host・cap の記録（session × server の対応）は残す。
   * 使われている記録（session × server の cap）そのものは消さない。消えるのは remote_delete だけ。
   */
  prune(): Promise<{ duplicates: number; peers: number }>;
  /**
   * 退役した server の記録を消す（server_retire が retire_result を受けた後）。server_id が一致する記録、server_id が無い旧形式は到達先（peer id）が一致する記録が対象。
   * 消すのは center の記録だけで server には何も送らない（server は止まっていく途中で、cap は server が止める）。消した件数と、その session 名を返す。
   */
  forgetServer(target: { server_id?: string; peerId?: string }): Promise<{ removed: number; sessions: string[] }>;
  /** owner を渡すと、その session の cap だけ（includeShared で旧共有 cap も）。省くと全件。 */
  list(filter?: { owner?: string; includeShared?: boolean }): RemoteView[];
  /** session の remote 集計。cap が無ければ 0 / 0。 */
  summary(session: string): RemoteSummary;
  /**
   * session 名 name が remote の記録と衝突するか。衝突すれば理由、無ければ null。
   * 別の session の記録と衝突する時だけ拒否する。
   * (a) create / rename: remote_id が c-<center-id>-<name> の記録があり、その session が name と違う（改名で旧名の cap_id を別名が持つ）。
   * rename は改名元（oldName）の session が持つ記録を衝突と見なさない（pm1 → pm2 の後に pm2 → pm1 へ戻せる）。
   * (b) rename のみ: session が name の記録がある（改名先 name は改名元と必ず違うので、それは別の session の記録 = 削除済み session の残り）。
   * 許す: create で session が name の記録（session_delete 後の同名の作り直し。旧 cap を続きとして引き継ぐ）。
   */
  conflictsWith(name: string, mode: "create" | "rename", oldName?: string): string | null;
  /**
   * session の改名に合わせて記録を付け替える（session === old → new、pending[].owner === old → new）。cap_id（remote_id）は変えない。
   * 付け替えた記録の件数を返す。0 件なら保存しない。
   */
  renameSession(oldName: string, newName: string): Promise<number>;
  /** server から activity 通知を受けた時に呼ぶ。cap が idle で worker も無くなったなら、未完了の指示を完了にして通知する・待ちを起こす。 */
  onActivity(capId: string, fromId?: string): void;
  /**
   * cap が終わる（list の state が done / failed = cap が idle で、配下の worker に running / stalled が無い）まで待って返す。
   * remote_id 省略時は owner の未完了の指示がある cap のどれかが終わるまで。timeout なら state=running のまま返す。
   */
  wait(input: { remote_id?: string; server?: string; owner?: string; timeoutSec?: number }): Promise<RemoteView>;
}

/** unknown にした時の error の接頭辞（回復時に消す印）。 */
const STATUS_ERR = "status を取れない";

/** 記録の最も新しい時刻（ISO 8601）。旧形式の引き継ぎで、動いている記録が同順位の時に最新を選ぶ判定に使う。 */
const lastAt = (r: RemoteRecord): string =>
  [r.createdAt, r.finishedAt, r.result_at, r.error_at].filter((t): t is string => typeof t === "string").sort().pop() ?? "";

/** 動いている記録（running・unknown・未完了の指示あり）。復元時に status で追従する対象で、旧形式の引き継ぎでも残す側を優先する。 */
const isActiveRec = (r: RemoteRecord): boolean => r.state === "running" || r.state === "unknown" || r.pending.length > 0;

/** 到達先（peer id）を最後に確認してから、これを超えて確認できず、発見にも居ない時に消す。 */
export const PEER_TTL_MS = 6 * 60 * 60_000;
/** peer_seen_at を保存し直す最小の間隔（確認のたびに書き込まない）。 */
const SEEN_PERSIST_MS = 10 * 60_000;

/** 記録の今の到達先（server_id の記録は peer、旧形式は server = 最後に使った peer id）。 */
export const peerOfRec = (r: RemoteRecord): string | undefined => (r.server_id !== undefined ? r.peer : (r.peer ?? r.server));

/** 記録が指す server を 1 つに決める key（server_id、無ければ到達先）。 */
const serverKeyOf = (r: RemoteRecord): string => r.server_id ?? peerOfRec(r) ?? r.server;

const refOf = (r: RemoteRecord): ServerRef => ({
  ...(r.server_id !== undefined ? { server_id: r.server_id } : {}),
  ...(peerOfRec(r) !== undefined ? { peerId: peerOfRec(r) } : {}),
  ...(r.serverHost ? { host: r.serverHost } : {}),
  ...(r.serverUser ? { user: r.serverUser } : {}),
  ...(r.serverWorkspace ? { workspace: r.serverWorkspace } : {}),
  name: r.serverName,
});

/** 通知先を server へ伝える status（cap_id 付き）の再試行の回数。pollMs ごと。 */
const ANNOUNCE_RETRIES = 20;

const truncate = (s: string): string => (s.length > RESULT_MAX ? `${s.slice(0, RESULT_MAX)}…(省略)` : s);

/** 未完了の指示を送った session（重複なし）。 */
const ownersOf = (r: RemoteRecord): string[] => {
  const seen: string[] = [];
  for (const p of r.pending) if (!seen.includes(p.owner)) seen.push(p.owner);
  return seen;
};

export function createRemoteManager(opts: {
  link: ServerLink;
  store: JsonListStore<RemoteRecord>;
  log: Logger;
  /** center ごとに固定の cap_id 接頭（`c-<center の安定 id>`。center-id.ts）。session の cap_id は `<capId>-<session>`。 */
  capId: string;
  /** config の servers[]。server ごとの model / workerModel を引く（無ければ指定しない）。configPath があれば送信のたびに読み直し、読めない時はこの値。 */
  servers?: ServerConfig[];
  /** 指定すると、send のたびにこの config ファイルを読み直して servers[] を取る（remoteControl.model が session 起動のたびに読み直されるのと同じ）。 */
  configPath?: string;
  /** cap_result の後、次の activity を待つ猶予（ms）。既定 SETTLE_GRACE_MS。 */
  graceMs?: number;
  /** status での追従・再試行の間隔（ms）。既定 PROBE_POLL_MS。 */
  pollMs?: number;
  /** server からの activity 通知の保持。省けば list に activity は付かない。 */
  activity?: ActivityStore;
  /**
   * 旧形式（server_id の無い記録）を読み替える前に、元の remotes.json を退避する（既にあれば上書きしない。失敗しても起動は止めない）。
   * 省けば退避しない。
   */
  backup?: () => Promise<void>;
  /** 現在時刻（ms）。テスト用。 */
  now?: () => number;
  /**
   * session が使ってよい server の指定（host 名か server_id）。undefined = 全部。remote_send / remote_delete / worker_reply の server 候補をこの範囲に限る。
   * 省略時は制限なし。呼ぶたびに引くので、設定の更新はすぐ効く。
   */
  serversOf?: (owner: string) => string[] | undefined;
  /** session の remote 集計（RemoteSummary）が変わった時に呼ぶ（記録の保存のたびに前回と比べ、変わった session だけ）。desktop への SSE 通知に使う。 */
  onSummaryChange?: (session: string) => void;
  /** 確認できない到達先（peer）を消すまでの時間（既定 PEER_TTL_MS）。 */
  peerTtlMs?: number;
  /** 完了通知の送り先。owner の session へ text を送る。省けば通知しない。 */
  notify?: (owner: string, text: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
}): RemoteManager {
  const { link, store, log, capId } = opts;
  const nowMs = opts.now ?? Date.now;
  const peerTtlMs = opts.peerTtlMs ?? PEER_TTL_MS;
  const graceMs = opts.graceMs ?? SETTLE_GRACE_MS;
  const pollMs = opts.pollMs ?? PROBE_POLL_MS;
  let lastGoodServers = opts.servers;
  const records: RemoteRecord[] = [];
  /** cap_result（や再起動）の後、次の activity か猶予の経過を待っている記録 → 待ち始めた時刻。この間は完了にしない（メモリのみ）。 */
  const settling = new Map<RemoteRecord, number>();
  /** status で「動いていない」と判定した時刻。これより前に受けた activity は古いので、判定に使わない（メモリのみ）。 */
  const statusIdleAt = new Map<RemoteRecord, number>();
  /** status で状態を確かめる予約（メモリのみ）。 */
  const probes = new Map<RemoteRecord, ReturnType<typeof setTimeout>>();
  /** 返信待ちの kick_cap の数（メモリのみ）。center の link は同じ cap_id の指示を直列にするので、2 本目以降は 1 本目の返信後に送られる。 */
  const inflight = new Map<RemoteRecord, number>();
  /** 返信待ちの task の task_id（メモリのみ）。同じ task_id の task_result は待ちに照合されるので触らず、別の task_id なら記録に反映する。 */
  const inflightTasks = new Map<RemoteRecord, Set<string>>();
  /** progress の最後の push の時刻（remote_id|server|worker_id → ms。メモリのみ）。 */
  const lastProgressPush = new Map<string, number>();
  const waiters = new Set<() => void>();
  /** server（peer id）ごとの送信の直列化（status の確認 → 記録 → kick_cap の投入）。 */
  const locks = new Map<string, Promise<unknown>>();

  /** restore 中は保存しない（records が揃う前に保存して、読んだ記録を失わない。最後に restore が 1 回保存する）。 */
  let restoring = false;
  const persist = (): Promise<void> => {
    if (!restoring) emitSummaryChanges();
    return restoring ? Promise.resolve() : store.save(records).catch((e: unknown) => log(`remotes 保存失敗: ${e instanceof Error ? e.message : String(e)}`));
  };

  const has = (r: RemoteRecord): boolean => records.includes(r);

  /** 動いている cap（未完了の指示がある、または remote_list と同じ見え方 stateOf が running = 返信待ち・判定待ち・cap / worker が動いている）。止まった cap の未返答 ask は数えない（残り続けて「判断待ち」が消えなくなるのを避ける）。 */
  const summarize = (session: string): RemoteSummary => {
    let running = 0;
    let waitingReply = 0;
    for (const r of records) {
      if (r.session !== session) continue;
      if (r.pending.length > 0) running++;
      if (r.pending.length > 0 || stateOf(r) === "running") {
        waitingReply += (r.worker_reports ?? []).filter(isOpenAsk).length;
      }
    }
    return { running, waitingReply };
  };
  /** 通知済みの集計（メモリのみ。session → "running/waitingReply"）。 */
  const notified = new Map<string, string>();
  const emitSummaryChanges = (): void => {
    const sessions = new Set<string>(notified.keys());
    for (const r of records) if (r.session !== undefined) sessions.add(r.session);
    for (const s of sessions) {
      const v = summarize(s);
      const key = `${v.running}/${v.waitingReply}`;
      const prev = notified.get(s) ?? "0/0";
      if (key === "0/0") notified.delete(s);
      else notified.set(s, key);
      if (key !== prev) opts.onSummaryChange?.(s);
    }
  };

  /**
   * server に status（cap_id 付き）を送り、この center を cap の通知先として取り戻す（center の再起動で server が持つ通知先が古くなるため）。
   * server がまだ見えない・届かない時は pollMs ごとに ANNOUNCE_RETRIES 回まで再試行する。記録が消えたら止める。
   */
  const announce = async (r: RemoteRecord, attempt = 0): Promise<void> => {
    if (!has(r)) return;
    try {
      const peer = await findPeer(r);
      const reply = await link.statusOn(peer, { cap_id: r.remote_id });
      if (reply.type === "error") throw new Error(reply.message);
      log(`通知先を server へ伝えた（status cap_id）: ${r.remote_id} server=${describeServer(refOf(r))}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt >= ANNOUNCE_RETRIES) {
        log(`通知先を server へ伝えられない（諦める。次の指示で伝わる）: ${r.remote_id} server=${describeServer(refOf(r))} ${msg}`);
        return;
      }
      const t = setTimeout(() => void announce(r, attempt + 1), pollMs);
      t.unref?.();
    }
  };

  const activityOf = (r: RemoteRecord): RemoteActivity | undefined =>
    opts.activity?.get(r.remote_id, peerOfRec(r) ?? r.server) ?? opts.activity?.get(r.remote_id, "");

  const activityBusy = (r: RemoteRecord): boolean => {
    const a = activityOf(r);
    if (!a) return false;
    // status で idle と判定した後は、それより前に受けた activity（cap_result 前の running など）を使わない
    const idleAt = statusIdleAt.get(r);
    if (idleAt !== undefined && Date.now() - a.received_ms_ago < idleAt) return false;
    return a.agents.some((x) => (x.kind === "worker" || x.kind === "cap") && (x.state === "running" || x.state === "stalled"));
  };

  /**
   * list と同じ見え方の state。返信待ちの指示がある間・cap_result の後の判定待ち（settling）の間・
   * cap の turn が終わっていても cap か worker が動いている間は running。
   */
  const stateOf = (r: RemoteRecord): RemoteState => {
    if (r.state === "running" || (inflight.get(r) ?? 0) > 0) return "running";
    if (r.state === "unknown") return "unknown";
    if (settling.has(r)) return "running";
    if (r.state !== "done") return r.state;
    return activityBusy(r) ? "running" : "done";
  };

  const unschedule = (r: RemoteRecord): void => {
    const t = probes.get(r);
    if (t) clearTimeout(t);
    probes.delete(r);
  };
  const schedule = (r: RemoteRecord, ms: number): void => {
    unschedule(r);
    const t = setTimeout(() => {
      probes.delete(r);
      void probe(r);
    }, Math.max(0, ms));
    t.unref?.();
    probes.set(r, t);
  };

  /** 表示用の server。host 名を主に server_id を添える。同じ host 名の別の server の記録がある時は user と workspace も付ける。 */
  const labelOf = (r: RemoteRecord): string => {
    const ref = refOf(r);
    const host = hostOf(ref)?.toLowerCase();
    const twin = host !== undefined && records.some((x) => serverKeyOf(x) !== serverKeyOf(r) && hostOf(refOf(x))?.toLowerCase() === host);
    return twin ? describeServer(ref) : describeServer({ ...ref, user: undefined, workspace: undefined });
  };

  const viewOf = (r: RemoteRecord): RemoteView => {
    const state = stateOf(r);
    const base: RemoteView = { ...r, server_label: labelOf(r), pending: r.pending.map((p) => ({ ...p })), owners: ownersOf(r), worker_reports: (r.worker_reports ?? []).map((w) => ({ ...w })), state };
    if (state === "running") delete base.finishedAt;
    const activity = activityOf(r);
    return { ...base, ...(activity ? { activity } : {}) };
  };

  const wake = (): void => {
    // activity / settling / inflight の変化は persist を通らないことがある。変化点（wake を呼ぶ所）で集計を再評価し、変わった時だけ通知する
    if (!restoring) emitSummaryChanges();
    for (const w of [...waiters]) w();
  };

  /**
   * cap が idle かつ worker 無し（stateOf が running でない）になったら、未完了の指示を全て完了にし、owner ごとに 1 回通知する。
   * 完了にするのは同期で行うので、同じ指示を二重に通知しない。
   */
  const completeIfIdle = (r: RemoteRecord): void => {
    const s = stateOf(r);
    if (!has(r) || s === "running" || s === "unknown") return;
    const pending = r.pending;
    if (pending.length === 0) return;
    r.pending = [];
    void persist();
    const byOwner = new Map<string, PendingInstruction[]>();
    for (const p of pending) {
      const to = r.session ?? p.owner;
      byOwner.set(to, [...(byOwner.get(to) ?? []), p]);
    }
    const text = (instr: PendingInstruction[]): string =>
      formatDoneNotice({ remote_id: r.remote_id, state: s, ...(r.result !== undefined ? { result: r.result } : {}), ...(r.error ? { error: r.error } : {}), instructions: instr.map((i) => i.prompt) });
    for (const [owner, instr] of byOwner) {
      if (!opts.notify) {
        log(`remote 完了通知を送れない: ${r.remote_id} owner=${owner} 通知の送り先が無い`);
        continue;
      }
      void opts.notify(owner, text(instr)).then(
        (res) => res,
        (e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : String(e) }),
      ).then((res) => {
        if (res.ok) log(`remote 完了通知: ${r.remote_id} owner=${owner} state=${s} 指示=${instr.length}`);
        else log(`remote 完了通知を送れない: ${r.remote_id} owner=${owner} ${res.reason}`);
        wake();
      });
    }
    wake();
  };

  /**
   * 結果を最新の状態に反映する（履歴は持たない）。kind: cap_result = cap の turn が終わった（成功・失敗とも）/ error = server の error 返信 /
   * transport = server に届かない・返信が来ない（state は failed でなく unknown）。
   * cap_result は即座に完了にしない: 未完了の指示があれば settling にして、次の activity か猶予（graceMs）の後の status で判定する。
   */
  const applyResult = (r: RemoteRecord, res: { ok: boolean; text: string; error?: string }, kind: "cap_result" | "error" | "transport", taskResult?: TaskResultReply): void => {
    if (!has(r)) return;
    const now = new Date().toISOString();
    r.state = kind === "transport" ? "unknown" : res.ok ? "done" : "failed";
    r.finishedAt = now;
    if (taskResult) r.task_result = taskResult;
    if (kind === "cap_result" && r.pending.length > 0) {
      settling.set(r, Date.now());
      schedule(r, graceMs);
    } else if (kind === "transport") {
      schedule(r, pollMs);
    }
    if (res.ok) {
      r.result = truncate(res.text);
      r.result_at = now;
      delete r.error;
      delete r.error_at;
    } else {
      r.error = res.error ?? "失敗";
      r.error_at = now;
      if (res.text) {
        r.result = truncate(res.text);
        r.result_at = now;
      }
    }
    void persist();
    completeIfIdle(r);
    wake();
  };

  /**
   * server の status から、cap（r の cap_id）か worker が動いているか。worker は cap との対応が status に無い。
   * 他 session の cap の worker を数えないよう、この cap の activity があればそこに載る worker だけを見る（載っていなければ worker 無し）。
   * activity がまだ無い（center 再起動直後など）間は対応が分からないので server 全体で見る（完了判定が遅れることはあっても、早まらない）。
   */
  const statusBusy = (st: StatusReply, r: RemoteRecord): boolean => {
    const cap = st.caps.find((c) => c.id === r.remote_id);
    const mine = activityOf(r)?.agents.filter((a) => a.kind === "worker").map((a) => a.id);
    const workers = mine === undefined ? st.workers : st.workers.filter((w) => mine.includes(w.id));
    return (cap !== undefined && (cap.state === "running" || (cap.queued ?? 0) > 0)) || workers.some((w) => w.state === "running");
  };

  /**
   * server の status で記録の状態を確かめる。取れなければ unknown（再試行を予約）。取れたら:
   * 動いている → running で追従（pollMs ごと）。動いていない → 猶予内なら猶予の終わりまで待ち（遅れた cap_result を拾う）、
   * 過ぎたら running / unknown を done にして完了判定。返信待ちの kick_cap がある間は返信が進めるので何もしない。
   */
  const probe = async (r: RemoteRecord): Promise<void> => {
    if (!has(r) || (inflight.get(r) ?? 0) > 0) return;
    const startedAt = Date.now();
    let st: StatusReply;
    try {
      const peer = await findPeer(r);
      const reply = await link.statusOn(peer, { cap_id: r.remote_id });
      if (reply.type === "error") throw new Error(reply.message);
      st = reply;
    } catch (e) {
      if (!has(r) || (inflight.get(r) ?? 0) > 0) return;
      const msg = e instanceof Error ? e.message : String(e);
      if (r.state !== "unknown") log(`remote 状態不明: ${r.remote_id} status を取れない: ${msg}`);
      r.state = "unknown";
      r.error = `${STATUS_ERR}: ${msg}`;
      void persist();
      wake();
      schedule(r, pollMs);
      return;
    }
    if (!has(r) || (inflight.get(r) ?? 0) > 0) return;
    if (statusBusy(st, r)) {
      settling.delete(r);
      statusIdleAt.delete(r);
      if (r.state !== "running") log(`remote 追従: ${r.remote_id} cap / worker が動いている（status）`);
      r.state = "running";
      delete r.finishedAt;
      if (r.error?.startsWith(STATUS_ERR)) delete r.error;
      void persist();
      wake();
      schedule(r, pollMs);
      return;
    }
    // status を取っている間に新しい activity が来て、動いていると言っているなら、そちらを信じて次の周期で確かめ直す
    const fresh = activityOf(r);
    if (fresh && Date.now() - fresh.received_ms_ago >= startedAt && activityBusy(r)) {
      schedule(r, pollMs);
      return;
    }
    const since = settling.get(r);
    if (since !== undefined && Date.now() - since < graceMs) {
      schedule(r, graceMs - (Date.now() - since));
      return;
    }
    settling.delete(r);
    statusIdleAt.set(r, Date.now());
    if (r.state === "running" || r.state === "unknown") {
      r.state = "done";
      r.finishedAt = new Date().toISOString();
      if (r.error?.startsWith(STATUS_ERR)) delete r.error;
    }
    log(`remote 完了判定（status）: ${r.remote_id} state=${stateOf(r)}`);
    void persist();
    completeIfIdle(r);
    wake();
  };

  const resultOf = (reply: CapResultReply | TaskResultReply | ErrorReply): { ok: boolean; text: string; error?: string } =>
    reply.type === "task_result"
      ? { ok: reply.state === "done", text: reply.summary, ...(reply.state === "done" ? {} : { error: reply.error ?? "失敗" }) }
      : reply.type === "cap_result"
        ? { ok: reply.ok, text: reply.result_text, ...(reply.ok ? {} : { error: reply.error ?? "失敗" }) }
        : { ok: false, text: "", error: reply.message };

  /** 発見した peer の一覧（識別つき）。識別が未取得なら hello で取る。取れなければ素の発見結果。 */
  const livePeers = (): Promise<ServerPeer[]> => (link.identifiedPeers ? link.identifiedPeers() : link.peers());

  /** host が一致するか（大文字小文字を区別しない）。 */
  const sameHost = (a: string | undefined, b: string | undefined): boolean => a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

  /**
   * server_id の無い旧形式の記録が、この peer の server か。peer id が一致するか、名前 + host が一致し、
   * かつ同じ名前 + host の peer が live に 1 つだけ（同じ host に同名の server が 2 つある時は取り違えない）。
   * host の無い記録（serverHost を持つ前の旧形式）は名前だけで一致するが、同名の peer が 1 つだけの時に限る。
   */
  const legacyMatches = (r: RemoteRecord, peer: ServerPeer, live: ServerPeer[]): boolean => {
    if (r.server_id !== undefined) return false;
    if (r.server === peer.id || r.peer === peer.id) return true;
    if (r.serverName !== peer.name) return false;
    const twins = live.filter((p) => p.name === r.serverName && (r.serverHost === undefined || sameHost(r.serverHost, hostOf(p))));
    return twins.length === 1 && twins[0].id === peer.id;
  };

  /** 記録がこの peer の server か（server_id 同士 → 到達先の peer id → 旧形式の突き合わせ）。 */
  const sameServer = (r: RemoteRecord, peer: ServerPeer, live: ServerPeer[]): boolean => {
    if (r.server_id !== undefined) {
      if (peer.server_id !== undefined) return r.server_id === peer.server_id;
      return r.peer === peer.id; // peer の識別が未取得: 到達先が同じ時だけ同じとみなす
    }
    return legacyMatches(r, peer, live);
  };

  /** server の peer から session の記録を探す。session × server ごとに 1 件。 */
  const findRecord = (peer: ServerPeer, session: string, live: ServerPeer[]): RemoteRecord | undefined =>
    records.filter((r) => r.session === session).find((r) => sameServer(r, peer, live));

  /** 記録を消す（メモリ上の状態も片付ける）。server には何も送らない。 */
  const forgetRecord = (rec: RemoteRecord): void => {
    const i = records.indexOf(rec);
    if (i >= 0) records.splice(i, 1);
    inflight.delete(rec);
    inflightTasks.delete(rec);
    settling.delete(rec);
    statusIdleAt.delete(rec);
    unschedule(rec);
  };

  /**
   * 記録に peer（今の到達先と識別）を反映する。server_id が分かれば記録の server を server_id に寄せる（旧形式の引き継ぎ）。
   * 変わったら保存する（到達先の確認時刻だけの更新は SEEN_PERSIST_MS ごと）。変更があれば true。
   */
  const syncRecord = (r: RemoteRecord, peer: ServerPeer): boolean => {
    let changed = false;
    const set = <K extends keyof RemoteRecord>(k: K, v: RemoteRecord[K] | undefined): void => {
      if (v === undefined || r[k] === v) return;
      r[k] = v;
      changed = true;
    };
    if (peer.server_id !== undefined) {
      if (r.server_id === undefined) log(`旧形式の記録を server_id へ引き継ぐ: ${r.remote_id} peer=${r.server} -> server_id=${peer.server_id}`);
      set("server_id", peer.server_id);
      set("server", peer.server_id);
    } else if (r.server_id === undefined) {
      set("server", peer.id);
    }
    set("peer", peer.id);
    // この peer id が別の server_id になった（workspace の作り直しなど）: 旧 server_id の記録に peer を残さない
    if (peer.server_id !== undefined) {
      for (const o of records) {
        if (o !== r && o.server_id !== undefined && o.server_id !== peer.server_id && o.peer === peer.id) {
          log(`peer id が別の server_id になった: ${peer.id} ${o.server_id} -> ${peer.server_id}（旧記録 ${o.remote_id} の到達先を外す）`);
          delete o.peer;
          delete o.peer_seen_at;
          changed = true;
        }
      }
    }
    set("serverName", peer.name);
    set("serverHost", hostOf(peer));
    set("serverUser", peer.user);
    set("serverWorkspace", peer.workspace);
    const stale = r.peer_seen_at === undefined || nowMs() - Date.parse(r.peer_seen_at) >= SEEN_PERSIST_MS;
    r.peer_seen_at = new Date(nowMs()).toISOString();
    if (changed || stale) void persist();
    return changed;
  };

  /**
   * 同じ server_id・同じ remote_id の記録が複数ある（再登録前の旧 peer id の記録が残った）時、1 件にまとめる。
   * 動いている記録を最優先、同順位なら最新を残す。消すのは center の記録だけ（server には何も送らない）。まとめた余分の件数を返す。
   */
  const consolidate = (): number => {
    let removed = 0;
    const groups = new Map<string, RemoteRecord[]>();
    for (const r of records) {
      if (r.server_id === undefined) continue;
      const key = `${r.server_id}\u0000${r.remote_id}\u0000${r.session ?? ""}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const keep = [...g].sort((x, y) => Number(isActiveRec(y)) - Number(isActiveRec(x)) || lastAt(y).localeCompare(lastAt(x)))[0]!;
      for (const r of g) {
        if (r === keep) continue;
        forgetRecord(r);
        removed++;
        log(`同じ server_id の旧記録を整理: ${r.remote_id} server_id=${r.server_id} peer=${r.peer ?? "-"}（残す: peer=${keep.peer ?? "-"}）`);
      }
    }
    if (removed > 0) void persist();
    return removed;
  };

  /**
   * 長く確認できない到達先（peer）を記録から消す。peer_seen_at から peerTtlMs を超え、今の発見（live）にも居ない peer が対象。
   * 消すのは到達先のキャッシュだけ。server_id・host・user・workspace・cap の記録（session × server の対応）は残す。
   * 旧形式の記録（server_id が無い）は server が peer id なので消さない。消した件数を返す。
   */
  const clearStalePeers = (live: ServerPeer[]): number => {
    let n = 0;
    for (const r of records) {
      if (r.server_id === undefined || r.peer === undefined) continue;
      const seen = r.peer_seen_at === undefined ? NaN : Date.parse(r.peer_seen_at);
      if (!Number.isNaN(seen) && nowMs() - seen < peerTtlMs) continue;
      if (live.some((p) => p.id === r.peer)) continue;
      log(`確認できない到達先を消す: ${r.remote_id} server=${describeServer(refOf(r))} peer=${r.peer}（最後に確認: ${r.peer_seen_at ?? "不明"}）`);
      delete r.peer;
      delete r.peer_seen_at;
      n++;
    }
    if (n > 0) void persist();
    return n;
  };

  /** 通知・遅れた返信の送信元から記録を決める。同じ cap_id が 1 件だけなら、peer id が変わっていてもそれ（別の server_id と分かっていればそれは除く）。 */
  const resolveRecord = (id: string, fromId?: string): RemoteRecord | undefined => {
    const cands = records.filter((r) => r.remote_id === id);
    if (cands.length === 0) return undefined;
    if (fromId === undefined) return cands.length === 1 ? cands[0] : undefined;
    const ident = link.identityOf?.(fromId);
    // 識別（server_id）が分かれば、それで先に探す。peer id 一致を先にすると、同じ peer id に別の server_id が現れた時
    // （workspace の作り直しなど）旧 server_id の記録に当たって弾かれ、新しい記録に届かない。server_id を持たない旧形式だけ peer id で探す
    const hit =
      ident?.server_id !== undefined
        ? (cands.find((r) => r.server_id === ident.server_id) ?? cands.find((r) => r.server_id === undefined && peerOfRec(r) === fromId))
        : cands.find((r) => peerOfRec(r) === fromId);
    const rec = hit ?? (cands.length === 1 ? cands[0] : undefined);
    if (!rec) return undefined;
    // 別の server_id と分かっている server からは取り違えない
    if (ident?.server_id !== undefined && rec.server_id !== undefined && rec.server_id !== ident.server_id) return undefined;
    if (peerOfRec(rec) !== fromId || (ident?.server_id !== undefined && rec.server_id === undefined)) {
      const known: ServerPeer = { id: fromId, name: rec.serverName, ...(ident ?? {}) };
      if (known.host === undefined && rec.serverHost !== undefined) known.hostname = rec.serverHost;
      syncRecord(rec, known);
      consolidate();
    }
    return rec;
  };

  /** 記録の server を今の peer から探す。見つけたら記録へ反映する（旧 peer id の記録は server_id へ引き継ぐ）。 */
  const findPeer = async (r: RemoteRecord): Promise<ServerPeer> => {
    const peers = await livePeers();
    let hit: ServerPeer | undefined;
    if (r.server_id !== undefined) {
      const same = peers.filter((p) => p.server_id === r.server_id);
      if (same.length > 1) throw new Error(duplicateServerIdMessage(r.server_id, same.map((p) => ({ ...p, peerId: p.id }))));
      hit = peers.find((p) => p.server_id === r.server_id) ?? peers.find((p) => p.server_id === undefined && r.peer !== undefined && p.id === r.peer);
    } else {
      hit = peers.find((p) => p.id === r.server) ?? peers.find((p) => legacyMatches(r, p, peers));
    }
    if (!hit) throw new Error(`server が見つからない: ${describeServer(refOf(r))}`);
    if (syncRecord(r, hit)) consolidate();
    return hit;
  };

  /** 指定が records の server に一致する段（server_id → peer id → host 名 → 名前）。最初に 1 件以上一致した段の記録を返す。 */
  const recordsMatching = (cands: RemoteRecord[], sel: string): RemoteRecord[] => {
    const tiers: Array<(r: RemoteRecord) => boolean> = [
      (r) => r.server_id === sel,
      (r) => peerOfRec(r) === sel || r.server === sel,
      (r) => sameHost(r.serverHost, sel),
      (r) => r.serverName === sel,
    ];
    for (const t of tiers) {
      const hit = cands.filter(t);
      if (hit.length > 0) return hit;
    }
    return [];
  };

  /** remote_id（省略時は全ての記録）と server から記録を 1 件決める。複数あれば server で絞らせる。 */
  const notInServers = (what: string, allowed: string[], owner: string | undefined): string =>
    `この session の servers に無い: ${what}（session=${owner ?? "?"}, servers=[${allowed.join(", ")}]${allowed.length === 0 ? "。空 = どの server も使わない" : ""}）`;

  const pick = async (remote_id: string | undefined, server: string | undefined, owner?: string, restrict = false): Promise<RemoteRecord> => {
    // owner あり: その session の cap。旧共有 cap（session 無し）は remote_id で明示した時だけ。他の session の cap は見えない
    const visible = (r: RemoteRecord): boolean =>
      owner === undefined || r.session === owner || (remote_id !== undefined && r.session === undefined && r.remote_id === remote_id);
    let cands = (remote_id === undefined ? [...records] : records.filter((r) => r.remote_id === remote_id)).filter(visible);
    if (cands.length === 0) throw new Error(`未定義の remote: ${remote_id ?? "（remote_id 省略。remote が無い）"}`);
    // session の servers の範囲（restrict の時だけ。remote_delete / worker_reply）: server 省略時は範囲内の記録だけが候補、明示指定が範囲外ならエラー
    const allowed = restrict && owner !== undefined ? opts.serversOf?.(owner) : undefined;
    const inRange = (r: RemoteRecord): boolean => serverAllowed(allowed, { ...(r.server_id !== undefined ? { server_id: r.server_id } : {}), ...(r.serverHost ? { host: r.serverHost } : {}) });
    if (allowed !== undefined && server === undefined) {
      const ok = cands.filter(inRange);
      if (ok.length === 0) throw new Error(notInServers(cands.map((r) => describeServer(refOf(r))).join(" / "), allowed, owner));
      cands = ok;
    }
    if (server !== undefined) {
      // 記録に書かれた server_id / peer / host で探す（server が今見えなくても指せる）。無ければ今の発見結果（識別つき）で探す
      let hit = recordsMatching(cands, server);
      if (hit.length === 0) {
        const live = await livePeers().catch(() => [] as ServerPeer[]);
        const peers = matchServerPeers(live, server);
        hit = cands.filter((r) => peers.some((p) => sameServer(r, p, live)));
      }
      if (hit.length === 0) throw new Error(`その server に remote ${remote_id ?? ""} は無い: ${server}`);
      if (allowed !== undefined) {
        const ok = hit.filter(inRange);
        if (ok.length === 0) throw new Error(notInServers(`${server}（${hit.map((r) => describeServer(refOf(r))).join(" / ")}）`, allowed, owner));
        hit = ok;
      }
      // 同じ指定が複数の server の記録に一致する（同じ host に server が 2 つなど）なら、取り違えない
      const servers = new Map(hit.map((r) => [serverKeyOf(r), r]));
      if (servers.size > 1) throw new Error(ambiguousServerMessage(server, [...servers.values()].map(refOf)));
      cands = hit;
    }
    if (cands.length > 1) {
      const distinctIds = new Set(cands.map((r) => r.remote_id)).size > 1;
      throw new Error(
        distinctIds
          ? `remote_id 省略では 1 件に決まらない（remote_id で指定: ${cands.map((r) => r.remote_id).join(", ")}）`
          : `remote ${remote_id ?? "（remote_id 省略）"} は複数の server にある（server で指定: ${cands.map((r) => describeServer(refOf(r))).join(" / ")}）`,
      );
    }
    return cands[0];
  };

  /**
   * send の server 候補。owner の session に servers の指定があれば、範囲内の server だけ（server 省略時の既定も範囲内の先頭。明示指定が範囲外ならエラー）。
   * 指定が無ければ従来どおり link.selectPeer。
   */
  const selectPeerFor = async (owner: string, sel: string | undefined): Promise<ServerPeer> => {
    const allowed = opts.serversOf?.(owner);
    if (allowed === undefined) return link.selectPeer(sel);
    const inRange = (p: ServerPeer): boolean => serverAllowed(allowed, { ...(p.server_id !== undefined ? { server_id: p.server_id } : {}), ...(hostOf(p) ? { host: hostOf(p) } : {}) });
    if (sel !== undefined) {
      const p = await link.selectPeer(sel);
      if (!inRange(p)) throw new Error(notInServers(describeServer({ ...p, peerId: p.id }), allowed, owner));
      return p;
    }
    const ok = (await livePeers()).filter(inRange);
    if (ok.length === 0) throw new Error(notInServers("使える server が無い", allowed, owner));
    return link.selectPeer(ok[0].server_id ?? ok[0].id);
  };

  /** 送信のたびに config を読み直した servers[]。読めない・不正な時は直前に読めた値。 */
  const currentServers = (): ServerConfig[] | undefined => {
    if (!opts.configPath) return lastGoodServers;
    try {
      lastGoodServers = loadConfigSync(opts.configPath).servers;
    } catch (e) {
      log(`config の読み直しに失敗。直前の servers で送信: ${e instanceof Error ? e.message : String(e)}`);
    }
    return lastGoodServers;
  };

  /** config の servers[] から、この server の model / workerModel を引く（peer id・peer 名・name・指定された sel のどれかで一致）。 */
  const serverModels = (peer: ServerPeer, sel?: string): { model?: string; worker_model?: string } => {
    const cfg = currentServers()?.find((s) => s.peer === peer.id || s.peer === peer.name || s.name === peer.name || (sel !== undefined && s.name === sel));
    return { ...(cfg?.model ? { model: cfg.model } : {}), ...(cfg?.workerModel ? { worker_model: cfg.workerModel } : {}) };
  };

  const serial = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    locks.set(key, next);
    void next.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      if (locks.get(key) === next) locks.delete(key);
    });
    return next;
  };

  const restoreInner = async (): Promise<void> => {
      const loaded: RemoteRecord[] = [];
      /** session の cap（session × server ごとに 1 件。そのまま復元する）。 */
      const sessioned: RemoteRecord[] = [];
      for (const r of await store.load()) {
        if (typeof r?.remote_id !== "string" || !AGENT_ID_PATTERN.test(r.remote_id)) continue;
        // 旧形式の欄（history・legacy・record 単位の owner）は、未完了の指示だけ引き継いで捨てる
        const old = r as RemoteRecord & { history?: unknown; legacy?: unknown; owner?: unknown };
        if (!Array.isArray(r.pending)) {
          r.pending = Array.isArray(old.history)
            ? (old.history as { type?: string; at: string; owner: string; prompt: string; done_at?: string }[])
                .filter((e) => e.type === "instruction" && e.done_at === undefined)
                .map((e) => ({ at: e.at, owner: e.owner, prompt: e.prompt }))
            : [];
        }
        delete old.history;
        delete old.legacy;
        delete old.owner;
        if (r.state !== "running" && r.state !== "done" && r.state !== "failed" && r.state !== "unknown") r.state = "unknown";
        // session の欄が不正なら旧共有 cap として扱う
        if (r.session !== undefined && (typeof r.session !== "string" || !OWNER_PATTERN.test(r.session))) delete r.session;
        if (r.session !== undefined) sessioned.push(r);
        else loaded.push(r);
      }
      // 旧形式（server_id の無い記録）を server_id へ読み替える。元の remotes.json は先に退避する（既にあれば上書きしない）。
      // 対応する server が今見えない・識別を返さない記録は、peer id のまま残す（"unknown" を悪化させない。その server が hello を返した時に findPeer / resolveRecord が引き継ぐ）。
      // 失敗しても起動は止めない。
      const all = [...sessioned, ...loaded];
      let live: ServerPeer[] = [];
      let discovered = false;
      try {
        if (all.some((r) => r.server_id === undefined)) await opts.backup?.();
      } catch (e) {
        log(`remotes.json の退避に失敗（続行）: ${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        live = await livePeers();
        discovered = true;
      } catch (e) {
        log(`server の発見に失敗（旧形式の読み替えは後で）: ${e instanceof Error ? e.message : String(e)}`);
      }
      let upgraded = 0;
      for (const r of all) {
        try {
          const p = live.find((x) => (r.server_id !== undefined ? x.server_id === r.server_id : x.server_id !== undefined && legacyMatches(r, x, live)));
          if (!p) continue;
          const wasLegacy = r.server_id === undefined;
          syncRecord(r, p);
          if (wasLegacy) upgraded++;
        } catch (e) {
          log(`記録の読み替えに失敗（そのまま残す）: ${r.remote_id} ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // server ごとに 1 件にする。同じ server に複数ある（作業ごとの cap の名残）時は、動いている記録を最優先、同順位なら最新の 1 件を残し、他は stop_cap を送って消す（1 回限りの後始末）。
      // 同じ server = peer id が同じ、または名前 + host が同じ。host の無い旧記録は、今の peer で同名の server が 1 つだけと確かめられた時だけ、その host の server とみなす。
      // 確かめられない（peer が引けない・同名の peer が複数）host 無しの記録は、どの記録とも一緒にせず、stop_cap も送らずにそのまま残す（次の status 成功時に host が埋まる）
      const hostOfRec = (r: RemoteRecord): string | undefined => {
        if (r.serverHost !== undefined) return r.serverHost;
        const same = live.filter((p) => p.name === r.serverName);
        return same.length === 1 ? same[0].hostname : undefined;
      };
      const surplus: RemoteRecord[] = [];
      const groups: RemoteRecord[][] = [];
      for (const r of loaded) {
        const h = hostOfRec(r);
        const g =
          h === undefined && r.serverHost === undefined
            ? undefined
            : groups.find((m) =>
                m.some((x) =>
                  x.server === r.server ||
                  // 両方 server_id が分かっていて違うなら別の server（同じ host に同名の server が 2 つあっても取り違えない）
                  (!(x.server_id !== undefined && r.server_id !== undefined) && x.serverName === r.serverName && hostOfRec(x) !== undefined && hostOfRec(x) === h),
                ),
              );
        if (g) g.push(r);
        else groups.push([r]);
      }
      let migrated = 0;
      records.push(...sessioned);
      for (const group of groups) {
        // 動いている（running・unknown・未完了の指示あり）記録を最優先、同順位なら最新。動いている cap へ stop_cap を送らないため
        const keep = [...group].sort((x, y) => Number(isActiveRec(y)) - Number(isActiveRec(x)) || lastAt(y).localeCompare(lastAt(x)))[0]!;
        if (keep.remote_id !== capId) {
          migrated++;
          log(`旧形式の記録を旧共有 cap（session 無し）として引き継ぐ: cap_id=${keep.remote_id} server=${keep.serverName}`);
        } else {
          log(`旧共有 cap を session 無しの記録として残す（新しい指示は送らない。remote_delete で消せる）: cap_id=${keep.remote_id} server=${keep.serverName}`);
        }
        for (const r of group) {
          if (r === keep) records.push(r);
          else surplus.push(r);
        }
      }
      for (const r of records) {
        // running・unknown・未完了の指示がある記録は、failed にせず復元して server の status で追従する
        if (isActiveRec(r)) {
          settling.set(r, Date.now());
          schedule(r, 0);
        } else {
          // 追従の status を送らない記録も、server へ通知先（この center）を伝える（status は cap_id 付き）
          void announce(r);
        }
      }
      const merged = consolidate();
      // 発見に失敗した時は到達先を消さない（prune と同じ。live が空なのは「居ない」でなく「分からない」）
      const peersCleared = discovered ? clearStalePeers(live) : 0;
      restoring = false;
      if (records.length > 0 || surplus.length > 0) await persist();
      log(`remote 記録を読込: ${records.length} 件${upgraded > 0 ? `（server_id へ引き継ぎ ${upgraded} 件）` : ""}${merged > 0 ? `（同じ server_id の重複 ${merged} 件を整理）` : ""}${peersCleared > 0 ? `（古い到達先 ${peersCleared} 件を消した）` : ""}${migrated > 0 ? `（旧形式から引き継ぎ ${migrated} 件）` : ""}${surplus.length > 0 ? `（同じ server の余分な旧形式 ${surplus.length} 件は stop_cap を送って記録を消す）` : ""}`);
      // 余分な旧形式: server に stop_cap を送る（届かなくても記録は消す。結果は center.log）
      await Promise.all(
        surplus.map(async (r) => {
          try {
            const peer = await findPeer(r);
            const reply = await link.stopCapOn(peer, { cap_id: r.remote_id });
            if (reply.type === "stop_result") log(`旧形式の remote を掃除: ${r.remote_id} server=${r.serverName} stopped=${reply.stopped}`);
            else throw new Error(reply.type === "error" ? reply.message : "不明な返信");
          } catch (e) {
            log(`旧形式の remote の stop_cap が届かない（記録は消した）: ${r.remote_id} server=${r.serverName} ${e instanceof Error ? e.message : String(e)}`);
          }
        }),
      );
  };

  return {
    async restore() {
      restoring = true;
      try {
        await restoreInner();
      } finally {
        restoring = false;
      }
    },

    async send(input) {
      if (input.worker_model !== undefined && !MODEL_PATTERN.test(input.worker_model)) throw new Error("worker_model が不正: 英数字と . _ [ ] - のみ（先頭は - 不可）");
      if (input.goal.length === 0 || input.goal.includes("\0")) throw new Error("goal が不正（空・NUL 文字は不可）");
      if (!OWNER_PATTERN.test(input.owner)) throw new Error("owner は英数字と _ - のみ");
      const peer = await selectPeerFor(input.owner, input.server);
      const live = await livePeers().catch(() => [peer]);
      // protocol の版が合わない・更新待ちの server へは、記録を作らず isError で返す（session が後で再送できる）
      const blocked = link.gate?.(peer, "task");
      if (blocked) throw new Error(blocked.message);
      return serial(peer.server_id ?? peer.id, async () => {
        // cap は session × server に 1 つ。cap_id は center-id と session 名から決まる。無ければ記録を作り、cap は server が最初の task で作る
        // 既存の記録があればその remote_id（session の改名後も cap_id は変えない）
        let rec = findRecord(peer, input.owner, live);
        const cid = rec?.remote_id ?? sessionCapId(capId, input.owner);
        const st = await link.statusOn(peer, { cap_id: cid });
        if (st.type === "error") throw new Error(`server の cap を確かめられない: ${st.message}`);
        const exists = st.caps.some((c) => c.id === cid);
        // 新規の cap: 指定 > config。既存の cap: worker_model は指定された時だけ送る（server が cap の既定として記憶する）
        const cfgModels = exists ? {} : serverModels(peer, input.server);
        const workerModel = input.worker_model ?? cfgModels.worker_model;
        const taskId = newTaskId();
        const now = new Date().toISOString();
        if (!rec) {
          rec = { remote_id: cid, session: input.owner, server: peer.server_id ?? peer.id, serverName: peer.name, state: "running", createdAt: now, pending: [] };
          records.push(rec);
        }
        syncRecord(rec, peer);
        consolidate();
        // cap を作る時は、記録も作った時の値にする
        if (!exists && !workerModel) delete rec.worker_model;
        if (workerModel) rec.worker_model = workerModel;
        const target = rec;
        target.pending.push({ at: now, owner: input.owner, prompt: input.goal.slice(0, PROMPT_HEAD_MAX), task_id: taskId });
        target.state = "running";
        delete target.finishedAt;
        settling.delete(target);
        statusIdleAt.delete(target);
        unschedule(target);
        inflight.set(target, (inflight.get(target) ?? 0) + 1);
        inflightTasks.set(target, (inflightTasks.get(target) ?? new Set<string>()).add(taskId));
        await persist();
        log(`remote 指示: ${cid} task_id=${taskId} owner=${input.owner} server=${describeServer({ ...peer, peerId: peer.id })} ${exists ? "既存の cap へ" : "cap を作成（最初の task）"}`);
        const settle = (res: { ok: boolean; text: string; error?: string }, kind: "cap_result" | "error" | "transport", taskResult?: TaskResultReply): void => {
          inflight.set(target, Math.max(0, (inflight.get(target) ?? 1) - 1));
          inflightTasks.get(target)?.delete(taskId);
          applyResult(target, res, kind, taskResult);
          log(`remote 結果: ${cid} task_id=${taskId} state=${stateOf(target)}`);
        };
        const cmd: TaskInput = {
          cap_id: cid,
          task_id: taskId,
          goal: input.goal,
          ...(input.repo ? { repo: input.repo } : {}),
          ...(input.branch ? { branch: input.branch } : {}),
          deliverables: input.deliverables ?? {},
          verify: input.verify ?? {},
          constraints: input.constraints ?? [],
          workers: input.workers ?? {},
          ...(workerModel ? { worker_model: workerModel } : {}),
        };
        void link.taskOn(peer, cmd).then(
          (reply) => settle(resultOf(reply), reply.type === "task_result" ? "cap_result" : "error", reply.type === "task_result" ? reply : undefined),
          (e: unknown) => settle({ ok: false, text: "", error: e instanceof Error ? e.message : String(e) }, "transport"),
        );
        return {
          remote_id: cid,
          server: peer.server_id ?? peer.id,
          ...(peer.server_id ? { server_id: peer.server_id } : {}),
          peer: peer.id,
          ...(hostOf(peer) ? { host: hostOf(peer) } : {}),
          serverName: peer.name,
          state: "running" as const,
          created: !exists,
          task_id: taskId,
          ...(target.worker_model ? { worker_model: target.worker_model } : {}),
        };
      });
    },

    conflictsWith(name, mode, oldName) {
      let cid: string;
      try {
        cid = sessionCapId(capId, name);
      } catch {
        return null;
      }
      for (const r of records) {
        if (mode === "create") {
          if (r.remote_id === cid && r.session !== undefined && r.session !== name)
            return `name の cap_id（${cid}）を別の session（${r.session}）の remote 記録が持っている。remote_delete で消すまで再利用できない: ${name}`;
        } else if (r.session !== oldName && (r.session === name || r.remote_id === cid)) {
          return `name に remote 記録が残っている（${r.remote_id}${r.session ? ` session=${r.session}` : ""}）。remote_delete で消すまで再利用できない: ${name}`;
        }
      }
      return null;
    },

    async renameSession(oldName, newName) {
      let n = 0;
      for (const r of records) {
        let hit = false;
        if (r.session === oldName) {
          r.session = newName;
          hit = true;
        }
        for (const p of r.pending) {
          if (p.owner === oldName) {
            p.owner = newName;
            hit = true;
          }
        }
        if (hit) n++;
      }
      if (n > 0) await persist();
      log(`remote の session を付け替えた: ${oldName} -> ${newName} (記録 ${n} 件、cap_id は変えない)`);
      return n;
    },

    async delete({ remote_id, server, force, owner }) {
      const rec = await pick(remote_id, server, owner, true);
      let stopped = false;
      let warning: string | undefined;
      try {
        const peer = await findPeer(rec);
        const reply = await link.stopCapOn(peer, { cap_id: rec.remote_id });
        if (reply.type === "stop_result") stopped = reply.stopped;
        else throw new Error(reply.type === "error" ? reply.message : "不明な返信");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // 実行中の記録を、止められないまま消さない。force か、既に終わっている記録なら消す
        if (stateOf(rec) === "running" && !force) throw new Error(`remote を止められない: ${msg}（force: true で記録だけ消せる）`);
        warning = `server へ stop_cap を送れなかった: ${msg}`;
      }
      forgetRecord(rec);
      opts.activity?.forget(rec.remote_id, peerOfRec(rec) ?? rec.server);
      wake();
      await persist();
      log(`remote 削除: ${rec.remote_id} server=${describeServer(refOf(rec))} stopped=${stopped}${warning ? ` warning=${warning}` : ""}`);
      return { remote_id: rec.remote_id, deleted: true, stopped, ...(warning ? { warning } : {}) };
    },

    async workerReply({ remote_id, server, worker_id, text, owner }) {
      if (!AGENT_ID_PATTERN.test(worker_id)) throw new Error("worker_id は英数字と _ - のみ");
      if (text.length === 0 || text.includes("\0")) throw new Error("text が不正（空・NUL 文字は不可）");
      const rec = await pick(remote_id, server, owner, true);
      const peer = await findPeer(rec);
      const blocked = link.gate?.(peer, "worker_reply");
      if (blocked) throw new Error(blocked.message);
      // 返答を送った時点で返答待ちだった ask / approve だけを対象にする（送信の await 中に届いた新しい ask は含めない）
      const targets = (rec.worker_reports ?? []).filter((w) => w.worker_id === worker_id && isOpenAsk(w));
      const reply = await link.workerReplyOn(peer, { cap_id: rec.remote_id, worker_id, text });
      if (reply.type === "error") throw new Error(reply.message);
      // 返答済みにする（返答は worker に 1 つ届く。永続化される）。送信中に解消された（superseded_at）ものには付けない
      const repliedAt = new Date().toISOString();
      for (const w of targets) if (isOpenAsk(w)) w.replied_at = repliedAt;
      void persist();
      wake();
      log(`remote worker_reply: ${rec.remote_id} worker=${worker_id} server=${rec.serverName}`);
      return { remote_id: rec.remote_id, server: peer.server_id ?? peer.id, worker_id: reply.worker_id, accepted: true as const };
    },

    onWorkerReport(report, fromId) {
      const r = resolveRecord(report.cap_id, fromId);
      if (!r) {
        log(`worker_report を捨てる（記録が無い）: cap_id=${report.cap_id} worker=${report.worker_id} kind=${report.kind}`);
        return;
      }
      // 返答なしで同じ worker が先へ進んだ（progress 以外の後続の report）なら、前の未返答の ask / approve は解消。別 worker・別 cap（resolveRecord で別の記録）は対象外
      if (report.kind !== "progress") {
        const at = new Date().toISOString();
        for (const w of r.worker_reports ?? []) if (w.worker_id === report.worker_id && isOpenAsk(w)) w.superseded_at = at;
      }
      (r.worker_reports ??= []).push(report);
      if (r.worker_reports.length > WORKER_REPORTS_MAX) r.worker_reports.splice(0, r.worker_reports.length - WORKER_REPORTS_MAX);
      void persist();
      wake();
      // progress は同じ worker から PROGRESS_THROTTLE_MS に 1 回まで。ask / approve / done は毎回
      if (report.kind === "progress") {
        const key = `${r.remote_id}|${r.server}|${report.worker_id}`;
        const last = lastProgressPush.get(key);
        const now = Date.now();
        if (last !== undefined && now - last < PROGRESS_THROTTLE_MS) return;
        lastProgressPush.set(key, now);
      }
      // 完了通知と同じ規則: 未完了の指示の owner へ送る。無ければ送らない
      // session の cap は、その session にだけ送る。旧共有 cap（session 無し）は未完了の指示の owner
      const owners = r.session !== undefined ? [r.session] : [...new Set(r.pending.map((p) => p.owner))];
      if (owners.length === 0 || !opts.notify) {
        log(`worker_report を通知しない（${owners.length === 0 ? "未完了の指示が無く owner 不明" : "通知の送り先が無い"}）: ${r.remote_id} worker=${report.worker_id} kind=${report.kind}`);
        return;
      }
      const text = formatWorkerReportNotice(r.remote_id, report);
      for (const owner of owners) {
        void opts.notify(owner, text).then(
          (res) => res,
          (e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : String(e) }),
        ).then((res) => {
          if (res.ok) log(`worker_report 通知: ${r.remote_id} owner=${owner} worker=${report.worker_id} kind=${report.kind}`);
          else log(`worker_report を通知できない: ${r.remote_id} owner=${owner} ${res.reason}`);
        });
      }
    },

    applyLateReply(reply, fromId) {
      const id = reply.cap_id;
      const rec = id === undefined ? undefined : resolveRecord(id, fromId);
      if (!rec) return false;
      // 返信待ちがある間（inflight）はここへ来る返信も待ちに照合されるはずなので、取り違えを避けて触らない。
      // ただし task_id が付いていて、待ちの task_id のどれとも違う（過去の task の遅れた task_result・error）なら反映する
      const taskId = reply.type === "task_result" || reply.type === "error" ? reply.task_id : undefined;
      if ((inflight.get(rec) ?? 0) > 0 && (taskId === undefined || inflightTasks.get(rec)?.has(taskId))) return false;
      applyResult(rec, resultOf(reply), reply.type === "error" ? "error" : "cap_result", reply.type === "task_result" ? reply : undefined);
      log(`remote 結果を更新: ${rec.remote_id} state=${stateOf(rec)}`);
      return true;
    },

    async prune() {
      let live: ServerPeer[] = [];
      try {
        live = await livePeers();
      } catch (e) {
        // 発見できない間は到達先を消さない（server が落ちているのか broker が落ちているのか区別できない）
        log(`整理: server の発見に失敗（到達先は消さない）: ${e instanceof Error ? e.message : String(e)}`);
        return { duplicates: consolidate(), peers: 0 };
      }
      return { duplicates: consolidate(), peers: clearStalePeers(live) };
    },

    async forgetServer(target) {
      const hit = records.filter((r) =>
        target.server_id !== undefined && r.server_id !== undefined ? r.server_id === target.server_id : r.server_id === undefined && target.peerId !== undefined && peerOfRec(r) === target.peerId,
      );
      for (const r of hit) {
        forgetRecord(r);
        opts.activity?.forget(r.remote_id, peerOfRec(r) ?? r.server);
        log(`退役した server の記録を消す: ${r.remote_id} session=${r.session ?? "-"} server=${describeServer(refOf(r))}`);
      }
      if (hit.length > 0) {
        wake();
        await persist();
      }
      return { removed: hit.length, sessions: [...new Set(hit.flatMap((r) => (r.session !== undefined ? [r.session] : [])))] };
    },

    summary: summarize,

    list: (filter) =>
      records
        .filter((r) => filter?.owner === undefined || r.session === filter.owner || (filter.includeShared === true && r.session === undefined))
        .map(viewOf),

    onActivity(id, fromId) {
      const r = resolveRecord(id, fromId);
      if (r) {
        // 新しい activity が来たので、cap_result 後・再起動後の判定待ちは終わり。以後は activity で判定する
        settling.delete(r);
        // done / failed の記録は、新しい activity が判定の根拠になるので、猶予後の status 判定は要らない
        if (r.state === "done" || r.state === "failed") unschedule(r);
        if ((inflight.get(r) ?? 0) === 0 && (r.state === "running" || r.state === "unknown")) {
          // 返信待ちでない running（再起動後・status 追従）と unknown は、activity で動いていなければ done に戻す
          if (activityBusy(r)) {
            r.state = "running";
          } else {
            r.state = "done";
            r.finishedAt = new Date().toISOString();
            unschedule(r);
          }
          if (r.error?.startsWith(STATUS_ERR)) delete r.error;
          void persist();
        }
        completeIfIdle(r);
      }
      wake();
    },

    async wait({ remote_id, server, owner, timeoutSec }) {
      const sec = Math.min(Math.max(timeoutSec ?? WAIT_DEFAULT_SEC, 1), WAIT_MAX_SEC);
      let targets: RemoteRecord[];
      if (remote_id !== undefined || server !== undefined) {
        targets = [await pick(remote_id, server, owner)];
      } else {
        if (owner === undefined) throw new Error("remote_id を省略するには owner（session）が必要");
        targets = records.filter((r) => r.session === owner && r.pending.length > 0);
        if (targets.length === 0) throw new Error("running の remote が無い（未完了の指示が無い）");
      }
      const check = (): RemoteView | undefined => {
        for (const t of targets) {
          // 待っている間に delete された cap は、その時点で failed 扱いにはせず待ちから外す
          if (!has(t)) continue;
          // unknown は終わっていない（status が取れれば戻る）ので待ち続ける
          const s = stateOf(t);
          if (s === "done" || s === "failed") return viewOf(t);
        }
        return undefined;
      };
      const first = check();
      if (first) return first;
      return new Promise<RemoteView>((resolve, reject) => {
        const done = (v: RemoteView | Error): void => {
          clearTimeout(timer);
          waiters.delete(w);
          v instanceof Error ? reject(v) : resolve(v);
        };
        const w = (): void => {
          const v = check();
          if (v) done(v);
          else if (targets.every((t) => !has(t))) done(new Error("待っていた remote が削除された"));
        };
        const timer = setTimeout(() => {
          const v = check();
          const alive = targets.find((t) => has(t));
          if (v) done(v);
          else if (alive) done(viewOf(alive));
          else done(new Error("待っていた remote が削除された"));
        }, sec * 1000);
        waiters.add(w);
      });
    },
  };
}
