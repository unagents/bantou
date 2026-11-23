import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AGENT_ID_PATTERN, MODEL_PATTERN } from "@agent-hand/bantou-protocol";
import { z } from "zod";
import type { ChangeManager } from "./changes.js";
import { WAIT_DEFAULT_SEC, WAIT_MAX_SEC } from "./remotes.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const json = (value: unknown, isError = false): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

async function guard(fn: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, true);
  }
}

const noNul = (s: string): boolean => !s.includes("\0");
const noNulMsg = { message: "NUL 文字を含められない" };
const changeId = z.string().regex(AGENT_ID_PATTERN, "英数字と _ - のみ");

export const changeRegisterSchema = {
  change_id: changeId.describe("change の id（server 上で change を指す鍵）"),
  scope: z
    .array(z.string().min(1).refine(noNul, noNulMsg))
    .min(1)
    .describe("消化する step の範囲。順序つきの step の参照の配列（1 件以上）。server は配列の順に消化する。参照の中身は bantou は解釈せず、そのまま openspec-mcp に渡す"),
  repo: z.string().min(1).refine((s) => !s.startsWith("-"), { message: "- で始められない" }).refine(noNul, noNulMsg).describe("Git URL"),
  branch: z.string().min(1).refine((s) => !s.startsWith("-"), { message: "- で始められない" }).refine(noNul, noNulMsg).optional(),
  worker_model: z.string().regex(MODEL_PATTERN, "英数字と . _ [ ] - のみ（先頭は - 不可）").optional().describe("step の worker の --model の既定"),
  server: z.string().min(1).optional().describe("server の指定。server_id、host 名、peer id のどれでもよい。省略時は、この change を前に登録した server、無ければ protocol bantou で発見した先頭（session の servers の範囲内）"),
};

export const changeWaitSchema = {
  change_id: changeId.optional().describe("待つ change。省略時は in_progress の change のどれか"),
  timeout_sec: z.number().int().min(1).max(WAIT_MAX_SEC).optional().describe(`待つ秒数。既定 ${WAIT_DEFAULT_SEC}、上限 ${WAIT_MAX_SEC}。超えたら今の記録のまま返す`),
};

/**
 * change の tool（/mcp/session）。owner は呼び出し元 session（認証済み）で、引数では受けない。
 * 今の remote_send / remote_list / worker_reply / task_status とは別に足す（それらは変えない）。
 */
export function registerChangeTools(server: McpServer, deps: { changes: ChangeManager; owner: string }): void {
  const { changes, owner } = deps;

  server.registerTool(
    "change_register",
    {
      title: "change を server に登録",
      description:
        "server に change を、消化する step の範囲（scope）つきで登録する。server は登録を queue に溜め、資源を見て step ごとに worker を起こして順に消化する。登録は worker の完了を待たずに返る。再登録は completed / stopped の change に限る（in_progress の間は server が断る）。返り値 { change_id, server, peer, host?, state, accepted, notify_id }。server の error はそのまま isError で返す。worker の質問（change_report）と、change が止められた・範囲を終えた（change_progress）事は push で届く。質問への返答は change_reply",
      inputSchema: changeRegisterSchema,
    },
    (a) =>
      guard(async () =>
        json(
          await changes.register({
            owner,
            change_id: a.change_id,
            scope: a.scope,
            repo: a.repo,
            ...(a.branch ? { branch: a.branch } : {}),
            ...(a.worker_model ? { worker_model: a.worker_model } : {}),
            ...(a.server ? { server: a.server } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "change_list",
    {
      title: "change 一覧",
      description:
        "この session が登録した change の、center が持つ記録（server へは問い合わせない。最後に通知か change_status で分かった状態）。各要素: change_id, state（in_progress / completed / stopped）, waiting_reply（返答待ちの質問の数）, asks（worker の質問。replied_at が無く superseded_at も無いものが未返答）, progress（change_progress の最後の 1 件）, info（最後に change_status で取れた server の記録: step と steps[]）, server_label, scope, repo, branch。他の session の change は見えない。最新を server に聞くのは change_status",
      inputSchema: { change_id: changeId.optional() },
    },
    ({ change_id }) => guard(() => json(changes.list({ owner, ...(change_id ? { change_id } : {}) }))),
  );

  server.registerTool(
    "change_status",
    {
      title: "change の進みを照会",
      description:
        "server に change_status を送り、change の進み（state、現在の step の番号、steps[] の worker_id・session_id・状態）を取り直して返す。change_id 省略時はこの session の全ての change。返り値 { changes, boards }（boards は server の掲示: queue の長さと資源）。届かない server の change は error を付けて、最後に分かった記録のまま返す",
      inputSchema: { change_id: changeId.optional() },
    },
    ({ change_id }) => guard(async () => json(await changes.status({ owner, ...(change_id ? { change_id } : {}) }))),
  );

  server.registerTool(
    "change_wait",
    {
      title: "change の完了・質問待ち",
      description: `change の state が completed / stopped になる、または worker の質問（返答待ち）が出るまで待って、その change の記録を返す。change_id 省略時は in_progress の change のどれか。timeout_sec（既定 ${WAIT_DEFAULT_SEC}、上限 ${WAIT_MAX_SEC}）を超えたら今の記録のまま返す。待ちは center の tool で行う（shell の loop は作らない）`,
      inputSchema: changeWaitSchema,
    },
    ({ change_id, timeout_sec }) =>
      guard(async () => json(await changes.wait({ owner, ...(change_id ? { change_id } : {}), ...(timeout_sec !== undefined ? { timeoutSec: timeout_sec } : {}) }))),
  );

  server.registerTool(
    "change_stop",
    {
      title: "change を止める",
      description:
        "server の change を止める: 動いている worker を止め（process group kill）、queue の依頼を取り下げ、change を stopped にする。返り値 { change_id, stopped }。動いている worker を止められなかった時は server の error を isError で返し、change の状態は変わらない",
      inputSchema: { change_id: changeId },
    },
    ({ change_id }) => guard(async () => json(await changes.stop({ owner, change_id }))),
  );

  server.registerTool(
    "change_reply",
    {
      title: "change の worker の質問へ返答",
      description:
        "change の worker の質問（change_report の ask / approve）に返答する。server が返答待ち（waiting_reply）の step の worker を同じ session で起こし直して text を渡す。受けて queue に積んだらすぐ返る。返り値 { change_id, worker_id, accepted }。worker が返答待ちでない・change_id が違う時は server の error を isError で返す",
      inputSchema: {
        change_id: changeId,
        worker_id: z.string().regex(AGENT_ID_PATTERN, "英数字と _ - のみ").describe("返答する worker（change_report の worker_id）"),
        text: z.string().min(1).refine(noNul, noNulMsg).describe("worker への返答（ask への回答、approve の承認・却下など）"),
      },
    },
    ({ change_id, worker_id, text }) => guard(async () => json(await changes.reply({ owner, change_id, worker_id, text }))),
  );
}
