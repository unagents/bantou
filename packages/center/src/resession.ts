/**
 * リセッション（session の自律的な後始末と再起動）。設計は docs/design/resession.md。
 *
 * 流れ: session が tool `session_resession` で引継ぎを渡す（request: 安全確認 → 保存 → 印を付けて即返す）→ 次の `Stop` hook の応答を返した後に
 * 区切りの行を出力キューへ積み、`--continue` 無しで起動し直す（restartFresh）→ 新しい claude の `SessionStart`（startup）を受けたら、
 * 最初の入力で引継ぎの本文を渡す。本文は center が保存先（外部記憶または file）から取り出す（10.3。保存した時の本文は持ち越さない）。
 * 取り出せなかった時は、その事・理由・置き場を最初の入力に書く（10.4）。新しい session が自分で引きに行く形は採らない。
 * 印は center の process の中だけに持つ（U8 の B）。
 *
 * スリープ（docs/design/sleep-resession.md）は同じ部品を使う「起動しないリセッション」: requestSleep が引継ぎを頼む 1 行を入力に貼り（kind = sleep）、
 * agent が session_resession で引継ぎを渡すと保存し、次の `Stop` で再起動でなく停止（sleepNow）する。起こす時は armWake で印（kind = wake）を付けて新しい会話で起動し、
 * `SessionStart` で最初の入力に引継ぎを渡す（deliver）。起こした時に別の状況確認の入力は送らない。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { digest8 as digest8With, makeEventId as makeEventIdWith, MEMORY_BODY_MAX, redactReason } from "./memory.js";
import type { SessionInfo, SleepHandoffRef } from "./sessions.js";
import type { Logger } from "./log.js";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** 区切りの行（出力キューに 1 chunk 積む。これより上は以前のやり取りの表示だけ）。 */
export const RESESSION_DIVIDER = "\r\n\u001b[2m──────── リセッション: ここから新しい session。上は以前のやり取り（表示のみ） ────────\u001b[0m\r\n";

/** 起動した後の `SessionStart` を待つ上限。これを過ぎた印は古い物として、次の申告で上書きできる。 */
export const AWAIT_START_STALE_MS = 5 * 60_000;

/** スリープから起こした時の区切りの行（RESESSION_DIVIDER と同じ形。起こす起動の前に出力キューへ積む）。 */
export const WAKE_DIVIDER = "\r\n\u001b[2m──────── スリープから起こした: ここから新しい session。上は以前のやり取り（表示のみ） ────────\u001b[0m\r\n";

/** requestSleep が session の入力に貼る 1 行（引継ぎを書いて既存の session_resession で渡し、turn を終える）。 */
export const SLEEP_ASK_TEXT =
  "[bantou] スリープの依頼。引継ぎ（仕掛かり・止まっている事・次の一手 / 決定と番号つきの未決 / 今の窓口）を書き、道具 session_resession（mcp__bantou__session_resession）で渡す。渡したら「眠る」と短く言って turn を終える。center がこの session を止める（新しい会話はすぐには起動しない。起こした時に引継ぎが最初の入力で渡る）。新しい作業を始めない。";

export interface HandoffRecord {
  id: string;
  session: string;
  at: string;
  /** memory に受理された（本文は memory にある。file は書かない）か、memory に無い・届かず file に保存した（本文はこの file にある）か。 */
  stored: "memory" | "file";
  /** stored が file の時だけ（file の記録は stored = "file" の時だけ書く。10.2）。 */
  body?: string;
  /** 新しい session へ渡した時刻。 */
  deliveredAt?: string;
}

export interface ResessionResult {
  accepted: true;
  handoff_id: string;
  stored: "memory" | "file";
  restart: string;
}

/** requestSleep が依頼を断った時の理由の頭。統括の道具（coordinator_session_sleep）は、この頭の付いた理由を（文の中身を見ずに）そのまま呼び手へ返す。 */
export const SLEEP_REFUSED_PREFIX = "スリープを断った: ";

