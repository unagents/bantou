/**
 * cap と worker の system prompt（--append-system-prompt-file で渡す）。
 * 本文に " -- " を含めない（ファイル渡しなので必須ではないが、argv 照合の前提としてテストで固定する）。
 */
import {
  PROTOCOL_VERSION,
  REVIEW_SEVERITIES,
  REVIEW_VERDICTS,
  WORKER_ROLES,
  isActivityState,
  isServerReply,
  isValidAgentId,
  type ReviewItem,
  type ReviewSeverity,
  type RunOutcome,
  type TaskCommand,
  type TaskResultReply,
  type TaskResultWorker,
  type WorkerRole,
} from "@agent-hand/bantou-protocol";

/** 本文の正本は docs/design/cap-orchestration.md。変える時は両方。 */
export const CAP_GUIDE = [
  "あなたは bantou の remote-cap。作業を束ねるオーケストレーターで、自分では実装しない。",
  "作業は必ず worker にさせる。cap がするのは、分割・指示・結果の確認・次の指示・まとめだけ。",
  "「密結合だから worker は 1 体」と丸投げしない。",
  "",
  "[道具]",
  "worker の起動と続きの指示は mcp__bantou__worker_start を使う。worker_id を省けば新規、同じ worker_id を渡せば続きの指示になる。",
  "状態は mcp__bantou__worker_status、停止は mcp__bantou__worker_stop を使う。",
  "Bash で claude を直接起動しない。",
  "一時物は作業 dir の中に置く。$TMPDIR（自分の path の tmp/）を使い、/tmp 直書きはしない。一時物の削除は Bash の rm でなく mcp__bantou__bash の rm（action: rm、paths は自分の path からの相対。自分の worker は worker:<id>/<path>、dir は recursive: true）を使う。",
  "worker の報告は「worker <id> から <kind>: <text>」として届く。",
  "worker_start は完了を待たずに返る。起動したらターンを終えてよい。",
  "",
  "[分担]",
  "最小の分担は 2 体。実装 worker と review worker。",
  "review worker は実装 worker の push 後に、別 clone で差分を読み、テストを回し、仕様とのずれ・壊れ・抜けを report する。",
  "review の指摘は、実装 worker に同じ worker_id で worker_start して戻す。直るまで回す。実装と review の往復は最大 3 回。3 回で直らなければ、残った問題として最終返答に書いて止める。",
  "独立な部分（例: center と desktop、実装と docs、別 package）は別 worker で並列に起動する。依存がある部分は、前の worker の完了を確認してから次を起動する。",
  "同じ branch に複数の worker が push する場合は、先に rebase して衝突を解消してから push するよう指示する。",
  "",
  "[worker への指示]",
  "指示には必ず次を含める。",
  "- 成果物: branch、commit、report の置き場",
  "- 確認方法: どのテストを回すか（review worker には、回すテストと見る差分の範囲）",
  "- 後始末: 終わったら（push と report の内容を確かめた後に）自分の clone・node_modules・ビルド生成物と、自分で置いた一時物を自分で消す。logs/ と state.json は消さない",
  "kick_cap の prompt にある制約（repo 引数を使わない、一時物の置き場、GIT_CONFIG_GLOBAL、push 先の branch、version bump しない など）は、worker への指示にも書き写す。worker は cap の prompt を見ない。",
  "",
  "[model]",
  "worker の model は、cap への指示の worker_model か prompt の指定に従う。",
  "指定が無ければ、実装 worker は既定、review worker は実装と同じか軽いものにする。",
  "",
  "[最終返答]",
  "各 worker の結果、review の結論、残った問題を書く。",
  "指示が [task <task_id>] で始まる時（task 指示）は、最終返答を task_result の JSON 1 つで返す。JSON は ```json のコードブロックに入れ、ブロックの前後に説明を書いてよい。形式:",
  '{"state":"done または failed","summary":"結果の要約","workers":[{"worker_id":"...","role":"implement|review|docs|test|other","state":"done|failed|idle|running|stalled|lost","branch":"...","commit":"...","tests":"回したテストと結果","report_path":"...","result":"worker の結果の先頭"}],"review":{"verdict":"ok|issues|unknown","items":[{"severity":"high|medium|low","text":"指摘","resolved":true}],"rounds":0},"remaining":["残った問題"]}',
  "branch / commit / tests / report_path は分かるものだけ書く。review の結果が無い時は verdict を unknown にする。",
  "",
  "[report が来ない worker]",
  "worker が report を送らずに idle になった時（worker_status が idle で、その worker の report が届いていない）は、同じ worker_id で worker_start して report を送るよう指示し、再開させる。",
].join("\n");

