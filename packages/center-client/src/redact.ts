// Cleaning text and JSON of the secrets of the connections in use (token, URL password). Design 5.5 / 3c report "3d 側の注意".
// A successful tool result is passed on as is by `mcp.ts`; whatever goes to the browser passes here first.

import { scrub, secretsOf } from "./mcp.ts";
import type { Target } from "./settings.ts";

const MASK = "***";
/** How many past targets are remembered (a destination changed by settings can still echo its old secrets). */
const REMEMBER = 8;

export interface Redactor {
  /** Remember the secrets of the current target (read from the settings) and clean `text` of all known secrets. */
  text(text: string): Promise<string>;
  /** `text` for a value: every string inside is cleaned (JSON-escaped forms too, since tool results carry JSON as text). */
  value<T>(v: T): Promise<T>;
  /** Clean `text` with the secrets known so far (no settings read). */
  textSync(text: string): string;
  /** Add secrets (e.g. the token in a settings input). */
  note(secrets: string[]): void;
}

export function createRedactor(settings: { selectTarget(): Promise<Target | undefined> }): Redactor {
  const targets: { url: string; token: string | undefined }[] = [];
  const extra = new Set<string>();

  const remember = (t: Target | undefined) => {
    if (!t) return;
    if (targets.some((x) => x.url === t.url && x.token === t.token)) return;
    targets.push({ url: t.url, token: t.token });
    if (targets.length > REMEMBER) targets.shift();
  };
  const refresh = async () => {
    try {
      remember(await settings.selectTarget());
    } catch {
      // the settings cannot be read now: the secrets known so far are used
    }
  };

  const textSync = (text: string): string => {
    let out = text;
    const all = new Set<string>(extra);
    for (const t of targets) {
      out = scrub(out, t.url, t.token);
      for (const s of secretsOf(t.url, t.token)) all.add(s);
    }
    for (const s of all) {
      out = out.split(s).join(MASK);
      // The same secret inside JSON text: `"` and `\` are escaped there.
      const esc = JSON.stringify(s).slice(1, -1);
      if (esc !== s) out = out.split(esc).join(MASK);
    }
    return out;
  };

  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return textSync(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [textSync(k), walk(x)]));
    }
    return v;
  };

  return {
    textSync,
    note(secrets) {
      for (const s of secrets) if (s !== "") extra.add(s);
    },
    async text(text) {
      await refresh();
      return textSync(text);
    },
    async value<T>(v: T) {
      await refresh();
      return walk(v) as T;
    },
  };
}