/** asking = スリープの引継ぎを頼んだ（session_resession を待つ）。 */
type Phase = "asking" | "waiting-stop" | "restarting" | "awaiting-start";
/** restart = リセッション / sleep = スリープ（止めるだけ）/ wake = スリープから起こした後の最初の入力待ち。 */
type Kind = "restart" | "sleep" | "wake";
/** 取り出しの結果。取り出しは投げず、失敗はこの形で `deliver` へ渡す。 */
type Fetched = { ok: true; body: string } | { ok: false; reason: string };
interface Mark {
  kind: Kind;
  /** asking の間は未定（""。引継ぎを受けてから入る）。 */
  id: string;
  stored: "memory" | "file";
  phase: Phase;
  since: number;
  /** asking の間、依頼の 1 行が入って turn が始まった（UserPromptSubmit を見た）。 */
  prompted?: boolean;
  /** 取り出し（`run` が再起動の直前に始め、`deliver` が待つ）。 */
  fetched?: Promise<Fetched>;
}

/** requestSleep の返り値。pending = 引継ぎを頼んだ（眠るのは turn の後。眠った事は events の sleep と session_list の sleeping）。すでに眠っていれば pending = false・sleeping = true。 */
export interface SleepRequestResult {
  name: string;
  state: string;
  accepted: true;
  sleeping: boolean;
  pending: boolean;
}

export interface Resessioner {
  /**
   * session を眠らせる依頼（session_sleep の入口）。眠っている・未定義・config 由来の session は sleepNow（引継ぎ無し）へ任せる（今までの扱い）。
   * 動いている session は安全確認を通し、引継ぎを頼む 1 行を入力に貼る。作業中（turn・subagent・background が動いている）を含め、通らなければ Stop を待たず理由つきで投げる（眠らせない。待ちの上限は置かない）。
   */
  requestSleep(session: string): Promise<SleepRequestResult>;
  /** 眠っている session を新しい会話で起こす起動の前に呼ぶ: 最初の入力で引継ぎを渡す印を付け、取り出しを始め、区切りの行を積む。 */
  armWake(session: string, handoff: SleepHandoffRef): void;
  /** armWake の印を外す（起こす起動に失敗した時）。 */
  disarmWake(session: string): void;
  /** session が自分のリセッションを申告する（tool session_resession）。安全確認を通らなければ投げる。 */
  request(session: string, handoff: string): Promise<ResessionResult>;
  /** hook の payload を見る（Stop で再起動、SessionStart で最初の入力）。同期で戻り、投げない。 */
  onHook(session: string, payload: unknown): void;
  /** リセッション待ちか（休止の判定などが見る）。 */
  pending(session: string): boolean;
  /** 保存した引継ぎの記録（file に保存した時だけ。memory に保存した時は無い）。無ければ undefined。 */
  record(session: string): HandoffRecord | undefined;
}