export const WORKER_GUIDE = [
  "あなたは bantou の worker。remote-cap から作業を任されている。",
  "進捗・質問・承認依頼・完了は mcp__bantou__report で送る（kind: progress | ask | approve | done）。",
  "report はすぐ accepted を返す。送ったらターンを終える。",
  "",
  "[一時物]",
  "一時物は作業 dir の中に置く。$TMPDIR（自分の path の tmp/）を使い、/tmp 直書きはしない。一時物の削除は Bash の rm でなく mcp__bantou__bash の rm（action: rm、paths は自分の path からの相対、dir は recursive: true）を使う。",
  "",
  "[常設の制約]",
  "bantou-server / bantou-center を install・起動・停止・再起動しない。必要なら report で報告するだけにする。",
].join("\n");

// -- task 指示 --------------------------------------------------------------------

const bullets = (items: readonly string[] | undefined): string[] => (items ?? []).map((x) => `- ${x}`);

/**
 * task（center → server）から cap の最初の指示を組み立てる。文面の正本は docs/design/cap-orchestration.md の
 * 「task 指示の文面」。変える時は両方。先頭行は `[task <task_id>]` で固定（CAP_GUIDE が見分ける）。
 */
export function buildTaskPrompt(t: TaskCommand): string {
  const out: string[] = [`[task ${t.task_id}]`, "", "[目的]", t.goal];
  const base = [t.repo ? `repo: ${t.repo}` : "", t.branch ? `branch: ${t.branch}` : ""].filter((x) => x !== "");
  if (base.length > 0) out.push("", "[作業の base]", ...base);
  const d = t.deliverables;
  const deliverables = [
    ...(d.branch ? [`push 先 branch: ${d.branch}`] : []),
    ...(d.report_path ? [`report の置き場: ${d.report_path}`] : []),
    ...(d.other ?? []),
  ];
  out.push("", "[成果物]", ...(deliverables.length > 0 ? bullets(deliverables) : ["- 指定なし（cap が決めて worker に指示する）"]));
  const verify = [...(t.verify.tests ?? []).map((x) => `回すテスト: ${x}`), ...(t.verify.steps ?? []).map((x) => `手順: ${x}`)];
  out.push("", "[確認方法]", ...(verify.length > 0 ? bullets(verify) : ["- 指定なし（cap が決めて worker に指示する）"]));
  out.push("", "[制約]", ...(t.constraints.length > 0 ? bullets(t.constraints) : ["- なし"]));
  out.push("", "[分担]");
  const items = t.workers.items ?? [];
  if (items.length === 0) {
    out.push("最低 2 体: 実装 worker と review worker。分割は cap が決める。");
  } else {
    out.push("次の分担に従って worker を起動する。依存（depends_on）がある worker は、その完了を確認してから起動する。");
    items.forEach((it, i) => {
      const parts = [`role=${it.role}`, `scope=${it.scope}`];
      if (it.model) parts.push(`model=${it.model}`);
      if (it.depends_on && it.depends_on.length > 0) parts.push(`depends_on=${it.depends_on.join(",")}`);
      out.push(`- ${it.id ?? `#${i + 1}`}: ${parts.join(" ")}`);
    });
    if (!items.some((it) => it.role === "implement") || !items.some((it) => it.role === "review")) {
      out.push("実装と review が分担に無い時は、足りない方の worker を cap が追加する。");
    }
  }
  if (t.worker_model) out.push("", "[worker の model]", `worker_model: ${t.worker_model}（worker_start で model を省く時の既定。分担の model が優先）`);
  out.push(
    "",
    "[最終返答]",
    "最終返答は task_result の JSON 1 つで返す（形式は system prompt の [最終返答]）。task_id は返さなくてよい。",
  );
  return out.join("\n");
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** worker の result の先頭の上限（文字数）。 */
export const MAX_WORKER_RESULT_HEAD = 500;

/** 本文から JSON オブジェクトの候補を後ろ側から順に返す（```json ブロック、無ければ文中の最後の {...}）。 */
function jsonCandidates(text: string): string[] {
  const out: string[] = [];
  const fence = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/g;
  for (const m of text.matchAll(fence)) out.push(m[1]!.trim());
  out.reverse();
  // 文中の {...}: 後ろの '{' から順に、対応する '}' までを候補にする
  let from = text.length;
  for (let n = 0; n < 20; n++) {
    const start = text.lastIndexOf("{", from - 1);
    if (start < 0) break;
    from = start;
    let depth = 0;
    let inStr = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i]!;
      if (inStr) {
        if (c === "\\") i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        out.push(text.slice(start, i + 1));
        break;
      }
    }
  }
  return out;
}

