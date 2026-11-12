// Center settings: type, check, normalisation, target selection, secret hiding.
// Mirrors `packages/desktop/src-tauri/src/center.rs` (settings part) and `center_mcp.rs` (select_target).
// No Nuxt / Nitro / Tauri / browser API here. fs lives in `file-store.ts`.

import { randomInt } from "node:crypto";
import type { CenterRemote, CenterSettings } from "../../ui/types/index.ts";
import { MCP_PATH, normalizeRemote, redactUrl } from "./normalize.ts";

export type { CenterRemote, CenterSettings };

export const DEFAULT_PORT = 7910;
export const DEFAULT_WORKSPACE = "~/.bantou";
/** Shortest token the center accepts (center.rs `MIN_TOKEN_LEN`). */
export const MIN_TOKEN_LEN = 12;
const GENERATED_TOKEN_LEN = 32;
const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** The sidecar is always dialed on loopback (center_mcp.rs `SIDECAR_HOST`). */
const SIDECAR_HOST = "127.0.0.1";

export type TargetSource = "remote" | "sidecar";

export interface Target {
  url: string;
  /** Bearer token to send. Undefined: send no Authorization header. */
  token?: string;
  source: TargetSource;
}

/** Injected differences (design 5.5 / 5.6). Defaults are the web v1 values. */
export interface SettingsPolicy {
  /** Accept `enabled: true` on save. Web v1: false ("this version does not support it", until work unit S). */
  allowEnabled?: boolean;
  /** Which center tools may be called (design 5.3). Unset: every tool (desktop). Web: `allowWebTool`. */
  allowTool?: (name: string) => boolean;
}

export class CenterSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CenterSettingsError";
  }
}

export function defaultSettings(): CenterSettings {
  return { enabled: false, port: DEFAULT_PORT, workspace: DEFAULT_WORKSPACE, token: "" };
}

/** A fresh random Bearer token (32-char base62, CSPRNG). (center.rs `mint_token`) */
export function mintToken(): string {
  let t = "";
  for (let i = 0; i < GENERATED_TOKEN_LEN; i++) t += BASE62[randomInt(BASE62.length)];
  return t;
}

const charCount = (s: string) => [...s].length;

/** Settings with a usable token: empty or too short is replaced. `minted` says whether it was. (center.rs `ensure_token`) */
export function ensureToken(s: CenterSettings): { settings: CenterSettings; minted: boolean } {
  if (charCount(s.token) >= MIN_TOKEN_LEN) return { settings: s, minted: false };
  return { settings: { ...s, token: mintToken() }, minted: true };
}

const isAbsolute = (p: string) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");

/** Type check of an input from outside (a command argument). Throws `CenterSettingsError`, never a TypeError later. */
export function assertSettingsShape(x: unknown): asserts x is CenterSettings {
  const bad = (name: string): never => {
    throw new CenterSettingsError(`${name} の型が不正`);
  };
  if (x === null || typeof x !== "object" || Array.isArray(x)) return bad("settings");
  const o = x as Record<string, unknown>;
  if (typeof o.enabled !== "boolean") bad("enabled");
  if (typeof o.port !== "number") bad("port");
  if (typeof o.workspace !== "string") bad("workspace");
  if (typeof o.token !== "string") bad("token");
  if (o.claudePath != null && typeof o.claudePath !== "string") bad("claudePath");
  if (o.remote != null) {
    if (typeof o.remote !== "object" || Array.isArray(o.remote)) bad("remote");
    const r = o.remote as Record<string, unknown>;
    if (typeof r.url !== "string") bad("remote.url");
    if (r.token != null && typeof r.token !== "string") bad("remote.token");
  }
}

/**
 * Reject settings the center would refuse and normalise empty optionals. (center.rs `validate_settings`)
 * Only the known items are kept: any other key of the input (`bind`, `tokenSet`, anything extra) is dropped,
 * as serde drops unknown keys on the desktop. Throws `CenterSettingsError`.
 */
