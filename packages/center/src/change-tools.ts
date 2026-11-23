import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AGENT_ID_PATTERN, MODEL_PATTERN } from "@agent-hand/bantou-protocol";
import { z } from "zod";
import type { ChangeManager } from "./changes.js";

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

/**
 * change の登録の tool（/mcp/session）。owner は呼び出し元 session（認証済み）で、引数では受けない。
 * 一覧・進み・待ちの tool は無い（master-cap が openspec-mcp で見る）。質問への返答と worker の停止は、今の worker_reply / worker_stop に
 * change_id を渡して行う。登録を remote_send に載せない理由: remote_send は cap（session × server に 1 つ）と task を前提に
 * （goal 必須・cap の記録・task の受付の観測）作ってあり、change は cap を持たず server の runner が step ごとに worker を起こすため。
 */
export function registerChangeTools(server: McpServer, deps: { changes: ChangeManager; owner: string }): void {
  const { changes, owner } = deps;

  server.registerTool(
    "change_register",
    {
      title: "change を server に登録",
      description:
        "server に change を、消化する step の範囲（scope）つきで登録する。server は登録を queue に溜め、資源を見て step ごとに worker を起こして順に消化する。登録は worker の完了を待たずに返る。再登録は completed / stopped の change に限る（in_progress の間は server が断る）。返り値 { change_id, server, peer, host?, state, accepted, notify_id }。server の error はそのまま isError で返す。worker の質問（worker_report の ask / approve。change_id つき）と、change が止められた・範囲を終えた（change_progress）事は push で届く。質問への返答は worker_reply（change_id を渡す）、worker を止めるのは worker_stop（change_id を渡す）。一覧・進みは openspec-mcp で見る",
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
}
