import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SESSION_NAME, type SessionInfo } from "./sessions.js";
import { MAX_SESSION_NAME } from "./center-id.js";
import { SESSION_INSTRUCTIONS_MAX } from "./config.js";

/** session_brief: 1 行の文字数・1 回の行数・1 回の文字数の上限（設計書 14.3 (3)）。 */
export const SESSION_BRIEF_LINE_MAX = 200;
export const SESSION_BRIEF_MAX_LINES = 40;
export const SESSION_BRIEF_MAX_CHARS = 6000;

/** 統括の自分の行に警告を足すしきい値（実行中がこの数以上、または返答待ちがこの数以上）。 */
export const COORDINATOR_WARN_RUNNING = 2;
export const COORDINATOR_WARN_WAITING = 1;

export interface SessionBriefLine {
  name: string;
  line: string;
}

export interface SessionBriefResult {
  at: string;
  sessions: SessionBriefLine[];
  /** 行数・文字数の上限で落とした行があれば true。 */
  truncated: boolean;
  /** 落とした行の数。 */
  omitted: number;
}

const STATE_LABEL: Record<SessionInfo["state"], string> = { starting: "起動中", connected: "接続", stopped: "停止", error: "error" };
/** スリープ中の session の状態ラベル（state は stopped のまま。停止と区別する）。 */
export const SLEEP_LABEL = "スリープ";

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

const minutesSince = (iso: string | null, now: number): number | null => {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((now - t) / 60_000));
};

/**
 * session ごとに 1 行にする。入るのは名前・状態・件数・時刻だけ。
 * 報告の本文・result・指示の本文・path・URL・error の文は入れない（SessionInfo のそれらの項目は読まない）。
 * P1・P5 の前なので「直近の利用者の指示」「渡し待ち」の欄は出さない。
 */
export function buildSessionBrief(sessions: readonly SessionInfo[], coordinator: string, now: number, filter?: { session?: string }): SessionBriefResult {
  const rows = sessions.filter((s) => filter?.session === undefined || s.name === filter.session);
  const lines: SessionBriefLine[] = [];
  const at = new Date(now).toISOString();
  for (const s of rows) {
    const since = s.activity === "unknown" ? null : minutesSince(s.activityAt, now);
    const work = s.activity === "unknown" ? "作業状態 不明" : `${s.activity}${since === null ? "" : ` ${since} 分`}`;
    const ctx = s.contextUsage?.percent;
    const unreachable = s.remote.unreachable?.length ?? 0;
    const lost = s.remote.lost?.length ?? 0;
    const parts = [
      s.name,
      s.sleeping ? SLEEP_LABEL : STATE_LABEL[s.state],
      work,
      `ctx ${ctx === null || ctx === undefined ? "?" : `${Math.round(ctx)}%`}`,
      `remote 実行中 ${s.remote.running}・返答待ち ${s.remote.waitingReply}・到達不能 ${unreachable}・lost ${lost}`,
    ];
    if (s.name === coordinator && (s.remote.running >= COORDINATOR_WARN_RUNNING || s.remote.waitingReply >= COORDINATOR_WARN_WAITING)) {
      parts.push(`警告: 自分の project の作業が多い（remote 実行中 ${s.remote.running}・返答待ち ${s.remote.waitingReply}）`);
    }
    const line = clip(parts.join(" | "), SESSION_BRIEF_LINE_MAX);
    if (lines.length >= SESSION_BRIEF_MAX_LINES) break;
    // 返り値全体（name の二重・構造・truncated / omitted も含む、整形ありの JSON）で測る。
    const candidate: SessionBriefResult = { at, sessions: [...lines, { name: s.name, line }], truncated: true, omitted: rows.length };
    if (JSON.stringify(candidate, null, 2).length > SESSION_BRIEF_MAX_CHARS) break;
    lines.push({ name: s.name, line });
  }
  const omitted = rows.length - lines.length;
  return { at, sessions: lines, truncated: omitted > 0, omitted };
}

/** 統括の道具が使う、center の情報の取得元。呼ばれるたびに今の値を取る（キャッシュしない）。 */
export interface CoordinatorDeps {
  /** 今の全 session（center の session_list）。 */
  sessions: () => Promise<SessionInfo[]>;
  /** 新しい session を作る（center の session_create。path は渡さない = center の workspace の下だけ）。 */
  createSession: (input: { name: string; instructions?: string; start: boolean }) => Promise<{ name: string; state: string }>;
  /** 他の session をスリープさせる（center の session_sleep）。 */
  sleepSession: (name: string) => Promise<{ name: string; state: string; sleeping: boolean }>;
  now?: () => number;
  /** 呼び手の session 名（header X-Bantou-Session。center が session の統括の項目に足す。分からない呼び手は無し）。自分自身を眠らせるのを断るのに使う。 */
  caller?: string;
  /** 失敗の詳細を残す先（log）。省略時は残さない。 */
  log?: (msg: string) => void;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const json = (value: unknown, isError = false): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) });

