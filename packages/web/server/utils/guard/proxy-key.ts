import { createHash, timingSafeEqual } from "node:crypto";
import { GuardError } from "./errors";

export const PROXY_KEY_HEADER = "x-bantou-proxy-key";

/** 共有鍵 header の照合（設計 5.2 L4）。定時間で比べ、無い・違う要求は 403。 */
export function checkProxyKey(got: string | undefined, expected: string): void {
  if (got === undefined) throw new GuardError(403, "proxy_key");
  const a = createHash("sha256").update(got).digest();
  const b = createHash("sha256").update(expected).digest();
  if (!timingSafeEqual(a, b)) throw new GuardError(403, "proxy_key");
}
