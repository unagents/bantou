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
  /** 外部記憶（settings.memory）がある session か。省略 = false。 */
  memory?: boolean;
}

export interface SystemInstructionPart {
  /** 英数字と - の短い id。固定。 */
  id: string;
  /** 文面を変えたら上げる。 */
  version: number;
  /** 部品の説明（ログ・画面用、1 行）。 */
  title: string;
  /** 付ける条件。省略 = 常に付ける。false を返す文脈では文面もログ・status の label も出ない。 */
  when?: (ctx: SystemInstructionContext) => boolean;
  /** 文面。末尾の改行は不要。 */
  text: (ctx: SystemInstructionContext) => string;
}

/** master-cap の役割: 自分では作業せず、remote-cap に指示を出す。文面の根拠は docs/design/cap-orchestration.md と center の session 向け tool。 */
export const MASTER_CAP_ROLE: SystemInstructionPart = {
  id: "master-cap-role",
  version: 2,
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
      "- 完了通知と worker の report（ask / approve / done）は messenger の push で届く。届いたら読んで、必要なら worker_reply か次の remote_send を出す。progress は push されない。進捗は remote_list で見る。",
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

/** master-cap の待機: 利用者の指示をいつでも受けられる状態を保つ。時間のかかる作業は預け、完了は通知で受ける。 */
export const MASTER_CAP_AVAILABILITY: SystemInstructionPart = {
  id: "master-cap-availability",
  version: 1,
  title: "master-cap は常に利用者の指示を受けられる状態で働き、時間のかかる作業は預ける",
  text: () =>
    [
      "[常に指示を受けられる状態]",
      "- master-cap は、利用者の指示をいつでも受けられる状態で働く。自分の turn を長く塞ぐ作業（ビルド、テスト、release、長い待ち、長い調査）はしない。",
      "- 時間のかかる作業は預ける。まず remote-cap（remote_send）。",
      "- この Mac のローカルでしかできない作業（例: release の署名ビルドや publish、ローカルの鍵や道具が要るもの）は、上の「自分では実装・ビルド・テストをしない」の例外として、ローカルのサブエージェント（Agent tool）か background 実行（Bash の run_in_background）に任せる。自分は結果の通知を待つ。",
      "- 待つ時は turn を終えて通知で受ける。remote_wait や長い foreground の command で turn を塞がない。",
      "- 預けた作業が動いている間も、利用者の新しい指示には普通に応える。並行の指示が、動いている作業と独立なら、すぐ別の worker / サブエージェントへ出す。",
      "- 預けた作業の完了・失敗は通知（task_result、worker の report、background の完了）で受ける。結果を確かめてから、利用者に短く報告する。",
      "- 利用者の判断が要る点が出たら、他にできる事を先に進めてから聞く。",
    ].join("\n"),
};

/**
 * 外部記憶（memory）の使い方: 起動時と判断の前に context / recall を呼ぶ。書き込みは bantou が自動で渡すので自分では呼ばない。
 * 設計は docs/design/external-memory.md。memory の設定がある session だけに付く。
 */
export const MEMORY_USAGE: SystemInstructionPart = {
  id: "memory",
  version: 1,
  title: "外部記憶（memory）の設定がある session だけ: 起動時と判断の前に context / recall を呼ぶ",
  when: (ctx) => ctx.memory === true,
  text: () =>
    [
      "[外部記憶（memory）]",
      "- この session には外部記憶の MCP（mcp__memory__*）が付いている。",
      "- 起動した時と、判断する前に、mcp__memory__ の context / recall を呼んで、過去の経緯・決定・好みを確かめる。",
      "- 記憶への書き込みは bantou が会話と cap 間の往復から自動で渡す。自分では書き込みの tool を呼ばない。",
    ].join("\n"),
};

/** 付ける部品の一覧（この順）。足す・外す・直すのはここ。`when` を持つ部品は文脈に合う session だけに付く。 */
export const SYSTEM_INSTRUCTION_PARTS: readonly SystemInstructionPart[] = [MASTER_CAP_ROLE, MASTER_CAP_AVAILABILITY, MEMORY_USAGE];

/** 文脈に合う部品（`when` が無いか true を返すもの）。順は元のまま。 */
export const applicableParts = (ctx: SystemInstructionContext, parts: readonly SystemInstructionPart[] = SYSTEM_INSTRUCTION_PARTS): SystemInstructionPart[] =>
  parts.filter((p) => p.when === undefined || p.when(ctx));

/** `<id>@<version>` の形。ログ・status・center_info 用。 */
export const partLabel = (p: Pick<SystemInstructionPart, "id" | "version">): string => `${p.id}@${p.version}`;

/** 部品を順に結合した文面（空行区切り）。部品が無ければ空文字。 */
export function buildSystemInstructions(ctx: SystemInstructionContext, parts: readonly SystemInstructionPart[] = SYSTEM_INSTRUCTION_PARTS): string {
  return applicableParts(ctx, parts).map((p) => p.text(ctx).trim()).filter((t) => t !== "").join("\n\n");
}

/** center_info / status に出す一覧。 */
export function describeSystemInstructions(parts: readonly SystemInstructionPart[] = SYSTEM_INSTRUCTION_PARTS): { id: string; version: number; title: string }[] {
  return parts.map(({ id, version, title }) => ({ id, version, title }));
}