/** 同名の拒否の文（center の SessionManager.create の文言）。利用者が直せるのでそのまま返す。 */
const nameTaken = (name: string, detail: string): boolean => detail.includes(`name が既に使われている: ${name}`);

/** 統括の道具を登録する。呼び手の確認は server の入口（header の Bearer）で済んでいる。 */
export function registerCoordinatorTools(server: McpServer, deps: CoordinatorDeps): void {
  server.registerTool(
    "session_brief",
    {
      title: "各 session の状態を 1 行で読む",
      description:
        `各 session の状態を 1 行ずつ返す。返り値 { at, sessions: [{ name, line }], truncated, omitted }。line は \`<name> | <起動の状態: 起動中 / 接続 / 停止 / スリープ / error> | <作業状態: working / needs-input / idle と、その時刻からの分。不明の時は「作業状態 不明」> | ctx <n>% | remote 実行中 <n>・返答待ち <n>・到達不能 <n>・lost <n>\`。件数だけで、report・result・指示の本文は入らない。中身が要る時は各 session の担当に任せる。1 行 ${SESSION_BRIEF_LINE_MAX} 文字・1 回 ${SESSION_BRIEF_MAX_LINES} 行・${SESSION_BRIEF_MAX_CHARS} 文字まで（越えたら truncated: true と omitted = 落とした行数）。session で 1 つに絞れる`,
      inputSchema: { session: z.string().min(1).optional() },
    },
    async ({ session }) => {
      let all: SessionInfo[];
      try {
        all = await deps.sessions();
      } catch (e) {
        deps.log?.(`session_brief 失敗: ${e instanceof Error ? e.message : String(e)}`);
        return json({ error: "center から session の一覧を取れなかった。詳細は log" }, true);
      }
      if (session !== undefined && !all.some((s) => s.name === session)) return json({ error: `未定義の session: ${session}` }, true);
      return json(buildSessionBrief(all, "", (deps.now ?? Date.now)(), session !== undefined ? { session } : undefined));
    },
  );
  server.registerTool(
    "coordinator_session_create",
    {
      title: "新しい project の session を立てる",
      description:
        "新しい project の session（master-cap）を center の workspace の下に作る。name は英数字と _ - のみ・64 文字以内。同じ名前の session が在れば断る。作業 dir は <workspace>/<name> に決まり、path は指定できない。instructions はその session の最初の追加指示（省略可）。start = false で作るだけにする（既定は起動する）。center 共通の設定（追加の指示など）は desktop の追加と同じに効く。既存の session の削除・変更はできない。返り値 { name, state }",
      inputSchema: {
        name: z.string().max(MAX_SESSION_NAME, `${MAX_SESSION_NAME} 文字以内`).regex(SESSION_NAME, "英数字と _ - のみ"),
        instructions: z.string().max(SESSION_INSTRUCTIONS_MAX, `${SESSION_INSTRUCTIONS_MAX} 文字以内`).optional(),
        start: z.boolean().optional(),
      },
    },
    async ({ name, instructions, start }) => {
      try {
        const created = await deps.createSession({ name, ...(instructions ? { instructions } : {}), start: start ?? true });
        return json({ name: created.name, state: created.state });
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        // 利用者が直せる同名の拒否だけ文を返す。それ以外は一般化し、詳細は log にだけ残す
        if (nameTaken(name, detail)) return json({ error: `name が既に使われている: ${name}` }, true);
        deps.log?.(`coordinator_session_create 失敗: name=${name} ${detail}`);
        return json({ error: "session を作れなかった（名前の衝突、または作業 dir を作れない）。詳細は log" }, true);
      }
    },
  );
  server.registerTool(
    "coordinator_session_sleep",
    {
      title: "他の session をスリープさせる",
      description:
        "name の session をスリープさせる（claude の process を止めてメモリなどを空ける。会話・設定・remote の記録は残る）。眠った session は、利用者が desktop で開いた時と、messenger でその session が宛先になった時に、元の会話のまま自動で起き直す。session_brief には「スリープ」と出る。すでに眠っている session には何もしない。呼んだ session 自身は眠らせられない（断る）。返り値 { name, state, sleeping }",
      inputSchema: { name: z.string().max(MAX_SESSION_NAME, `${MAX_SESSION_NAME} 文字以内`).regex(SESSION_NAME, "英数字と _ - のみ") },
    },
    async ({ name }) => {
      // 眠らせるのは「他の session」。呼んだ session 自身は断る
      if (deps.caller !== undefined && deps.caller === name) return json({ error: `自分自身はスリープさせられない（他の session だけ）: ${name}` }, true);
      try {
        const r = await deps.sleepSession(name);
        return json({ name: r.name, state: r.state, sleeping: r.sleeping });
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        // 利用者が直せる拒否（未定義・config 由来）だけ文を返す。それ以外は一般化し、詳細は log にだけ残す
        if (detail.includes("未定義の session") || detail.includes("config 由来")) return json({ error: detail }, true);
        deps.log?.(`coordinator_session_sleep 失敗: name=${name} ${detail}`);
        return json({ error: "session をスリープさせられなかった。詳細は log" }, true);
      }
    },
  );
}
