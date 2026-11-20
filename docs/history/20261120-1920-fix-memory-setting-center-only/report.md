# fix/memory-setting-center-only report

外部記憶（memory）の設定を、利用者向けの画面（desktop と web）から触れないようにし、center の側だけで扱う。

## 基点

- 基点: origin/develop の 2009f18（3 本の merge（task-status / coordinator-read / base-spec-instructions）が入った後の先頭）。
  開始時は e17b62d で、作業中に develop が進んだので、新しい先頭 2009f18 に取り直した。最後の push 前の `git ls-remote` でも先頭は 2009f18 のまま。
- commit: 4c51914（本体）、f0245b0（e2e と README）、本 report の commit。

## 変えた事

- 画面: `ProjectSettingsFields.vue` の外部記憶の欄と、それに付く draft の処理（`sessionInstructions.ts`、`types/index.ts`）を外した。画面は memory の項目を送らない。
- center: 外部記憶の設定は center の状態 dir の `memory-settings.json`（mode 0600、共通と session ごと）に持つ（`src/memory-settings.ts`）。
  MCP の更新（`session_create` の settings / `session_settings_update` / `center_settings_update`）が `memory` を含むと（null も）理由つきで断り、他の項目も保存しない。
  get と update の応答は memory を返さない。旧形式（`sessions.json` / `center-settings.json` の `settings.memory`）は起動時に `memory-settings.json` へ移して元から消す（値は log に出さない）。
- web: center-client の `tool-policy.ts` に引数の検査（`webToolArgsRefusal`）を足し、memory を含む `settings` は center へ送る前に断る（400）。許可の一覧の tool 名は変えない（他の項目の読み書きは今のまま）。web backend の `session_update_settings` の command も `normalizeSettings` で同じ方針。
- CLI: `bantou-center memory`（下記）。

## 閉じた経路の一覧

| # | 経路 | 閉じ方 |
|---|---|---|
| 1 | 画面の外部記憶の欄（session の設定・設定ダイアログの全 session 共通の設定。desktop・web 共通の ProjectSettingsFields.vue） | 欄を削除。draft も memory を持たない |
| 2 | 追加ダイアログ（session_create の settings） | 画面は memory を送らない。center も含まれていれば断る |
| 3 | desktop: Tauri command `session_update_settings`（Rust の素通し → center の `session_settings_update`） | Rust は変えない。center が memory を含む settings を断る |
| 4 | desktop: Tauri command `session_create`（Rust の素通し → center の `session_create`） | 同上（center が断る） |
| 5 | desktop: `center_call` 経由の `center_settings_update`（ui/api/center.ts → Rust の素通し） | 同上（center が断る） |
| 6 | web: backend command `session_update_settings`（commands.ts） | `normalizeSettings` が memory を含む settings を 400 で断る |
| 7 | web: 許可の一覧の `center_settings_update` / `session_settings_update` / `session_create` を直接呼ぶ経路（`McpClient.callTool`） | `refuseArgs` が center へ送る前に断る（400）。center も断るので二重 |
| 8 | web: `center_settings_get` / `session_settings_get` / update の応答 | center が memory を返さない（token が browser に出ない） |
| 9 | master-cap の session 向けの窓口 `/mcp/session` | 設定の tool が元から無い（足していない） |
| 10 | `/mcp`（master-cap など他の呼び出し元と画面を見分けられない） | 全員に断る。center の側の設定は CLI だけ |

「外部記憶が設定済みかどうか」を画面に出している所は無かったので、足していない。

## CLI の使い方（`bantou-center memory`）

```
bantou-center memory get   [--config <path>] [--session <name>]
bantou-center memory set   [--config <path>] [--session <name>] --url <url> [--agent-id <id>] [--token-stdin | --token-file <path> | --clear-token]
bantou-center memory unset [--config <path>] [--session <name>]
```

- `--session` を省くと全 session 共通。session の値があれば共通の値は使わない。
- token は引数に書けない（`--token` は断る）。`--token-stdin` か `--token-file`。`get` の表示は token を伏せ、設定済みかどうかだけ出す。log にも出さない。
- center が動いている間に変えてよく、次に起動する session から効く。
- 同梱の center を使う人は `--config ~/.local/share/bantou/center.json` を付ける。詳細は `packages/center/README.md` の「外部記憶の設定」（1 か所にまとめた）。
- master-cap の session 向けの道具には足していない（session が自分の接続先や token を書き換えられる口を作らない）。

## 確認（f0245b0 の状態）

| 確認 | 結果 |
|---|---|
| packages/center typecheck | 通過 |
| packages/center test | 664 件中 663 pass・1 fail。落ちた test: 「center を SIGKILL すると rc が孤児で残り、次の center の起動で回収される」（既知の不安定 test。develop でも落ちる） |
| packages/center-client test | 232 件 pass・0 fail |
| packages/web typecheck | 通過 |
| packages/web test | 90 件 pass・0 fail |
| packages/desktop typecheck（ui を含む。ui 単体の typecheck script は無い） | 通過 |
| desktop e2e: settings + settings-remote-center | 31 件 pass（2.4 分） |
| desktop e2e: session-instructions + session-add | 44 件 pass（3.4 分。外部記憶の欄が無い事・画面の保存が memory を送らない事を確かめる新 test 3 件を含む） |
| web e2e: settings | 8 件 pass（build の後。11.9 秒） |

- 変異: `assertNoMemory`（project-settings.ts）の判定を無効にすると、新しい test 3 件が落ちた（project-settings の assertNoMemory、sessions の memory 断り、tools の session_settings_update / center_settings_update）。戻して元の状態にした。
- 保存画像: `settings-common-section.png`（設定ダイアログの「全 session 共通の設定」。外部記憶の欄が無い。token・内部の値は写っていない）。

## 回さなかった確認

- web e2e の settings 以外（session-list / terminal）: 設定の組の範囲外のため。
- ui 単体の typecheck: script が無い（desktop の typecheck が ui を取り込んで検査する）。

## 判断

- `/mcp` は画面と master-cap を見分けられないため、memory を含む更新は呼び出し元によらず断る方針にした（設定は CLI だけ）。
- web は center の断りに加えて center-client 側でも送る前に断る（許可の一覧の名前は変えず、引数で見る）。
- 画面からの保存で既存の memory が消えない事は、center が未送信の項目を保持する動きと、memory を別 file（`memory-settings.json`）に分けた事で保証した。
- Rust・protocol・server・packages/memory は変えていない。
- 一時の playwright 設定（`pw.tmp.config.ts`）は commit していない。
