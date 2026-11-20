/**
 * tool の inputSchema（Claude に渡る JSON Schema）の `pattern` に出す正規表現。
 *
 * protocol の AGENT_ID_PATTERN / MODEL_PATTERN と同じ文字列を受け付ける。違いは書き方だけで、
 * 文字 class の中の `[` `]` `-` をすべて escape してある（`new RegExp(p, "v")` と `"u"` の両方で compile できる形）。
 * escape の無い `[` を文字 class に持つ pattern は Claude の API が「JSON schema is invalid」として弾き、tool が 1 つも読み込めなくなる。
 * protocol の定数は protocol.json の定義と同じ文字列である事が要るので、そちらは変えずにここへ置く。
 * 同じ文字列を受け付ける事は test/schema-patterns.test.ts で確かめる。
 */
export const AGENT_ID_SCHEMA_PATTERN = /^[A-Za-z0-9_\-]+$/;

/** 先頭は `-` 不可（引数として解釈されるのを防ぐ）。 */
export const MODEL_SCHEMA_PATTERN = /^[A-Za-z0-9._\[\]][A-Za-z0-9._\[\]\-]*$/;
