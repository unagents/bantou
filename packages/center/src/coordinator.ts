import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SessionInfo } from "./sessions.js";

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
  let chars = 0;
  for (const s of rows) {
    const since = s.activity === "unknown" ? null : minutesSince(s.activityAt, now);
    const work = s.activity === "unknown" ? "作業状態 不明" : `${s.activity}${since === null ? "" : ` ${since} 分`}`;
    const ctx = s.contextUsage?.percent;
    const unreachable = s.remote.unreachable?.length ?? 0;
    const lost = s.remote.lost?.length ?? 0;
    const parts = [
      s.name,
      STATE_LABEL[s.state],
      work,
      `ctx ${ctx === null || ctx === undefined ? "?" : `${Math.round(ctx)}%`}`,
      `remote 実行中 ${s.remote.running}・返答待ち ${s.remote.waitingReply}・到達不能 ${unreachable}・lost ${lost}`,
    ];
    if (s.name === coordinator && (s.remote.running >= COORDINATOR_WARN_RUNNING || s.remote.waitingReply >= COORDINATOR_WARN_WAITING)) {
      parts.push(`警告: 自分の project の作業が多い（remote 実行中 ${s.remote.running}・返答待ち ${s.remote.waitingReply}）`);
    }
    const line = clip(parts.join(" | "), SESSION_BRIEF_LINE_MAX);
    if (lines.length >= SESSION_BRIEF_MAX_LINES || chars + line.length > SESSION_BRIEF_MAX_CHARS) break;
    lines.push({ name: s.name, line });
    chars += line.length;
  }
  const omitted = rows.length - lines.length;
  return { at: new Date(now).toISOString(), sessions: lines, truncated: omitted > 0, omitted };
}

/** 統括の道具が使う、center の中の情報の取得元。呼ばれるたびに今の値を返す（キャッシュしない）。 */
export interface CoordinatorDeps {
  /** 今の統括の session 名（無効 = null）。 */
  session: () => string | null;
  /** 今の全 session。 */
  sessions: () => SessionInfo[];
  now?: () => number;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const json = (value: unknown, isError = false): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) });

/** 呼び出し元が今の統括の session でなければ断る結果（そうでなければ null）。MCP session は作り直しを待たずに設定が変わるので、道具ごとに呼ぶ。 */
export function refuseUnlessCoordinator(deps: CoordinatorDeps, owner: string): ToolResult | null {
  return deps.session() === owner ? null : json({ error: "この道具は統括の session だけが使える（coordinator.session の設定が無い、または別の session）" }, true);
}

/** 統括の session だけに出す道具を登録する（呼び出し側が owner = 今の統括の時だけ呼ぶ。処理でも設定を見直す）。 */
export function registerCoordinatorTools(server: McpServer, deps: CoordinatorDeps & { owner: string }): void {
  const { owner } = deps;
  server.registerTool(
    "session_brief",
    {
      title: "各 session の状態を 1 行で読む",
      description:
        `各 session の状態を 1 行ずつ返す（統括の session だけが使える）。返り値 { at, sessions: [{ name, line }], truncated, omitted }。line は \`<name> | <起動の状態: 起動中 / 接続 / 停止 / error> | <作業状態: working / needs-input / idle と、その時刻からの分。不明の時は「作業状態 不明」> | ctx <n>% | remote 実行中 <n>・返答待ち <n>・到達不能 <n>・lost <n>\`（自分の project の作業が多い時は末尾に警告）。件数だけで、report・result・指示の本文は入らない。中身が要る時は各 session の担当に任せる。1 行 ${SESSION_BRIEF_LINE_MAX} 文字・1 回 ${SESSION_BRIEF_MAX_LINES} 行・${SESSION_BRIEF_MAX_CHARS} 文字まで（越えたら truncated: true と omitted = 落とした行数）。session で 1 つに絞れる`,
      inputSchema: { session: z.string().min(1).optional() },
    },
    ({ session }) => {
      // 呼ばれた時にも設定を見直す（MCP session は center の再起動・TTL の後も古いまま使われうる）
      const refused = refuseUnlessCoordinator(deps, owner);
      if (refused) return refused;
      const all = deps.sessions();
      if (session !== undefined && !all.some((s) => s.name === session)) return json({ error: `未定義の session: ${session}` }, true);
      return json(buildSessionBrief(all, owner, (deps.now ?? Date.now)(), session !== undefined ? { session } : undefined));
    },
  );
}