function normWorker(v: unknown): TaskResultWorker | undefined {
  if (!isRecord(v) || !isValidAgentId(v.worker_id)) return undefined;
  const w: TaskResultWorker = {
    worker_id: v.worker_id,
    role: (WORKER_ROLES as readonly unknown[]).includes(v.role) ? (v.role as WorkerRole) : "other",
    state: isActivityState(v.state) ? v.state : "idle",
    result: (typeof v.result === "string" ? v.result : "").slice(0, MAX_WORKER_RESULT_HEAD),
  };
  for (const k of ["branch", "commit", "tests", "report_path"] as const) {
    const x = str(v[k]);
    if (x !== undefined) w[k] = x;
  }
  return w;
}

function normItem(v: unknown): ReviewItem | undefined {
  if (!isRecord(v) || typeof v.text !== "string") return undefined;
  const severity = (REVIEW_SEVERITIES as readonly unknown[]).includes(v.severity) ? (v.severity as ReviewSeverity) : "medium";
  return { severity, text: v.text, resolved: v.resolved === true };
}

/**
 * cap の返答から task_result の中身を取り出す。`summary`（文字列）を持つ JSON オブジェクトだけを採る。
 * 形が少し崩れていても取れる分は拾う（worker の role / state、review の severity は既定値で補う）。
 * 取り出せなければ undefined。
 */
export function extractTaskResult(
  capId: string,
  taskId: string,
  text: string,
): TaskResultReply | undefined {
  for (const c of jsonCandidates(text)) {
    let v: unknown;
    try {
      v = JSON.parse(c);
    } catch {
      continue;
    }
    if (!isRecord(v) || typeof v.summary !== "string") continue;
    const rv = isRecord(v.review) ? v.review : {};
    const reply: TaskResultReply = {
      bantou: PROTOCOL_VERSION,
      type: "task_result",
      cap_id: capId,
      task_id: taskId,
      state: v.state === "failed" ? "failed" : "done",
      summary: v.summary,
      workers: (Array.isArray(v.workers) ? v.workers : []).map(normWorker).filter((w): w is TaskResultWorker => w !== undefined),
      review: {
        verdict: (REVIEW_VERDICTS as readonly unknown[]).includes(rv.verdict) ? (rv.verdict as "ok" | "issues" | "unknown") : "unknown",
        items: (Array.isArray(rv.items) ? rv.items : []).map(normItem).filter((i): i is ReviewItem => i !== undefined),
        rounds: typeof rv.rounds === "number" && Number.isInteger(rv.rounds) && rv.rounds >= 0 ? rv.rounds : 0,
      },
      remaining: (Array.isArray(v.remaining) ? v.remaining : []).filter((x): x is string => typeof x === "string"),
    };
    const err = str(v.error);
    if (err !== undefined) reply.error = err;
    if (isServerReply(reply)) return reply;
  }
  return undefined;
}

/**
 * task 指示の実行結果を task_result にする。取り出せなければ summary に生の返答、review.verdict は unknown。
 * 実行が失敗（ok=false）なら state は failed（JSON が取れても failed に寄せる）。
 */
export function buildTaskResult(capId: string, taskId: string, r: RunOutcome): TaskResultReply {
  const extracted = r.ok ? extractTaskResult(capId, taskId, r.result_text) : undefined;
  const base: TaskResultReply = extracted ?? {
    bantou: PROTOCOL_VERSION,
    type: "task_result",
    cap_id: capId,
    task_id: taskId,
    state: r.ok ? "done" : "failed",
    summary: r.result_text,
    workers: [],
    review: { verdict: "unknown", items: [], rounds: 0 },
    remaining: [],
  };
  if (!r.ok) {
    base.state = "failed";
    base.error = r.error ?? "cap の実行に失敗";
  }
  return base;
}
