// Masking secrets in free text. A secret can come back in another spelling: other letter case, percent-encoded,
// base64 (standard / url-safe, any of the 3 byte alignments), `\uXXXX` escapes, or JSON-escaped (`\"`, `\\`).
// All of these are masked. A secret shorter than `MIN_FORM_LEN` is masked only in its exact form (as before),
// so a short secret does not shred ordinary text.

const MASK = "***";
/** A derived spelling (or a case-insensitive match) is used from this length on (same as the URL password rule). */
export const MIN_FORM_LEN = 4;

const regexEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Base64 text that a secret leaves inside a larger base64 text, for each byte offset (0..2) it can start at. */
function base64Parts(s: string, url: boolean): string[] {
  const enc = (b: Buffer) => (url ? b.toString("base64url") : b.toString("base64"));
  const body = Buffer.from(s, "utf8");
  const out: string[] = [];
  for (let k = 0; k < 3; k++) {
    let t = enc(Buffer.concat([Buffer.alloc(k), body])).replace(/=+$/, "");
    // the leading chars depend on the bytes before; the last char depends on the bytes after unless the length is aligned
    t = t.slice(k === 0 ? 0 : k === 1 ? 2 : 3);
    if ((k + body.length) % 3 !== 0) t = t.slice(0, -1);
    out.push(t);
  }
  return out;
}

/** `\uXXXX` for every UTF-16 unit of `s` (hex case does not matter: matching ignores case). */
const unicodeEscaped = (s: string) =>
  Array.from({ length: s.length }, (_, i) => `\\u${s.charCodeAt(i).toString(16).padStart(4, "0")}`).join("");

/** The spellings of one secret that are masked. */
export function formsOf(secret: string): string[] {
  if (secret === "") return [];
  const forms = new Set<string>([secret]);
  if (secret.length >= MIN_FORM_LEN) {
    forms.add(encodeURIComponent(secret));
    forms.add(JSON.stringify(secret).slice(1, -1));
    forms.add(unicodeEscaped(secret));
    for (const url of [false, true]) for (const p of base64Parts(secret, url)) forms.add(p);
  }
  return [...forms].filter((f) => f.length >= Math.min(MIN_FORM_LEN, secret.length));
}

/** `text` with every spelling of every secret replaced by `***`. */
export function maskSecrets(text: string, secrets: Iterable<string>): string {
  let out = text;
  const exact: string[] = [];
  const loose: string[] = [];
  for (const s of new Set(secrets)) {
    if (s === "") continue;
    const forms = formsOf(s);
    // a short secret: exact form only; otherwise every form, ignoring the letter case
    (s.length >= MIN_FORM_LEN ? loose : exact).push(...forms);
  }
  const apply = (forms: string[], flags: string) => {
    if (forms.length === 0) return;
    const alt = [...new Set(forms)].sort((a, b) => b.length - a.length).map(regexEscape).join("|");
    out = out.replace(new RegExp(alt, flags), MASK);
  };
  apply(loose, "gi");
  apply(exact, "g");
  return out;
}
