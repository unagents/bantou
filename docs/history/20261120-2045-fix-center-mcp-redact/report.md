# fix/center-mcp-redact（M0）report

## 基点
- origin/develop 先頭 805ebe67df1329fa5de686f53ba5ebd04847fdf9（作業中に進んでいない）。

## 変えた file
- `packages/center/src/remote-control.ts`: `redactAppendSystemPrompt` を `redactSessionArgs` に広げた。`--mcp-config` の JSON を `<mcp: 名前, …>` に、読めない・形が違う時は `<mcp: ?>`。`--append-system-prompt` は今どおり `<N 文字>`。status と log は同じ `shownArgs`（1 か所）。
- `packages/center/src/project-settings.ts`: `assertNoMemory` → `assertCenterOnly`（`memory`・`mcp`・`mcpConnections`・`mcpSecrets`。null も断る。文に値を含めない）。`MEMORY_MCP_ERROR` は別名で残した。
- `packages/center/src/sessions.ts`, `tools.ts`: 呼び出しを `assertCenterOnly` に。
- `packages/center-client/src/tool-policy.ts`, `commands.ts`: web 側も同じ 4 項目を断る（`CENTER_ONLY_REFUSAL`。`MEMORY_REFUSAL` は別名で残した）。
- test: `center/test/{remote-control-wrapper,project-settings,sessions}.test.ts`、`center-client/test/mcp.test.ts`。

## 判断
- 断る文は旧文の語句（「center の側だけ」「MCP からは変えられない」「bantou-center memory」）を残しつつ、MCP の接続も含む文にした（既存 test を保つため）。
- 旧名の export は別名で残し、呼び出し側の破壊を避けた。
- 既存 test の `hay.includes("BANTOU_MEMORY_TOKEN")` は、status / log に出ない仕様に変わったため、実引数（`l.args`）に対する確認へ直した。

## 設計書との食い違い
- 特になし。設計書の `<mcp: …>` の例は entry 名を列挙する形で実装（messenger・bantou・memory がある時はそれらが並ぶ）。
- spawn 失敗の文が引数を含まないかは、実 spawn の error を作る test までは足していない（範囲外とした）。

## test
- center: 679 件中 678 通過、1 件失敗 = 既知の不安定 test「center を SIGKILL すると rc が孤児で残り…」のみ。typecheck は通る。
- center-client: 232 件すべて通過。
- 足した test: 応答（list / start / status）と log に URL（query）・agent の ID・env の参照が出ない、`redactSessionArgs` の不正 JSON、`assertCenterOnly` / web policy / sessions の 3 経路で null 含め断る。

## 変異の確認
- `--mcp-config` の伏せを外す（`out[i+1] = out[i+1]`）と、wrapper の新 test 2 件が落ちた（50 件中 48 通過）。戻して clean を確認。

## その他
- 一時の IPv4 中継（registry だけに向く）を作業 dir の tmp に立てて `bun install --frozen-lockfile` を通した。bun.lock は変わっていない。
