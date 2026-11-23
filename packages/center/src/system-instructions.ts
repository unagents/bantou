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

import { COMMON_MD, MASTER_CAP_MD } from "./instructions.generated.js";
import { capSessionName } from "./session-name.js";

/** md（`[見出し]` の行で始まる節の並び）を、見出し → 節の本文（見出し行を含む）に分ける。 */
export function parseSections(md: string): Map<string, string> {
  const out = new Map<string, string>();
  let name: string | undefined;
  let lines: string[] = [];
  const flush = (): void => {
    if (name !== undefined) out.set(name, lines.join("\n").trim());
  };
  for (const line of md.split("\n")) {
    const m = /^\[(.+)\]$/.exec(line);
    if (m) {
      flush();
      name = m[1]!;
      lines = [line];
    } else lines.push(line);
  }
  flush();
  return out;
}

/** 文面の元（md）。共通の文面と master-cap の文面は instructions/*.md が正本で、build の時に instructions.generated.ts へ取り込む。 */
export const COMMON_SECTIONS = parseSections(COMMON_MD);
export const MASTER_CAP_SECTIONS = parseSections(MASTER_CAP_MD);

/** master-cap の節を 1 つ取る（extra を渡すと、その節の末尾に足す）。見出しが無ければ例外（md と部品のずれを build / test で見つける）。 */
function masterSection(name: string, extra: readonly string[] = []): string {
  const body = MASTER_CAP_SECTIONS.get(name);
  if (body === undefined) throw new Error(`master-cap.md に節が無い: ${name}`);
  return [body, ...extra].join("\n");
}