export interface ResessionDeps {
  /** session の今の状態（無ければ undefined）。 */
  info: (session: string) => SessionInfo | undefined;
  restartFresh: (session: string) => Promise<unknown>;
  /** 会話を止めて眠らせる（`sessions.sleep`）。ref 無しは引継ぎの無い眠り（眠っている・config 由来の session の扱いもここで決まる）。新しい会話は起動しない。 */
  sleepNow: (session: string, ref?: SleepHandoffRef) => Promise<unknown>;
  /** 引継ぎを渡し終えた時（スリープから起こした時だけ）。記録の sleepHandoff を外す先（`sessions.clearSleepHandoff`）。 */
  afterWakeDelivered?: (session: string, id: string) => Promise<unknown> | unknown;
  /** 引継ぎを memory に書き受理を待つ。memory の設定が無ければ "none"、届かなければ投げる。 */
  saveToMemory: (session: string, h: { id: string; body: string }) => Promise<"memory" | "none">;
  /**
   * 引継ぎの本文を memory から id で読む（`CenterMemoryEvents.readHandoff`）。設定が無ければ "none"、memory が無いと答えたら "missing"、
   * 届かない・拒否・待ちが過ぎたら投げる。待ちの上限はこの口の側が持つ（U13 の A。`deliver` に別の上限は持たない）。
   */
  readFromMemory: (session: string, id: string) => Promise<"none" | "missing" | { body: string }>;
  /** 取り出せなかった理由の文から除く値（外部記憶の url・token・header の値）。無ければ空。 */
  secretsOf?: (session: string) => string[];
  core: { push: (name: string, data: Buffer) => unknown; input: (name: string, data: Buffer) => boolean };
  /** 引継ぎの記録を置く dir（center の状態 dir の下）。 */
  dir: string;
  log: Logger;
  now?: () => number;
  /** 最初の入力の本文を送ってから Enter を送るまでの間（ms）。既定 400。 */
  submitDelayMs?: number;
  /** 再起動を始めるまでの間。既定は setImmediate（Stop の応答を返した後）。 */
  defer?: (fn: () => void) => void;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 最初の入力の本文。取り出せた時だけ引継ぎの本文（改行を含む）が入る。取り出せなかった時は 1 行（10.4）。 */
export function firstInputText(r: { id: string; stored: "memory" | "file"; session: string; file: string; result: Fetched; kind?: Kind }): string {
  // 先頭の語だけ kind で変える（リセッションの再起動 / スリープから起こした）。状況の確認の別の入力は付けない（引継ぎを読む事がその確認）
  const lead = r.kind === "wake" ? "スリープから起こした" : "リセッションで再起動した";
  if (r.result.ok) {
    const head = `[bantou] ${lead}（新しい会話。以前のやり取りは画面の上に表示だけ残っている）。`;
    return `${head}引継ぎ（id=${r.id}）の本文を渡す。common の [記録] の順に読んでから続きを進める。\n--- 引継ぎ ---\n${r.result.body}\n--- ここまで ---`;
  }
  const memoryPlace = `外部記憶（agent=${r.session}、eventId=${r.id}）`;
  const filePlace = `file ${r.file}`;
  const place = r.stored === "memory" ? `${memoryPlace}／${filePlace} には保存していない` : `${filePlace}／${memoryPlace} には保存していない`;
  return `[bantou] ${lead}（新しい会話）。引継ぎ（id=${r.id}）を取り出せなかった: ${r.result.reason}。置き場: ${place}。本文は渡していない。`;
}

export function createResessioner(deps: ResessionDeps): Resessioner {
  const { log } = deps;
  const now = deps.now ?? Date.now;
  const submitDelayMs = deps.submitDelayMs ?? 400;
  const defer = deps.defer ?? ((fn) => void setImmediate(fn));
  const marks = new Map<string, Mark>();
  const records = new Map<string, HandoffRecord>();
  const dirReady: { p?: Promise<void> } = {};

  const fileOf = (session: string): string => join(deps.dir, `${session}.json`);
  const writeRecord = async (r: HandoffRecord): Promise<void> => {
    dirReady.p ??= mkdir(deps.dir, { recursive: true, mode: 0o700 }).then(() => undefined);
    await dirReady.p;
    const tmp = `${fileOf(r.session)}.tmp`;
    await writeFile(tmp, JSON.stringify(r, null, 2), { mode: 0o600 });
    await rename(tmp, fileOf(r.session));
  };

  /** 保存先（stored）の側 1 つから本文を取り出す（10.3）。投げない。process 内に持った本文には頼らない。 */
  const fetchHandoff = async (session: string, mark: Mark): Promise<Fetched> => {
    try {
      if (mark.stored === "memory") {
        const r = await deps.readFromMemory(session, mark.id);
        if (r === "none") return { ok: false, reason: "外部記憶の設定が無い（または読む口が無い）" };
        if (r === "missing") return { ok: false, reason: "外部記憶に該当の引継ぎが無い" };
        if (typeof r.body !== "string" || r.body.trim() === "") return { ok: false, reason: "外部記憶の本文が空" };
        return { ok: true, body: r.body };
      }
      let rec: unknown;
      try {
        rec = JSON.parse(await readFile(fileOf(session), "utf8"));
      } catch (e) {
        return { ok: false, reason: `file を読めない（${(e as Error).message}）` };
      }
      const o = typeof rec === "object" && rec !== null ? (rec as Record<string, unknown>) : {};
      // 古い引継ぎを渡さない: file の id が印と同じ時だけ使う
      if (o.id !== mark.id) return { ok: false, reason: `file の id が違う（file=${str(o.id) ?? "なし"}）` };
      if (typeof o.body !== "string" || o.body.trim() === "") return { ok: false, reason: "file に本文が無い" };
      return { ok: true, body: o.body };
    } catch (e) {
      return { ok: false, reason: redactReason(e, deps.secretsOf?.(session) ?? []).replace(/https?:\/\/\S+/gi, "<url>") };
    }
  };

  const isStale = (m: Mark): boolean => m.phase === "awaiting-start" && now() - m.since > AWAIT_START_STALE_MS;

  /** 安全確認。通らなければ理由つきで投げる（設計 3.1 の C）。waitStop = Stop の後の見直し（idle であるべき）。 */
  const check = (session: string, atStop: boolean): void => {
    const s = deps.info(session);
    if (!s) throw new Error(`未定義の session: ${session}`);
    if (s.source !== "session") throw new Error("session_create で作った session だけがリセッションできる");
    if (s.sleeping || (s.state !== "starting" && s.state !== "connected")) throw new Error(`session が動いていない（state=${s.state}）`);
    if (s.activity === "needs-input") throw new Error("利用者の入力待ち（needs-input）の間はリセッションしない");
    if (atStop && s.activity !== "idle") throw new Error(`turn が終わっていない（activity=${s.activity}）`);
    if (s.remote.running > 0) throw new Error(`未完了の remote の指示が ${s.remote.running} 件ある。終わってから申告する`);
    if (s.remote.waitingReply > 0) throw new Error(`worker_reply が未返答の ask / approve が ${s.remote.waitingReply} 件ある。返答してから申告する`);
  };

  const run = async (session: string, mark: Mark): Promise<void> => {
    // 止める直前の見直し。利用者の入力が来て working になっていたら、会話が進んだので見送る（印を戻す。必要なら session がもう一度申告する）
    try {
      check(session, true);
    } catch (e) {
      marks.delete(session);
      log(`リセッション見送り: session=${session} id=${mark.id} ${(e as Error).message}`);
      return;
    }
    mark.phase = "restarting";
    try {
      deps.core.push(session, Buffer.from(RESESSION_DIVIDER));
    } catch (e) {
      log(`リセッションの区切りを積めない（続行）: session=${session} ${(e as Error).message}`);
    }
    // 起動し直す間に届く SessionStart を取りこぼさないよう、先に待ちの状態にする
    mark.phase = "awaiting-start";
    mark.since = now();
    // 取り出しは再起動と並行して進める（再起動は待たない）。結果は deliver が待つ
    mark.fetched = fetchHandoff(session, mark);
    try {
      await deps.restartFresh(session);
      log(`リセッション再起動: session=${session} id=${mark.id} stored=${mark.stored}`);
    } catch (e) {
      marks.delete(session);
      log(`リセッションの再起動に失敗: session=${session} id=${mark.id} ${e instanceof Error ? e.message : String(e)}（引継ぎは保存済み。元の会話は残る）`);
    }
  };

  /** 本文は bracketed paste で 1 回の貼り付けとして入れ、Enter は少し置いて別に送る（改行で途中の確定をさせない）。入れられなければ投げる。 */
  const pasteInput = async (session: string, text: string): Promise<void> => {
    if (!deps.core.input(session, Buffer.from(`\u001b[200~${text}\u001b[201~`))) throw new Error("session が実行中でない");
    await sleep(submitDelayMs);
    if (!deps.core.input(session, Buffer.from("\r"))) throw new Error("session が実行中でない");
  };

  const deliver = async (session: string, mark: Mark): Promise<void> => {
    marks.delete(session);
    const result = await (mark.fetched ?? fetchHandoff(session, mark));
    const what = mark.kind === "wake" ? "スリープの起床" : "リセッション";
    if (!result.ok) log(`${what}の引継ぎを取り出せない: session=${session} id=${mark.id} stored=${mark.stored} ${result.reason}`);
    const text = firstInputText({ id: mark.id, stored: mark.stored, session, file: fileOf(session), result, kind: mark.kind });
    try {
      await pasteInput(session, text);
      const rec = records.get(session);
      if (result.ok && rec && rec.id === mark.id) {
        const done = { ...rec, deliveredAt: new Date(now()).toISOString() };
        await writeRecord(done).then(() => void records.set(session, done), () => {});
      }
      log(`${what}の最初の入力を送った: session=${session} id=${mark.id} stored=${mark.stored} fetched=${result.ok}`);
    } catch (e) {
      log(`${what}の最初の入力を送れない: session=${session} id=${mark.id} ${e instanceof Error ? e.message : String(e)}`);
    }
    // 渡し終えた（取り出せなかった時も。U5 の B）。スリープの引継ぎの参照を記録から外す
    if (mark.kind === "wake") {
      try {
        await deps.afterWakeDelivered?.(session, mark.id);
      } catch (e) {
        log(`スリープの引継ぎの参照を外せない: session=${session} id=${mark.id} ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };

  /** 眠らせる側の Stop 後の実行。見直し（check(true)）→ 停止（新しい会話は起動しない）。 */
  const runSleep = async (session: string, mark: Mark): Promise<void> => {
    try {
      check(session, true);
    } catch (e) {
      marks.delete(session);
      log(`スリープ見送り: session=${session} id=${mark.id} ${(e as Error).message}`);
      return;
    }
    try {
      await deps.sleepNow(session, { id: mark.id, stored: mark.stored });
      log(`スリープ（停止。新しい会話は起動しない）: session=${session} id=${mark.id} stored=${mark.stored}`);
    } catch (e) {
      log(`スリープに失敗: session=${session} id=${mark.id} ${e instanceof Error ? e.message : String(e)}（引継ぎは保存済み）`);
    }
    marks.delete(session);
  };

  /** 引継ぎを頼む 1 行を入力に貼る（asking にしてから）。入れられなければ印を外して投げる。 */
  const ask = async (session: string, mark: Mark): Promise<void> => {
    try {
      await pasteInput(session, SLEEP_ASK_TEXT);
      log(`スリープの引継ぎを頼んだ: session=${session}`);
    } catch (e) {
      if (marks.get(session) === mark) marks.delete(session);
      throw e;
    }
  };

  return {
    async requestSleep(session) {
      const s = deps.info(session);
      // 未定義・config 由来・すでに眠っている session は、今までの扱い（sleep が拒否する / 何もしない）に任せる。引継ぎは頼まない
      if (!s || s.source !== "session" || s.sleeping) {
        const r = (await deps.sleepNow(session)) as Partial<SessionInfo> | undefined;
        const after = deps.info(session);
        return { name: session, state: String(r?.state ?? after?.state ?? ""), accepted: true, sleeping: (r?.sleeping ?? after?.sleeping) === true, pending: false };
      }
      // 断る理由は全部 SLEEP_REFUSED_PREFIX を付けて投げる（呼び手へ必ず通る）。ask の失敗など、断りでない物は付けない
      const refuse = (reason: string): never => {
        throw new Error(SLEEP_REFUSED_PREFIX + reason);
      };
      const cur = marks.get(session);
      if (cur && !isStale(cur)) refuse("すでにリセッション・スリープの途中（申告済み・依頼済み）");
      // 安全確認（作業中・needs-input・remote 未完了・未返答・動いていない session は断る。理由は呼び出し元へ返る。眠らせない。Stop は待たない）
      try {
        check(session, false);
      } catch (e) {
        refuse(e instanceof Error ? e.message : String(e));
      }
      if (s.activity === "working" || s.background.subagents > 0 || s.background.tasks > 0) refuse("作業中は眠らせられない（turn・subagent・background が動いている。終わってから）");
      const mark: Mark = { kind: "sleep", id: "", stored: "memory", phase: "asking", since: now() };
      marks.set(session, mark);
      await ask(session, mark);
      log(`スリープの依頼を受理: session=${session}`);
      return { name: session, state: s.state, accepted: true, sleeping: false, pending: true };
    },

    armWake(session, handoff) {
      const mark: Mark = { kind: "wake", id: handoff.id, stored: handoff.stored, phase: "awaiting-start", since: now() };
      // 起動の前に印と取り出しを始める（SessionStart を取りこぼさない。取り出しは起動と並行）
      mark.fetched = fetchHandoff(session, mark);
      marks.set(session, mark);
      try {
        deps.core.push(session, Buffer.from(WAKE_DIVIDER));
      } catch (e) {
        log(`起床の区切りを積めない（続行）: session=${session} ${(e as Error).message}`);
      }
      log(`スリープの起床を待つ: session=${session} id=${handoff.id} stored=${handoff.stored}`);
    },

    disarmWake(session) {
      if (marks.get(session)?.kind === "wake") marks.delete(session);
    },

    async request(session, handoff) {
      if (handoff.trim() === "") throw new Error("handoff（引継ぎの本文）が空");
      if (handoff.includes("\0")) throw new Error("handoff に NUL 文字を含められない");
      if (handoff.length > MEMORY_BODY_MAX) throw new Error(`handoff が長すぎる（${MEMORY_BODY_MAX} 文字まで）。要点に絞る`);
      check(session, false);
      const cur = marks.get(session);
      // スリープの引継ぎを頼んでいる間（asking）の呼びは、眠らせる為の引継ぎとして受ける。それ以外で印があれば途中
      const asking = cur?.kind === "sleep" && cur.phase === "asking" ? cur : undefined;
      if (cur && !asking && !isStale(cur)) throw new Error(cur.kind === "sleep" ? "すでにスリープの途中（依頼済み。turn を終えると眠る）" : "すでにリセッションの途中（申告済み。turn を終えると再起動する）");
      const at = now();
      const id = makeEventIdWith(sha256, "c1", session, "handoff", at, digest8With(sha256, handoff));
      let stored: "memory" | "file";
      try {
        stored = (await deps.saveToMemory(session, { id, body: handoff })) === "memory" ? "memory" : "file";
      } catch (e) {
        log(`引継ぎを memory に書けない。file に残す: session=${session} id=${id} ${e instanceof Error ? e.message : String(e)}`);
        stored = "file";
      }
      // file は memory に保存できなかった時だけ書く（10.2。U11 の A）。file にも書けなければ、引継ぎを失うので断る
      if (stored === "file") {
        const rec: HandoffRecord = { id, session, at: new Date(at).toISOString(), stored, body: handoff };
        try {
          await writeRecord(rec);
        } catch (e) {
          throw new Error(`引継ぎを保存できない（memory に届かず、file にも書けない）: ${(e as Error).message}`);
        }
        records.set(session, rec);
      }
      // 保存の間に状況が変わっていないか見直してから印を付ける（await の間に別の申告・needs-input があり得る）
      check(session, false);
      const again = marks.get(session);
      if (asking) {
        // 頼んだ印のまま（保存の間に取り消し・上書きされていない）の時だけ受ける
        if (again !== asking) throw new Error("スリープの依頼が取り消された（引継ぎは保存済み）");
        marks.set(session, { kind: "sleep", id, stored, phase: "waiting-stop", since: at });
        log(`スリープの引継ぎを受理: session=${session} id=${id} stored=${stored} bytes=${handoff.length}`);
        return { accepted: true, handoff_id: id, stored, restart: "このあと turn を終えると center がこの session を止めて眠らせる（新しい会話はすぐには起動しない。起こした時に引継ぎが最初の入力で渡る）。短く眠ると言って turn を終える" };
      }
      if (again && !isStale(again)) throw new Error("すでにリセッションの途中（申告済み）");
      marks.set(session, { kind: "restart", id, stored, phase: "waiting-stop", since: at });
      log(`リセッション申告を受理: session=${session} id=${id} stored=${stored} bytes=${handoff.length}`);
      return { accepted: true, handoff_id: id, stored, restart: "このあと turn を終えると center が新しい会話で起動し直す。短く再起動すると言って turn を終える" };
    },

    onHook(session, payload) {
      try {
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
        const p = payload as Record<string, unknown>;
        const name = str(p.hook_event_name);
        const mark = marks.get(session);
        if (!mark) return;
        if (mark.kind === "sleep" && mark.phase === "asking") {
          // 依頼の 1 行が入って turn が始まった（印）。その turn が session_resession を呼ばずに終わった（Stop）なら、依頼は流れた。印を外して次の session_sleep を受けられるようにする（期限は置かない）。入る前の Stop（前の turn の遅れた物）では外さない
          if (name === "UserPromptSubmit") mark.prompted = true;
          else if (name === "Stop" && mark.prompted) {
            marks.delete(session);
            log(`スリープの依頼が流れた（引継ぎを渡さず turn が終わった）: session=${session}`);
          }
          return;
        }
        if (name === "UserPromptSubmit" && mark.phase === "waiting-stop") {
          // 申告の後に利用者の入力が来て会話が進んだ（Stop が来ないまま後の turn が走りうる）。古い引継ぎで再起動しないよう印を戻す（3.3 の 4 の「利用者の入力で working に戻ったら印を戻して見送る」と同じ扱い。必要なら session がもう一度申告する）
          marks.delete(session);
          log(`リセッション見送り（申告の後に利用者の入力）: session=${session} id=${mark.id}`);
          return;
        }
        if (name === "Stop" && mark.phase === "waiting-stop") {
          // Stop は同期の hook。ここでは印を立てるだけにして、止める・起動するのは応答を返した後（defer）に行う
          mark.phase = "restarting";
          const exec = mark.kind === "sleep" ? runSleep : run;
          defer(() => void exec(session, mark).catch((e) => log(`${mark.kind === "sleep" ? "スリープ" : "リセッション"}の実行で例外: session=${session} ${e instanceof Error ? e.message : String(e)}`)));
          return;
        }
        if (name === "SessionStart" && mark.phase === "awaiting-start" && str(p.source) === "startup") {
          void deliver(session, mark);
        }
      } catch (e) {
        log(`リセッションの hook 処理で例外: session=${session} ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    pending: (session) => {
      const m = marks.get(session);
      return m !== undefined && !isStale(m);
    },
    record: (session) => records.get(session),
  };
}
