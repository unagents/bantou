import { createHash, timingSafeEqual } from "node:crypto";

export interface AuthOk {
  ok: true;
  agentId: string;
}
export interface AuthNg {
  ok: false;
  reason: "no-token-configured" | "missing-bearer" | "bad-token" | "missing-agent-id";
}

/** 定数時間比較。長さが違っても時間が漏れないよう、両方を SHA-256 にしてから比べる */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

const AGENT_ID_RE = /^[\w.@:-]{1,128}$/;

type HeaderGet = (name: string) => string | undefined | null;

/**
 * Bearer token と X-Agent-Id を検証する。token 値は返さない・log に出さない。
 * token 未設定（空）は常に拒否する（設定漏れで無認証にならないため）。
 */
export function authenticate(expectedToken: string, get: HeaderGet): AuthOk | AuthNg {
  if (!expectedToken) return { ok: false, reason: "no-token-configured" };
  const authz = get("authorization") ?? "";
  const m = /^Bearer (.+)$/.exec(authz);
  if (!m) return { ok: false, reason: "missing-bearer" };
  if (!safeEqual(m[1]!, expectedToken)) return { ok: false, reason: "bad-token" };
  const agentId = (get("x-agent-id") ?? "").trim();
  if (!AGENT_ID_RE.test(agentId)) return { ok: false, reason: "missing-agent-id" };
  return { ok: true, agentId };
}
