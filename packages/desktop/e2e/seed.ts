import type { Seed } from "./mock/bantou";

const DIR = "/mock/demo-ws";
const task = (id: string, title: string, status: string, order: number, tag: string, body = "") => ({
  id,
  path: `${DIR}/${title}.md`,
  title,
  status,
  order,
  tags: [tag],
  date: "2026-09-29",
  body,
});

/** Mirrors `fixtures/demo-ws`. The center is off here (the settings specs start from that). */
export const defaultSeed: Seed = {
  dir: DIR,
  tasks: [
    task("t-cr001", "スキルシート xlsx 取込の列マッピング", "Doing", 0, "careery", "xlsx の列を career md の frontmatter へ対応付ける。"),
    task("t-cr002", "ズーム時のレイアウト崩れ修正", "Todo", 0, "careery"),
    task("t-cr003", "0.2.2 リリース", "Done", 0, "careery"),
    task("t-sb001", "openspec change 一覧画面", "Doing", 0, "stroke-board"),
    task("t-sb002", "feature 作成ボタンの起点整理", "Todo", 0, "stroke-board"),
    task("t-sb003", "チケット検索", "Todo", 1, "stroke-board"),
    task("t-am001", "broker 冗長化（202 + Mac）", "Doing", 0, "agent-messenger"),
    task("t-rs001", "USB3 省電力の無効化", "Done", 0, "researcher"),
  ],
  // researcher is a tag only (the center does not list it) → never a row.
  sessions: ["agent-messenger", "careery", "stroke-board"],
  threads: [
    {
      task_id: "t-cr001",
      status: "waiting",
      request: {
        from_name: "careery",
        from_id: "",
        question: "xlsx の「期間」列の形式が混在している。取込時の扱いを決めてほしい。",
        options: [
          { label: "両形式をパースする", description: "取込漏れなし" },
          { label: "片方に正規化してから取込", description: "xlsx 側を事前修正" },
          { label: "パース失敗行はスキップして報告", description: "後で手直し" },
        ],
        received_at: "2026-09-29T09:12:00Z",
      },
      timeline: [
        {
          role: "session",
          text: "xlsx の「期間」列の形式が混在している。取込時の扱いを決めてほしい。",
          at: "2026-09-29T09:12:00Z",
        },
      ],
      agent_session_id: null,
      answer: null,
    },
  ],
};

/** The default board with the center on, so the sessions are listed by it (reachable). */
export const boardSeed: Seed = { ...defaultSeed, center: { enabled: true } };
