import { GuardError } from "./errors";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * 変更系の CSRF 対策（設計 5.2）。GET/HEAD/OPTIONS 以外は Origin の host が自分の Host と一致する時だけ通す。
 * Origin が無い・解釈できない・"null" は拒否。Host は nginx が保つ（設計 8.1）。
 */
export function checkOrigin(method: string, origin: string | undefined, host: string | undefined): void {
  if (SAFE_METHODS.has(method.toUpperCase())) return;
  if (!origin || !host) throw new GuardError(403, "origin");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new GuardError(403, "origin");
  }
  if (originHost.toLowerCase() !== host.toLowerCase()) throw new GuardError(403, "origin");
}
