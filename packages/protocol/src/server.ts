/** Registration constants of the bantou protocol (messenger/protocol.json) and shared patterns. */

/**
 * agent-messenger protocol registration (messenger/protocol.json) used in `meta` of send / listPeers.
 * Keep in sync with messenger/protocol.json.
 */
export const MESSENGER_PROTOCOL = { protocol: "bantou", version: "2.0.0" } as const;

/**
 * Are two messenger protocol versions compatible? Same major and same minor = compatible (a patch difference is passed:
 * a patch release does not change the wire shape). Anything else, or a malformed string (empty, non-numeric, missing
 * part, leading "v", pre-release / build suffix) = false.
 */
export function isProtocolCompatible(a: string | undefined, b: string | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const re = /^(\d+)\.(\d+)\.(\d+)$/;
  const x = re.exec(a);
  const y = re.exec(b);
  if (!x || !y) return false;
  return Number(x[1]) === Number(y[1]) && Number(x[2]) === Number(y[2]);
}

/**
 * Claude model name ("sonnet", "opus", "claude-sonnet-5-5", "opus[1m]" ...) of `launch`.
 * Never starts with '-' (it ends up in an argument).
 */
export const MODEL_PATTERN = /^[A-Za-z0-9._\[\]][A-Za-z0-9._\[\]-]*$/;

/** A string matching MODEL_PATTERN. */
export function isValidModel(v: unknown): v is string {
  return typeof v === "string" && MODEL_PATTERN.test(v);
}
