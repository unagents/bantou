import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** セッション向け窓口（/mcp/session）の使い捨て token。session 名に束縛し、session の起動ごとに作り直す。 */
export interface SessionTokens {
  /** name 用の token を新しく発行する（前の token は無効になる）。 */
  issue(name: string): string;
  /** token が name に発行された現在のものか。 */
  verify(name: string, token: string): boolean;
  revoke(name: string): void;
}

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

export function createSessionTokens(): SessionTokens {
  const tokens = new Map<string, string>();
  return {
    issue(name) {
      const t = randomBytes(24).toString("hex");
      tokens.set(name, t);
      return t;
    },
    verify(name, token) {
      const t = tokens.get(name);
      if (t === undefined) return false;
      return timingSafeEqual(digest(t), digest(token));
    },
    revoke: (name) => void tokens.delete(name),
  };
}
