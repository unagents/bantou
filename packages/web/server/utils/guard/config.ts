import { GuardError } from "./errors";

/** web backend の守りの設定（設計 5.2）。値は env から読み、ログ・応答に出さない。 */
export interface GuardConfig {
  /** Access の team 名。iss と鍵の取得先を決める */
  readonly team: string;
  /** Access application の AUD tag */
  readonly aud: string;
  /** 許可する email（小文字化済み） */
  readonly allowedEmails: ReadonlySet<string>;
  /** nginx だけが付ける共有鍵（X-Bantou-Proxy-Key） */
  readonly proxyKey: string;
  /** 署名鍵 (JWKS) の URL。既定は team から決まる */
  readonly certsUrl: string;
}

export const ISS_SUFFIX = ".cloudflareaccess.com";

export function issuerOf(team: string): string {
  return `https://${team}${ISS_SUFFIX}`;
}

/**
 * env から設定を作る。足りない・空の項目があれば GuardError(500) を投げる（検証を緩めて続行はしない）。
 * CF_TEAM / CF_AUD / ALLOWED_EMAILS（カンマ区切り）/ PROXY_KEY が必須。
 * WEB_CF_CERTS_URL は鍵の取得先だけを変える（test が偽 JWKS を指す用）。iss・aud・署名の検証は変わらない。
 */
export function loadGuardConfig(env: NodeJS.ProcessEnv): GuardConfig {
  const team = (env.CF_TEAM ?? "").trim();
  const aud = (env.CF_AUD ?? "").trim();
  const proxyKey = env.PROXY_KEY ?? "";
  const allowedEmails = new Set(
    (env.ALLOWED_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e !== ""),
  );
  if (team === "" || aud === "" || proxyKey === "" || allowedEmails.size === 0) {
    throw new GuardError(500, "guard_misconfigured");
  }
  if (!/^[a-z0-9-]+$/i.test(team)) throw new GuardError(500, "guard_misconfigured");
  const certsUrl = (env.WEB_CF_CERTS_URL ?? "").trim() || `${issuerOf(team)}/cdn-cgi/access/certs`;
  return { team, aud, allowedEmails, proxyKey, certsUrl };
}