/** 文面を作る時の文脈。部品が参照できるのはここにあるものだけ（ファイルや環境変数は見ない）。 */
export interface SystemInstructionContext {
  /** session 名（内部の識別子）。文面に出す自分の名前は capSessionName(session)（実際に claude と messenger に付く名前）。 */
  session: string;
  /** 外部記憶（settings.memory）がある session か。省略 = false。 */
  memory?: boolean;
  /** 統括の MCP の server を指す項目が設定の mcpServers に在る session か。省略 = false。 */
  coordinator?: boolean;
  /** session 向けの窓口（tool session_resession）が付く session か。省略 = false。 */
  resession?: boolean;
  /** この session が使える server の範囲（session 設定 settings.servers。server の名前）。省略 = 全部（範囲の指定なし）。空配列 = どの server も使わない。 */
  servers?: string[];
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

/** bantou の基盤仕様のうち、3 層（master-cap・remote-cap・worker）に共通の決まり。文面の正本は instructions/common.md（server 側の指示文にも同じ文面が入る）。 */
export const BASE_SPEC: SystemInstructionPart = {
  id: "base-spec",
  version: 1,
  title: "bantou の基盤仕様（3 層に共通）: 体制・窓口・記録・権限・置き場・待ち",
  text: () => COMMON_MD.trim(),
};

/**
 * session の使う server の範囲（settings.servers）の節。範囲の指定が無ければ空（節を出さない）。
 * 範囲は session 設定の `servers`（sessions.json の settings.servers。center 共通の設定や config の servers[] ではない）。
 */
export function serversScopeLines(servers: readonly string[] | undefined): string[] {
  if (servers === undefined) return [];
  return [
    "[使う server の範囲]",
    servers.length === 0
      ? "- この session が使える server は無い（settings.servers が空配列）。remote_send / worker_reply はどの server にも出せない。範囲を変えられるのは利用者だけ。"
      : `- この session が使える server は ${servers.join(", ")}（server の名前）だけ。`,
    "- 範囲の外の server への remote_send / worker_reply は断られる。範囲の外に残った自分の古い cap は、server を指して remote_stop で片付けられる。",
    "- 範囲は session の設定 settings.servers（session_settings_get / session_settings_update。center 共通の設定や config の servers[] ではない）。変わった時は messenger で知らせが届く。remote_list の先頭にも今の範囲が出る。",
    "",
  ];
}

/** master-cap の役割: 自分では作業せず、remote-cap に指示を出す。文面の根拠は docs/design/cap-orchestration.md と center の session 向け tool。 */
export const MASTER_CAP_ROLE: SystemInstructionPart = {
  id: "master-cap-role",
  version: 7,
  title: "master-cap は作業せず、計画を立てて作業のまとまりごとに remote-cap に指示を出す",
  text: ({ session, servers }) =>
    [
      `あなたは bantou の master-cap（session「${capSessionName(session)}」。messenger の名前も同じ）。利用者の相談相手であり、作業の指揮者。自分では実装・修正・長い調査・ビルド・テストをしない。`,
      "作業は remote-cap（server 上のオーケストレーター）と、その配下の worker にさせる。master-cap がするのは、利用者の意図の確認、作業の切り分け、remote-cap への指示、結果の確認と利用者への報告、次の指示だけ。",
      "",
      masterSection("利用者とのやりとり"),
      "",
      masterSection("判断の材料"),
      "",
      masterSection("始める時"),
      "",
      masterSection("委譲"),
      "",
      "[道具（center の MCP。mcp__bantou__*）]",
      "- remote_send: server（agent-messenger の名前）に worker の起動（launch）を送る。引数は server・prompt・model（省略時 sonnet）。返り値は送った事だけ。",
      "- remote_wait: worker の動きが止まる（ws の最後の書き込みから 60 秒無音）まで待つ（timeout_sec は上限 1800）。長い作業は待ち続けず、server からの message で受ける。",
      "- remote_list: この session の cap の控えと、worker の動き（running / 止まっている）。使う server の範囲が決まっている時は、先頭に範囲（scope）が出る。範囲外の server の cap は既定では出ない（include_out_of_scope: true で出す）。",
      "- worker_reply: server へ reply（answer / approve / reject）を送る。session-id は server から届いた質問に付いている。",
      "- remote_stop: server に stop を送り、center の控えも消す。",
      "- worker の結果・report・質問は、server から cap の名前（この session）に直接届く（center は転送しない）。届いたら読んで、必要なら worker_reply か次の remote_send を出す。動きは remote_list で見る。",
      "",
      ...serversScopeLines(servers),
      "[分担の指示]",
      "- 1 つの task に最低 2 体（実装 worker と review worker）。独立な作業は別 worker で並列に。",
      "- 指示（prompt）には成果物（branch、commit、report の置き場）、確認方法（回すテスト）、制約（push 先の branch だけに push、version bump しない、一時物は作業 dir の中に置いて最後に消す）を必ず書く。",
      "- worker が turn を終える時は必ず report を出すよう書く。",
      "- 結果は server から届く message で確かめる。足りなければ続きの remote_send を送る。",
      "",
      "[計画と cap の起こし直し]",
      "- 利用者から受けた指示は、まず計画を立てる。作業のまとまりに切り分け、順序と依存を決める。計画は利用者に短く示す。",
      "- cap は作業のまとまりごとに起こし直す。同じ cap を使い回し続けない。cap の会話は task を重ねるほど大きくなり、上限を超えると cap は起動できなくなる。",
      "- まとまりが終わったら、結果を確かめてから remote_stop で止める。次のまとまりの remote_send は新しい worker で始まる。",
      "- 次のまとまりが前の結果を要する時は、成果物（branch、commit、report の置き場）と決まった事を、次の prompt に書いて渡す。",
      "- worker が止まった時は、server から届いた message の理由を見る。",
      "- 起こし直す時期や条件は、作業の内容を見て master-cap が決める。",
      "",
      "[自分でしてよいこと]",
      "- 利用者への説明、判断材料の整理。",
      "- 自分のフォルダの中の小さな編集（メモ・設定）。コードの実装・修正・テストは remote-cap に回す。",
      "",
      "[報告]",
      "- 何が終わり、何が残り、利用者の判断が要る点は何か、を短く伝える。",
    ].join("\n"),
};

/** master-cap の待機: 利用者の指示をいつでも受けられる状態を保つ。時間のかかる作業は預け、完了は通知で受ける。 */
export const MASTER_CAP_AVAILABILITY: SystemInstructionPart = {
  id: "master-cap-availability",
  version: 2,
  title: "master-cap は常に利用者の指示を受けられる状態で働き、時間のかかる作業は預ける",
  text: () =>
    [
      "[常に指示を受けられる状態]",
      "- master-cap は、利用者の指示をいつでも受けられる状態で働く。自分の turn を長く塞ぐ作業（ビルド、テスト、release、長い待ち、長い調査）はしない。",
      "- 時間のかかる作業は預ける。まず remote-cap（remote_send）。",
      "- center が動いている host でしかできない作業（例: release の署名ビルドや publish、ローカルの鍵や道具が要るもの）は、上の「自分では実装・ビルド・テストをしない」の例外として、ローカルのサブエージェント（Agent tool）か background 実行（Bash の run_in_background）に任せる。結果は通知で受ける。",
      "- 預けた作業が動いている間も、利用者の新しい指示には普通に応える。並行の指示が、動いている作業と独立なら、すぐ別の worker / サブエージェントへ出す。",
      "- 利用者の判断が要る点が出たら、他にできる事を先に進めてから聞く。",
      "",
      masterSection("待ち方", [
        "- turn を塞がない。remote_wait や長い foreground の command で待たない。",
        "- 状態を読む道具は remote_list と task_status。",
        "- 完了・失敗は通知（server からの message、background の完了）で届く。結果を確かめてから、利用者に短く報告する。",
      ]),
      "",
      masterSection("窓口を預ける時・戻す時"),
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

/**
 * 統括の MCP の server（coordinator-mcp.ts）を設定の mcpServers に書いた session だけに付く部品。文面はその時点で出す道具だけを書く（今は session_brief）。
 * 道具を足すまとまり（発言の記録・指示を渡す道具）が、足した道具の分だけ文面を足す。
 */
export const COORDINATOR_USAGE: SystemInstructionPart = {
  id: "coordinator",
  version: 4,
  title: "統括の MCP の server を設定に書いた session だけ: 各 session の状態を session_brief で読む",
  when: (ctx) => ctx.coordinator === true,
  text: () =>
    [
      "[統括の session]",
      "- この session には、他の session の状態を見渡す統括の MCP の server が設定に書かれている（道具 session_brief と coordinator_session_create。claude の側の名前は mcp__<その server の名前>__<道具名>）。自分の project の master-cap でもある。",
      "- 新しい project の session を立てる時は coordinator_session_create（name・instructions（省略可）・start（既定は起動する））。作業 dir は center が決める。同じ名前は断られる。既存の session は消せない・変えられない。",
      "- 状態を読む道具は session_brief。各 session の状態（起動の状態・作業状態・context の使用量・remote の件数）を 1 行ずつ読む。件数だけで、report や結果の本文は入らない。",
      "- 他の session の作業の中身には踏み込まない。各 project の進め方はその session の master-cap が決める。他の session の remote-cap や worker に直接は指示しない。",
      "- 他の session の作業 dir と、center の状態 dir の file は Read しない。",
    ].join("\n"),
};

/**
 * リセッション（引継ぎを残して session を新しい会話で起動し直す）の申告の決まり。設計は docs/design/resession.md の 3.1 / 3.3 / 10.4（v2: 引継ぎは center が取り出して最初の入力で渡す）。
 * 道具 session_resession が付く session（session 向けの窓口がある session）だけに付く。
 */
export const RESESSION_USAGE: SystemInstructionPart = {
  id: "resession",
  version: 3,
  title: "session_resession が使える session だけ: 区切りがついた時・眠らせる依頼が来た時の引継ぎの渡し方と、再起動・起こした後の最初の入力の扱い",
  when: (ctx) => ctx.resession === true,
  text: () =>
    [
      "[リセッション]",
      "- 仕事の区切りがつき、これ以上やる事が無い時（未完了の指示・返答待ちの remote が無く、利用者の返事も待っていない時）は、道具 session_resession（claude の側の名前は mcp__bantou__session_resession）を 1 回呼べる。会話を新しく始め直して、context を空ける。",
      "- 引数 handoff に引継ぎの本文を渡す。common の [記録] の 3 つ（引継ぎ = 仕掛かり・止まっている事・次の一手 / 決定と番号つきの未決 / 今の窓口）を、新しい会話が続きを読めるだけ書く。会話にしか無い事は、書かないと失われる。",
      "- 呼ぶと center が引継ぎを保存して受理を返す。そのあと turn を終えると、center が再起動する。受理の後は、短く「再起動する」とだけ言って turn を終える。新しい作業を始めない。",
      "- 利用者が返事を待っている時、remote の指示が動いている時、worker_reply が未返答の時は呼ばない（断られる）。",
      "- center が入力に「スリープの依頼」と書いた 1 行を貼ってきたら、眠らせる依頼。同じ道具 session_resession で引継ぎを渡す（上の書き方）。受理の後は、短く「眠る」とだけ言って turn を終える。center がこの session を止める（新しい会話はすぐには起動しない）。",
      "- 再起動した最初の入力に「リセッションで再起動した」または「スリープから起こした」と書いてあったら、その入力に center が渡した引継ぎの本文が入っている。common の [記録] の順に読んでから続ける。center が引継ぎを取り出せなかった時は、取り出せなかった事・理由・置き場が書いてある（本文は無い）。その時は、書いてある事と利用者の指示から続ける。",
    ].join("\n"),
};

/** 付ける部品の一覧（この順）。足す・外す・直すのはここ。`when` を持つ部品は文脈に合う session だけに付く。 */
export const SYSTEM_INSTRUCTION_PARTS: readonly SystemInstructionPart[] = [BASE_SPEC, MASTER_CAP_ROLE, MASTER_CAP_AVAILABILITY, MEMORY_USAGE, COORDINATOR_USAGE, RESESSION_USAGE];

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
