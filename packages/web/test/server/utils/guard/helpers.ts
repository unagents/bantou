import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { createApp, toNodeListener } from "h3";
import { createGuardHandler, meHandler, type Guard } from "../../../../server/utils/guard/handler";
import { loadGuardConfig } from "../../../../server/utils/guard/config";
import { JwksCache } from "../../../../server/utils/guard/jwks";

// 全部ダミー値
export const TEAM = "testteam";
export const AUD = "test-aud-0123456789";
export const PROXY_KEY = "test-proxy-key-0123456789";
export const ALLOWED = "alice@example.test";

export interface TestKey {
  kid: string;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

export function makeKey(kid: string): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" } };
}

const b64u = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

export function sign(key: TestKey, claims: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const h = b64u({ alg: "RS256", kid: key.kid, typ: "JWT", ...header });
  const p = b64u(claims);
  const s = createSign("RSA-SHA256").update(`${h}.${p}`).sign(key.privateKey).toString("base64url");
  return `${h}.${p}.${s}`;
}

export function goodClaims(over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { iss: `https://${TEAM}.cloudflareaccess.com`, aud: [AUD], email: ALLOWED, iat: now, exp: now + 3600, ...over };
}

/** 偽 JWKS server。keys は差し替え可。fetches は取得回数 */
export async function startJwks(initial: TestKey[]) {
  const state = { keys: initial, fetches: 0 };
  const server = createServer((_req, res) => {
    state.fetches++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: state.keys.map((k) => k.jwk) }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/certs`;
  return { state, url, close: () => closeServer(server) };
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((r) => {
    server.closeAllConnections();
    server.close(() => r());
  });
}

export function makeGuard(certsUrl: string): Guard {
  const config = loadGuardConfig({
    CF_TEAM: TEAM,
    CF_AUD: AUD,
    ALLOWED_EMAILS: ` ${ALLOWED.toUpperCase()} , bob@example.test`,
    PROXY_KEY,
    WEB_CF_CERTS_URL: certsUrl,
  });
  return { config, jwks: new JwksCache({ url: config.certsUrl }) };
}

/** guard + /api/me + 守りの先の route を持つ app */
export async function startApp(guard: Guard) {
  const app = createApp();
  app.use(createGuardHandler(() => guard));
  app.use("/api/me", meHandler);
  app.use("/api/echo", (() => ({ ok: true })) as never);
  const server = createServer(toNodeListener(app));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, close: () => closeServer(server) };
}
