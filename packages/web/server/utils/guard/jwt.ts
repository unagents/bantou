import { verify as cryptoVerify } from "node:crypto";
import type { GuardConfig } from "./config";
import { issuerOf } from "./config";
import { GuardError } from "./errors";
import type { JwksCache } from "./jwks";

export interface AccessIdentity {
  readonly email: string;
}

const LEEWAY_SEC = 30;

function b64urlDecode(s: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new GuardError(401, "jwt_malformed");
  return Buffer.from(s, "base64url");
}

function parseJson(buf: Buffer): Record<string, unknown> {
  try {
    const v = JSON.parse(buf.toString("utf8")) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fallthrough
  }
  throw new GuardError(401, "jwt_malformed");
}

/**
 * Cf-Access-Jwt-Assertion の検証（設計 5.2 L3）。署名 (RS256)・iss・aud・exp・許可 email。
 * token 不正は 401、署名は正しいが email が許可外は 403。
 */
export async function verifyAccessJwt(
  token: string | undefined,
  config: GuardConfig,
  jwks: JwksCache,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<AccessIdentity> {
  if (!token) throw new GuardError(401, "jwt_missing");
  const parts = token.split(".");
  if (parts.length !== 3) throw new GuardError(401, "jwt_malformed");
  const [h, p, s] = parts as [string, string, string];
  const header = parseJson(b64urlDecode(h));
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new GuardError(401, "jwt_alg");

  const key = await jwks.get(header.kid);
  if (!key) throw new GuardError(401, "jwt_unknown_kid");
  const ok = cryptoVerify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, b64urlDecode(s));
  if (!ok) throw new GuardError(401, "jwt_signature");

  const claims = parseJson(b64urlDecode(p));
  if (claims.iss !== issuerOf(config.team)) throw new GuardError(401, "jwt_iss");
  const aud = claims.aud;
  const audOk = typeof aud === "string" ? aud === config.aud : Array.isArray(aud) && aud.includes(config.aud);
  if (!audOk) throw new GuardError(401, "jwt_aud");
  if (typeof claims.exp !== "number" || nowSec > claims.exp + LEEWAY_SEC) throw new GuardError(401, "jwt_exp");
  if (typeof claims.nbf === "number" && nowSec < claims.nbf - LEEWAY_SEC) throw new GuardError(401, "jwt_nbf");

  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (email === "") throw new GuardError(401, "jwt_email");
  if (!config.allowedEmails.has(email)) throw new GuardError(403, "email_not_allowed");
  return { email };
}
