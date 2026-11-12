// The settings handle: load from the store, env override, redacted read, write.
// Design 5.5. Command names (`center_get_settings` / `center_set_settings`) map to `get` / `set`.

import type { CenterSettings } from "../../ui/types/index.ts";
import { normalizeRemote, redactUrl } from "./normalize.ts";
import {
  assertSettingsShape,
  CenterSettingsError,
  ensureToken,
  parseStored,
  redactSettings,
  repairRemoteUrl,
  selectTarget,
  validateSettings,
  type SettingsPolicy,
  type Target,
} from "./settings.ts";
import type { SettingsStore } from "./store.ts";

export interface CenterSettingsOptions {
  settingsStore: SettingsStore;
  policy?: SettingsPolicy;
  /** True (web): `get` hides tokens, and an empty token in `set` means "unchanged". False (desktop): as today. */
  redactSecrets?: boolean;
  /** Where `CENTER_URL` / `CENTER_TOKEN` are read from. Default `process.env`. */
  env?: Record<string, string | undefined>;
}

/** Which remote items are fixed by env (shown as "fixed by env"; they cannot be changed). */
export interface EnvLocks {
  remoteUrl: boolean;
  remoteToken: boolean;
}

export interface CenterSettingsHandle {
  /** `center_get_settings`: effective settings (env over file). With `redactSecrets`: no token, `tokenSet` instead. */
  get(): Promise<CenterSettings>;
  /** `center_set_settings`: check, merge, save. Returns what `get` returns. Throws `CenterSettingsError`. */
  set(input: CenterSettings): Promise<CenterSettings>;
  /** Where to connect now. Read from the store on every call. */
  selectTarget(): Promise<Target | undefined>;
  envLocks(): EnvLocks;
}

const envValue = (v: string | undefined) => (v !== undefined && v.trim() !== "" ? v.trim() : undefined);

export function createCenterSettings(opts: CenterSettingsOptions): CenterSettingsHandle {
  const { settingsStore: store } = opts;
  const policy = opts.policy ?? {};
  const redact = opts.redactSecrets ?? false;
  const env = () => opts.env ?? process.env;
  const envUrl = () => envValue(env().CENTER_URL);
  const envToken = () => envValue(env().CENTER_TOKEN);

  /** Stored settings as they are in the store (repaired; token minted only while a sidecar is enabled). */
  async function load(): Promise<CenterSettings> {
    const raw = await store.read();
    let s = parseStored(raw);
    const repaired = repairRemoteUrl(s);
    let minted = false;
    if (s.enabled) {
      const r = ensureToken(s);
      s = r.settings;
      minted = r.minted;
    }
    if (minted || repaired) await store.write(toStored(s));
    return s;
  }

  /** `load` with env applied over `remote` (env > file > default). */
  async function effective(): Promise<CenterSettings> {
    const s = await load();
    const url = envUrl();
    const token = envToken();
    if (url === undefined && token === undefined) return s;
    const baseUrl = url !== undefined ? normalizeRemote(url) : s.remote?.url;
    if (baseUrl === undefined) return s;
    const t = token ?? s.remote?.token;
    return { ...s, remote: t !== undefined ? { url: baseUrl, token: t } : { url: baseUrl } };
  }

  const view = (s: CenterSettings) => (redact ? redactSettings(s) : s);

  return {
    envLocks: () => ({ remoteUrl: envUrl() !== undefined, remoteToken: envToken() !== undefined }),
    selectTarget: async () => selectTarget(await effective()),
    get: async () => view(await effective()),
    async set(input) {
      assertSettingsShape(input);
      const file = await load();
      const eff = await effective();
      const next = merge(file, eff, input, redact, { url: envUrl(), token: envToken() });
      const saved = validateSettings(next, policy);
      await store.write(toStored(saved));
      return view(await effective());
    },
  };
}

/** What goes to the store: `CenterSettings` without `bind` and `tokenSet`. */
function toStored(s: CenterSettings): CenterSettings {
  const out: CenterSettings = { ...s };
  delete out.bind;
  delete out.tokenSet;
  if (out.remote) {
    out.remote = out.remote.token !== undefined ? { url: out.remote.url, token: out.remote.token } : { url: out.remote.url };
  }
  return out;
}

/** Input over the stored settings: empty token = unchanged (redact), new remote url = old token is not carried over. */
function merge(
  file: CenterSettings,
  eff: CenterSettings,
  input: CenterSettings,
  redact: boolean,
  env: { url?: string; token?: string },
): CenterSettings {
  const next: CenterSettings = { ...input };
  if (redact && (input.token ?? "") === "") next.token = file.token;

  const inUrl = input.remote ? normalizeRemote(input.remote.url.trim()) : undefined;
  const inToken = input.remote?.token?.trim() || undefined;
  const fileUrl = file.remote?.url;
  // Same destination as `stored`. With redact, the shown form (no userinfo / query) of the stored url counts as the same.
  const sameDest = (stored: string | undefined) =>
    inUrl !== undefined && stored !== undefined && (inUrl === stored || (redact && inUrl === redactUrl(stored)));

  if (env.url !== undefined) {
    if (!sameDest(eff.remote?.url)) throw new CenterSettingsError("remote の url は env（CENTER_URL）で固定されている");
  }
  if (env.token !== undefined) {
    const same = redact ? inToken === undefined : inToken === eff.remote?.token || inToken === undefined;
    if (!same) throw new CenterSettingsError("remote の token は env（CENTER_TOKEN）で固定されている");
  }

  if (!input.remote) {
    delete next.remote;
    return next;
  }
  // The destination stays when env fixes the url, or the input names the stored one (then the stored form is kept as is).
  const keepsDest = env.url !== undefined || sameDest(fileUrl);
  const url = keepsDest ? fileUrl : input.remote.url;
  if (url === undefined) {
    // env fixes the url and the file has none: only a token could be saved, and a token without a url is meaningless.
    if (inToken !== undefined && env.token === undefined) {
      throw new CenterSettingsError("env（CENTER_URL）で url が固定されていて、設定 file に remote が無いため token だけは保存できない");
    }
    delete next.remote;
    return next;
  }
  // A stored token never goes to another destination (R29), whether env fixes the token or not.
  let token: string | undefined;
  if (env.token !== undefined) {
    token = keepsDest ? file.remote?.token : undefined;
  } else if (!redact) {
    token = input.remote.token;
  } else if (inToken !== undefined) {
    token = inToken;
  } else {
    token = keepsDest ? file.remote?.token : undefined;
  }
  next.remote = token !== undefined ? { url, token } : { url };
  return next;
}
