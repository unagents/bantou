import { createError, defineEventHandler, getHeader, getRequestHost, type EventHandler } from "h3";
import { loadGuardConfig, type GuardConfig } from "./config";
import { GuardError } from "./errors";
import { JwksCache } from "./jwks";
import { verifyAccessJwt, type AccessIdentity } from "./jwt";
import { checkOrigin } from "./origin";
import { checkProxyKey, PROXY_KEY_HEADER } from "./proxy-key";

export interface Guard {
  readonly config: GuardConfig;
  readonly jwks: JwksCache;
}

declare module "h3" {
  interface H3EventContext {
    access?: AccessIdentity;
  }
}

/**
 * 全 route に掛ける守り。順序は L4 (共有鍵) → L3 (JWT) → Origin。
 * 設定が不正なら 500 で全拒否する（検証を切って続行しない）。
 */
export function createGuardHandler(getGuard: () => Guard): EventHandler {
  return defineEventHandler(async (event) => {
    try {
      const { config, jwks } = getGuard();
      checkProxyKey(getHeader(event, PROXY_KEY_HEADER), config.proxyKey);
      event.context.access = await verifyAccessJwt(getHeader(event, "cf-access-jwt-assertion"), config, jwks);
      checkOrigin(event.method, getHeader(event, "origin"), getRequestHost(event));
    } catch (e) {
      if (e instanceof GuardError) throw createError({ statusCode: e.status, statusMessage: e.code });
      throw createError({ statusCode: 500, statusMessage: "guard_error" });
    }
  });
}

let cached: Guard | undefined;

/** env から 1 度だけ組む。不正な env は毎回 GuardError(500) */
export function guardFromEnv(env: NodeJS.ProcessEnv = process.env): Guard {
  if (cached) return cached;
  const config = loadGuardConfig(env);
  cached = { config, jwks: new JwksCache({ url: config.certsUrl }) };
  return cached;
}

/** GET /api/me の本体。middleware が積んだ識別を返す */
export const meHandler: EventHandler = defineEventHandler((event) => {
  const access = event.context.access;
  if (!access) throw createError({ statusCode: 401, statusMessage: "jwt_missing" });
  return { email: access.email };
});
