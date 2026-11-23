/**
 * worker の system prompt（--append-system-prompt-file で渡す）と、reply の起こし直しの prompt。
 * 本文に " -- " を含めない（ファイル渡しなので必須ではないが、argv 照合の前提としてテストで固定する）。
 */
import { COMMON_MD, WORKER_MD } from "./instructions.generated";

/** 基盤仕様の文面（instructions/*.md が正本。build の時に instructions.generated.ts へ取り込む。共通の文面は packages/center/instructions/common.md の 1 つだけ）。 */
export const COMMON_TEXT = COMMON_MD.trim();
export const WORKER_TEXT = WORKER_MD.trim();

export const WORKER_GUIDE = [
  "あなたは bantou の worker。cap から作業を任されている。",
  "終わる時（質問・承認の依頼・完了・失敗のどれでも）は、最後の返答を指定の JSON schema の形で返す。",
  '- 質問・承認の依頼: {"lastType":"message","status":"ask" か "request_approve","content":"文"}。返事が届くまでターンは止まり、返事で再開する',
  '- 完了・失敗: {"lastType":"report","status":"success" か "failed","content":"文"}',
  "lastType・status・content は全部必須。content には、結果の要約と、下の [終わる時] の報告に書く物を入れる。",
  "",
  COMMON_TEXT,
  "",
  WORKER_TEXT,
  "",
  "[一時物]",
  "一時物は作業 dir の中に置く。$TMPDIR（自分の path の tmp/）を使い、/tmp 直書きはしない。一時物の削除は Bash の rm でなく mcp__bantou__bash の rm（action: rm、paths は自分の path からの相対、dir は recursive: true）を使う。",
  "",
  "[常設の制約]",
  "bantou-server / bantou-center を install・起動・停止・再起動しない。必要なら最後の返答（lastType: message）で報告するだけにする。",
].join("\n");

/** reply（approve）の起こし直しの prompt。文の形は server が固定で持つ。 */
export const APPROVE_PROMPT = "承認された。依頼した内容を進める。";

/** reply（reject）の起こし直しの prompt。 */
export const REJECT_PROMPT = "却下された。依頼した内容は行わない。別の方法を考えるか、止まって報告する。";

/** reply（answer）で content が空の時の prompt（空の prompt では claude を起こせないため）。 */
export const EMPTY_ANSWER_PROMPT = "（空の回答）";

/** reply 1 つから起こし直しの prompt を作る。 */
export function replyPrompt(order: "answer" | "approve" | "reject", content?: string): string {
  if (order === "approve") return APPROVE_PROMPT;
  if (order === "reject") return REJECT_PROMPT;
  return content !== undefined && content.trim() !== "" ? content : EMPTY_ANSWER_PROMPT;
}
