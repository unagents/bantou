import type { ClaudeRunResult } from "./claude";

/**
 * worker の最後の返答の形（claude の --json-schema）。全部必須。
 * lastType: message（返事が要る）は status が ask / request_approve、report（返事は要らない）は success / failed。
 */
export const WORKER_SCHEMA = {
  type: "object",
  properties: {
    lastType: { type: "string", enum: ["message", "report"] },
    status: { type: "string", enum: ["ask", "request_approve", "success", "failed"] },
    content: { type: "string" },
  },
  required: ["lastType", "status", "content"],
  additionalProperties: false,
} as const;

/** --json-schema に渡す文字列。 */
export const WORKER_SCHEMA_JSON = JSON.stringify(WORKER_SCHEMA);

/** server → cap（ふつうの agent-messenger の message。meta.protocol は付けない）。返事が要る。 */
export interface CapMessage {
  "session-id": string;
  status: "ask" | "request_approve";
  content: string;
}

/** server → cap（ふつうの agent-messenger の message）。返事は要らない。 */
export interface CapReport {
  status: "success" | "failed";
  content: string;
}

/** 失敗の content の長さの上限（process の detail が長い時に切る）。 */
const MAX_FAILED_CONTENT = 4000;

const clip = (s: string): string => (s.length > MAX_FAILED_CONTENT ? `${s.slice(0, MAX_FAILED_CONTENT)}…` : s);

const failed = (content: string): CapReport => ({ status: "failed", content: clip(content) });

/**
 * worker の 1 回の実行の結果から、cap へ返す message を作る。
 * - 最後の result の structured_output と session_id を使う（session-id は message の時だけ付く）。
 * - process が落ちた・最後の出力が無い・structured_output が schema の形でない時は、server が failed を付ける。
 */
export function interpretResult(r: ClaudeRunResult): CapMessage | CapReport {
  if (!r.ok) return failed(`worker が最後の出力を返さずに終わった: ${r.detail}`);
  const o = r.structuredOutput;
  if (typeof o !== "object" || o === null || Array.isArray(o)) {
    return failed("worker の最後の出力に structured_output が無い");
  }
  const { lastType, status, content } = o as Record<string, unknown>;
  if (typeof content !== "string") return failed("worker の最後の出力の content が文字列でない");
  if (lastType === "message" && (status === "ask" || status === "request_approve")) {
    return { "session-id": r.sessionId, status, content };
  }
  if (lastType === "report" && (status === "success" || status === "failed")) {
    return { status, content };
  }
  return failed(`worker の最後の出力の lastType / status の組が不正: lastType=${String(lastType)} status=${String(status)}`);
}