export function validateSettings(input: CenterSettings, policy: SettingsPolicy = {}): CenterSettings {
  assertSettingsShape(input);
  const s: CenterSettings = { enabled: input.enabled, port: input.port, workspace: input.workspace, token: input.token };
  if (input.claudePath != null) s.claudePath = input.claudePath;
  if (input.remote != null) s.remote = { url: input.remote.url, token: input.remote.token };
  if (s.enabled && !policy.allowEnabled) {
    throw new CenterSettingsError("center の起動（enabled）はこの版では未対応");
  }
  if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) {
    throw new CenterSettingsError(`port は 1〜65535: ${s.port}`);
  }
  s.workspace = s.workspace.trim();
  if (s.workspace === "") s.workspace = DEFAULT_WORKSPACE;
  if (!(s.workspace === "~" || s.workspace.startsWith("~/") || isAbsolute(s.workspace))) {
    throw new CenterSettingsError(`workspace は絶対パスか ~ 始まりで指定する: ${s.workspace}`);
  }
  const cp = s.claudePath?.trim();
  if (cp) {
    if (!isAbsolute(cp)) throw new CenterSettingsError("claudePath は絶対パスで指定する");
    s.claudePath = cp;
  } else {
    delete s.claudePath;
  }
  if (s.token !== "" && charCount(s.token) < MIN_TOKEN_LEN) {
    throw new CenterSettingsError(`token は ${MIN_TOKEN_LEN} 文字以上`);
  }
  if (s.remote) {
    const url = s.remote.url.trim();
    if (!(url.startsWith("http://") || url.startsWith("https://"))) {
      throw new CenterSettingsError("remote の url は http(s):// で始める");
    }
    const token = s.remote.token?.trim();
    s.remote = token ? { url: normalizeRemote(url), token } : { url: normalizeRemote(url) };
  } else {
    delete s.remote;
  }
  return s;
}

/**
 * Where to connect: our own sidecar when enabled (a stored `remote` is kept but ignored),
 * else the stored `remote` if any, else nowhere. (center_mcp.rs `select_target`)
 */
export function selectTarget(s: CenterSettings): Target | undefined {
  if (s.enabled) {
    const t: Target = { url: `http://${SIDECAR_HOST}:${s.port}${MCP_PATH}`, source: "sidecar" };
    if (s.token) t.token = s.token;
    return t;
  }
  if (!s.remote) return undefined;
  const t: Target = { url: normalizeRemote(s.remote.url), source: "remote" };
  if (s.remote.token !== undefined) t.token = s.remote.token;
  return t;
}

/**
 * Read a stored value the way serde does: missing keys take defaults, unknown keys (`bind`,
 * the old `remoteUrl`, ...) are dropped, and a value that does not parse gives the defaults.
 */
export function parseStored(value: unknown): CenterSettings {
  const d = defaultSettings();
  if (value === null || typeof value !== "object" || Array.isArray(value)) return d;
  const o = value as Record<string, unknown>;
  const out: CenterSettings = { ...d };
  if (o.enabled !== undefined) {
    if (typeof o.enabled !== "boolean") return d;
    out.enabled = o.enabled;
  }
  if (o.port !== undefined) {
    if (typeof o.port !== "number" || !Number.isInteger(o.port) || o.port < 0 || o.port > 0xffffffff) return d;
    out.port = o.port;
  }
  if (o.workspace !== undefined) {
    if (typeof o.workspace !== "string") return d;
    out.workspace = o.workspace;
  }
  if (o.token !== undefined) {
    if (typeof o.token !== "string") return d;
    out.token = o.token;
  }
  if (o.claudePath !== undefined && o.claudePath !== null) {
    if (typeof o.claudePath !== "string") return d;
    out.claudePath = o.claudePath;
  }
  if (o.remote !== undefined && o.remote !== null) {
    if (typeof o.remote !== "object" || Array.isArray(o.remote)) return d;
    const r = o.remote as Record<string, unknown>;
    if (typeof r.url !== "string") return d;
    const remote: CenterRemote = { url: r.url };
    if (r.token !== undefined && r.token !== null) {
      if (typeof r.token !== "string") return d;
      remote.token = r.token;
    }
    out.remote = remote;
  }
  return out;
}

/** Normalise the saved remote url in place; whether it changed. (center.rs `repair_remote_url`) */
export function repairRemoteUrl(s: CenterSettings): boolean {
  if (!s.remote) return false;
  const fixed = normalizeRemote(s.remote.url);
  if (fixed === s.remote.url) return false;
  s.remote = { ...s.remote, url: fixed };
  return true;
}

/** The settings as the web returns them: no token, only whether one is set (design 5.5). */
export function redactSettings(s: CenterSettings): CenterSettings {
  const out: CenterSettings = { ...s, token: "", tokenSet: s.token !== "" };
  delete out.bind;
  if (s.remote) {
    // Only host part and path: no userinfo, query or fragment (design 5.5, R28).
    out.remote = { url: redactUrl(s.remote.url), token: "", tokenSet: !!s.remote.token };
  }
  return out;
}
