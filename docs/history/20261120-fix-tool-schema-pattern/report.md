# fix/tool-schema-pattern: worker_start の schema を API が弾く不具合

- 日付: 2026-11-20
- branch: `fix/tool-schema-pattern`（基点 develop `7e086d7`）

## 原因

server が cap に MCP で渡す tool `worker_start` の入力 schema の `model.pattern` が
`^[A-Za-z0-9._[\]][A-Za-z0-9._[\]-]*$` で、文字 class の中の `[` が escape されていなかった。
Claude の API はこの schema を `400 tools.N.custom.input_schema: JSON schema is invalid` で弾く。

- 弾かれた tool の schema を自動で差し替えてやり直さない版の CLI では、cap が `worker_start` を読み込んだ時点で失敗し、worker を 1 体も起動できない。
- 自動でやり直す版の CLI（2.1.323 で確認）では error にならないが、その tool の schema が `{"type":"object"}` に差し替わり、Claude から引数の定義が見えなくなる。

`[` と `]` を escape した `^[A-Za-z0-9._\[\]][A-Za-z0-9._\[\]-]*$` は API を通る。受け付ける文字列は同じ。

## 残した変更

- `packages/server/server/utils/bantou/model.ts`: 自前の正規表現をやめ、protocol の `MODEL_PATTERN` を import して再 export する（protocol の定数は元から `[` `]` を escape した形）。
- `packages/server/server/utils/bantou/mcp.ts`: `worker_start.model` が同じ定数を使う。`worker_id` の 3 か所を定数 `WORKER_ID_PATTERN`（pattern は変更なし）にまとめた。
- test（server / center / memory）: 全 tool の inputSchema の `pattern` を集め、(a) `new RegExp(p, "u")` で compile できる事、(b) 文字 class の中に escape の無い `[` が無い事、を確かめる。
- test（server）: server の `MODEL_PATTERN` が protocol の定数そのものである事。

## 戻した変更と理由

この branch の最初の commit は、判定の基準を `new RegExp(p, "v")` で compile できる事としていた。
`v` は文字 class の中の escape の無い `-` も error にするので、`^[A-Za-z0-9_-]+$` のような、API が現に受け付けている形まで不正と判定した。
その結果 center と memory の pattern まで書き換えていたが、不要なので develop の形に戻した。

- `packages/center/src/schema-patterns.ts` と、その test を削除。
- `packages/center/src/remotes.ts`、`tools.ts`、`sessions.ts`、`login.ts`、`project-settings.ts` を develop の形に戻した。
- `packages/memory/server/utils/events.ts`、`recall.ts` を develop の形に戻した。

## test の基準が推測である範囲

(b)「文字 class の中に escape の無い `[` が無い事」は、API が弾いた 1 例と通した例から作った基準で、API の検査の実装を確かめた物ではない。
本当の基準は、下の API での実証で確かめている。

## API での実証

修正後の code から、server・center・memory の全 tool の inputSchema を書き出し、同じ定義を返す stub の MCP server を作って、CLI から 1 回の request で API に渡した（tool の遅延読み込みを切った状態。model は sonnet）。

| 回 | 渡した tool | 結果 |
|---|---|---|
| 1 | 修正後の 37 個（pattern 38 個） | request は 1 回。全 schema がそのまま API を通った |
| 2 | 修正後の 37 個 + 修正前の `worker_start` の schema 1 個 | 1 回目の request が 400（修正前の schema の tool だけが弾かれた）。CLI がその tool の schema を差し替えてやり直した |

- 修正後の全 schema は API を通る。escape の無い `-` を含む `^[A-Za-z0-9_-]+$` や、zod の datetime / uuid の pattern も含む。
- 修正前の pattern は 400 で弾かれ、弾かれるのはその tool だけ。
- 確かめていない範囲: sonnet 以外の model。memory は tools/list の実物ではなく `z.toJSONSchema` による代用。

## test の結果

| package | test | typecheck |
|---|---|---|
| protocol | 43 / 43 | 通る |
| server | 352 件。3 回回して 351 / 352 / 351 | 既知の `default-config.test.ts` の 6 件のみ |
| center | 619 件中 616 | 通る |
| memory | 54 / 54 | 通る |
| center-client | 229 / 229 | 通る |
| web | 62 件中 61 | 通る |

落ちた test は、どれも develop でも落ちる不安定な物。

- center: 「add: wrapper 設定が無い supervisor では…」「http: 上限超過のボディは 413」「添付: 型違い…」
- web: 「attachments: 型違い 415…」（EPIPE）
- server: `cleanup.test.ts` の一時 dir の片付けで時々落ちる（`ENOTEMPTY`）。`cleanup.test.ts` だけを 5 回ずつ回すと、修正後は 5 回とも通り、develop の内容に戻すと 5 回中 3 回通った。

修正前の server の code に戻すと、足した test は `worker_start.model` の 1 件で落ちる。center と memory は修正前でも通る。
