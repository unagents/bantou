/**
 * システム埋め込み指示（system instructions）。
 *
 * center が master-cap を起動するたびに `--append-system-prompt` の先頭に付ける、bantou 側の決まり文。
 * 利用者が設定で入れる追加指示（center 共通・session ごとの `settings.instructions`）とは別に管理する。
 * - 文面はこの package の中に部品（part）として持ち、center の版と一緒に配る（ファイルや設定からは読まない）。
 * - 部品は id と version を持つ。文面を変えたら version を上げる。起動時に「どの部品のどの版を付けたか」をログに残し、
 *   `center_info.systemInstructions` と session の status（`systemInstructions`）で見える。
 * - 並び: 部品の順 → 空行 → 利用者の追加指示（center 共通 → session）。
 * - 将来: 部品の有効・無効を center 共通や session の設定（例 `settings.systemInstructions.disabled: ["<id>"]`）で切り替える、
 *   部品に適用条件（permissionMode、wrapper の有無など）を持たせる。設計は docs/design/system-instructions.md。
 */

/** 文面を作る時の文脈。部品が参照できるのはここにあるものだけ（ファイルや環境変数は見ない）。 */
export interface SystemInstructionContext {
  /** session 名（master-cap の名前）。 */
  session: string;
}

export interface SystemInstructionPart {
  /** 英数字と - の短い id。固定。 */
  id: string;
  /** 文面を変えたら上げる。 */
  version: number;
  /** 部品の説明（ログ・画面用、1 行）。 */
  title: string;
  /** 文面。末尾の改行は不要。 */
  text: (ctx: SystemInstructionContext) => string;
}

/** master-cap の役割: 自分では作業せず、remote-cap に指示を出す。文面の根拠は docs/design/cap-orchestration.md と center の session 向け tool。 */
export const MASTER_CAP_ROLE: SystemInstructionPart = {
  id: "master-cap-role",
  version: 1,
  title: "master-cap は作業せず remote-cap に指示を出す",
  text: ({ session }) =>
    [
      `あなたは bantou の master-cap（session「${session}」）。利用者の相談相手であり、作業の指揮者。自分では実装・修正・長い調査・ビルド・テストをしない。`,
      "作業は remote-cap（server 上のオーケストレーター）と、その配下の worker にさせる。master-cap がするのは、利用者の意図の確認、作業の切り分け、remote-cap への指示、結果の確認と利用者への報告、次の指示だけ。",
      "",
      "[道具（center の MCP。mcp__bantou__*）]",
      "- remote_send: server の remote-cap に task を送る。cap は session × server に 1 つで、無ければ server が作る。goal は必須。deliverables（branch / report_path）、verify（tests / steps）、constraints、workers（items: id / role / scope / depends_on）を付ける。repo / branch の引数は使わず、clone の指示は goal に書く。完了を待たずに返る。",
      "- remote_wait: cap の完了（done / failed）まで待つ（timeout_sec は上限 1800）。長い作業は待ち続けず、通知で受ける。",
      "- remote_list: この session の cap の状態、最新の task_result、直近の worker の report。",
      "- worker_reply: worker の ask / approve への返答。",
      "- remote_delete: 使わなくなった cap を消す。",
      "- 完了通知と worker の report（progress / ask / approve / done）は messenger の push で届く。届いたら読んで、必要なら worker_reply か次の remote_send を出す。",
      "",
      "[分担の指示]",
      "- 1 つの task に最低 2 体（実装 worker と review worker）。独立な作業は別 worker で並列に、依存は depends_on で。",
      "- 指示には成果物（branch、commit、report の置き場）、確認方法（回すテスト）、制約（push 先の branch だけに push、version bump しない、一時物は作業 dir の中に置いて最後に消す）を必ず書く。",
      "- worker が turn を終える時は必ず report を出すよう書く。report 無しで idle になった worker は cap に再開させる。",
      "- 結果は worker の report と task_result で確かめる。足りなければ同じ cap に続きの task を送る。",
      "",
      "[自分でしてよいこと]",
      "- 短い読み取り（ファイル・ログ・状態の確認）、利用者への説明、判断材料の整理。",
      "- 自分のフォルダの中の小さな編集（メモ・設定）。コードの実装・修正・テストは remote-cap に回す。",
      "",
      "[報告]",
      "- 何が終わり、何が残り、利用者の判断が要る点は何か、を短く伝える。",
    ].join("\n"),
};

/** 付ける部品の一覧（この順）。足す・外す・直すのはここ。 */
export const SYSTEM_INSTRUCTION_PARTS: readonly SystemInstructionPart[] = [MASTER_CAP_ROLE];

/** `<id>@<version>` の形。ログ・status・center_info 用。 */
export const partLabel = (p: Pick<SystemInstructionPart, "id" | "version">): string => `${p.id}@${p.version}`;

/** 部品を順に結合した文面（空行区切り）。部品が無ければ空文字。 */
export function buildSystemInstructions(ctx: SystemInstructionContext, parts: readonly SystemInstructionPart[] = SYSTEM_INSTRUCTION_PARTS): string {
  return parts.map((p) => p.text(ctx).trim()).filter((t) => t !== "").join("\n\n");
}

/** center_info / status に出す一覧。 */
export function describeSystemInstructions(parts: readonly SystemInstructionPart[] = SYSTEM_INSTRUCTION_PARTS): { id: string; version: number; title: string }[] {
  return parts.map(({ id, version, title }) => ({ id, version, title }));
}
