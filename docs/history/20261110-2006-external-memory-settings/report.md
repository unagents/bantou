# 外部記憶（memory）の読み込み側: 設定・mcp-config・system-instructions・desktop

設計は `docs/design/external-memory.md`（変更なし）。branch `feat/external-memory-settings`。

## 変更点

### center
- `settings.memory`: `{ url, token?, agentId? } | null`。共通 + session。session があれば共通は使わない（`outputStyle` と同じ。項目ごとの合成なし）。null で削除（未設定と null の区別は無い。outputStyle と同じ）。`src/project-settings.ts`（schema / `mergeSettings` / `readSettings` / `composeMemory` / `redactSettings`）。
- 上限: url 2048、token 4096、agentId 64（session 名の上限 `MAX_SESSION_NAME` と同じ）。url は http/https の絶対 URL、`user:pass@` 不可（argv・log に出るため）。token は `[\x21-\x7E]*`（header 安全。空文字 = token 無し）。agentId は `^[A-Za-z0-9_-]+$`（空文字 = 無し）。
- 起動: `mcpConfigJson(url, session, memory?)`（`wrapper.ts:69`）が `mcpServers.memory = { type: "http", url, headers }` を足す。headers は token がある時だけ `Authorization: "Bearer ${BANTOU_MEMORY_TOKEN}"`、常に `X-Agent-Id: <agentId || session 名>`。呼び出しは `remote-control.ts:482`。
- token の env: `remote-control.ts:491-494`（`BANTOU_SESSION_TOKEN` を足す行の直後）。token あり → `env.BANTOU_MEMORY_TOKEN = token`。無し → center 自身の同名 env も消す。env 合成の `childEnv` / `mergeChildEnv` は `remote-control.ts:416` / `:321`（変更なし。env の合成後に上書きする）。
- supervisor: entry に `memory`、`add({memory})` と `setMemory(name, memory)`（次の起動から効く）。`sessions.ts` の `instrOpt` / `updateSettings` / `updateCenterSettings` が `composeMemory` を渡す。
- system-instructions: 部品 `memory@1`（`MEMORY_USAGE`）。部品に `when?(ctx)` を足し（設計書 system-instructions.md の「将来の拡張 2」の実装）、`ctx.memory` が true の session だけに付く。`applicableParts(ctx)`。daemon の `labels` は関数（`applicableParts(ctx).map(partLabel)`）。文面は起動時と判断の前に context / recall を呼ぶ、書き込みは bantou が自動で渡すので自分では呼ばない。設計書に文面の指定は無かったので設計書の要約に合わせて書いた。
- `center_info`: 部品一覧に `memory@1` が出る（title に「設定がある session だけ」）。
- tool の説明（`session_settings_get/update`、`center_settings_get/update`、`session_create` の settings）に memory を追記。
- docs: `docs/design/project-settings.md` の項目表、`docs/design/system-instructions.md`、`packages/center/README.md`。

### token の扱い
- 実値が出る所: 起動する claude の env `BANTOU_MEMORY_TOKEN` と、保存ファイル（`sessions.json` / `center-settings.json`。store は 0600 で書く）のみ。
- 出さない所（test で token の文字列を検索して 0 件を確認）: argv（`--mcp-config` の中身を含む。`${BANTOU_MEMORY_TOKEN}` のまま）、center.log、`RcStatus`（status）、`session_list`、wrapper へ流す入力行、`session_settings_get` / `center_settings_get` と update の応答、desktop の画面（DOM）。`center_info` は設定を含まない。
- `session_settings_get` / `center_settings_get` は token を返さず `{ url, agentId?, tokenSet }` を返す。理由: 応答は master-cap の LLM の文脈にも入り得る（tool は session 向けにも見える）。desktop は「設定済み」の注記と、空のまま保存で現状維持、「保存済みの token を消す」で削除。更新は object ごとの置き換えで、`token` 省略 = 引き継ぎ、`""` = 削除。設計書に token の読み出しの規定が無いので、この判断で進めた（設計書の形は変えていない）。

### session 名と X-Agent-Id
- session 名は `SESSION_NAME = /^[A-Za-z0-9_-]+$/`（`sessions.ts:14`）、64 文字まで（`center-id.ts` の `MAX_SESSION_NAME`）。header 値として安全で、agentId の形式と同じ。agentId 省略時に session 名をそのまま `X-Agent-Id` にできる。
- 注意: session は改名できる（設計書にも記載）。agentId を固定したい時は設定で指定する。改名で session 名の agentId は変わる。

### desktop
- `ProjectSettings.memory` / `SettingsDraft.memory`（`MemoryDraft`: url / token / agentId / tokenSet / tokenClear）、`draftOf` / `toUpdate` / `toCreate` / `draftError` / `emptyDraft`。
- `ProjectSettingsFields.vue` に「外部記憶」の節（`<prefix>-section-memory`、`-memory-url`、`-memory-token`（password 型）、`-memory-agent-id`、`-memory-token-set`、`-memory-token-clear`、`-memory-note`）。共通（SettingsDialog）・歯車（ProjectSettingsDialog）・追加（AddSessionDialog）で共通部品を使うので 3 箇所に出る。
- 検証（draftError）: url は http/https の絶対 URL・user:pass@ 不可・2048、token は ASCII 可視文字・4096、agentId は形式・64。url が空で他が入っていると保存を止める。
- e2e の mock（`e2e/mock/bantou.ts`）に center の memory の振る舞い（置き換え・token 引き継ぎ・マスク）を足した。既存 2 spec の期待値に `memory: null` を足した（update 本文に項目が増えたため）。
- Rust は変更なし（settings は素通し）。`packages/desktop/README.md` を更新。

## 判断
- null と未設定: 保存形では区別なし（outputStyle と同じ）。
- token の header 安全性: 設計書は「token は文字列」。header injection を避けるため可視 ASCII に限定した（CRLF・空白を拒否）。
- url の `user:pass@` 禁止: url は argv・status・log に出るため。
- memory を `servers` のように「起動し直し不要」にはしていない（mcp-config は起動時に決まるので次の起動から。他の項目と同じ）。

## テスト
- center: `npm test`（node --import tsx --test）556 件 pass、`tsc --noEmit` OK。追加分: project-settings（検証・merge・compose・redact）、remote-control-wrapper（mcp-config の形、env、argv/mcp-config/status/list/log/入力行に token 0 件、memory 無しは従来どおり・env 無し、system-instructions の有無と label）、sessions（共通/session の置き換え、マスク、token 引き継ぎ/削除、log・list に token 0 件、保存には入る）、tools（memory の検証と説明）、system-instructions（`when`、memory 無しは role + availability のみの出力）。
- desktop: `nuxt typecheck` exit 0（vue-tsc 可）。e2e: 201 件 pass（このうち session-instructions.spec.ts は 28 件、新規 4 件「external memory」）。
- e2e の手順: bun が無いので `nuxt generate` の静的ビルドを node の簡易サーバー（127.0.0.1:14200）で配信、mock の bundle は `bun build` の代わりに esbuild で同じ出力先に作成、chromium は ms-playwright の chrome を自己完結の一時 config で指定。簡易サーバーは停止しポート解放を確認済み。一時物は作業 dir の中のみ。
- Rust: 変更なし（`cargo test` は未実施）。

## review 第1回（HEAD 81fbbd5）の指摘と対応

1. [medium] url の空白・改行・制御文字: `memoryUrlSchema` に `v === v.trim() && !/[\x00-\x20\x7f]/.test(v)` を追加し拒否。保存値は**正規化しない**（入力のまま）。理由: `u.href` にすると scheme の小文字化のほか、host だけの url に `/` が付くなど利用者の入力と変わる。大文字 scheme（`HTTP://H/mcp`）は有効な URL で claude も解釈でき、接続失敗の原因にならない。desktop の trim は維持し、内部の空白は draftError で止める。test: 前後空白・改行・タブ・内部の空白・NUL・DEL・userinfo（`user@` / `user:pw@`）・非 http（ftp / file / javascript / wss）・`${…}` を拒否、大文字 scheme は通り入力のまま保存されることを確認。
2. [low] url に秘密や `${…}` を書かない: 検証で `${` を含む url を拒否（center の zod と desktop の draftError。test あり）。docs は project-settings.md の memory 行、center README、desktop の欄の help、tool 説明に追記（query の秘密は ps と log に出る／`${…}` は claude が展開して memory の host へ送る）。
3. [low] 改名で `X-Agent-Id`（agentId 未設定時）が変わる点と、固定するなら agentId を設定する旨: project-settings.md、center README、tool 説明（session_settings_update）、desktop の欄の help に追記。
4. [low] 反映は次の起動から（`servers` の起動し直し不要とは違う）: project-settings.md、center README、tool 説明に明記。
5. [low] memory / `memory@1` は session（wrapper 経由）のみで、config の `projects` の rc 直起動には付かない点と、session で共通の memory を無効にする手段が無い点（session の null = 共通に戻る。別 task の課題）: project-settings.md と center README に明記。
6. [low] system-instructions.md の部品の段落順を role → availability → memory に直した。

### 残り
- claude の `--mcp-config` での `${VAR}` 展開は claude の docs に明記が無く未確認。既存の `BANTOU_SESSION_TOKEN` と同じ前提で、実機未検証。
- session だけ共通の memory を無効にする手段（別 task）。

### テスト（第1回対応後）
- center: `tsc` OK、`npm test` 556 件 pass。
- desktop: `nuxt typecheck` exit 0。e2e は session-instructions.spec.ts と session-servers.spec.ts の 34 件 pass（nuxt generate の静的ビルド + node の簡易サーバー 127.0.0.1:14520 + ms-playwright chromium の一時 config）。簡易サーバーは停止し 14520 の解放を確認。
- center の再確認: `cd packages/center && npm run typecheck && env -u BANTOU_SESSION_TOKEN npm test`（BANTOU_SESSION_TOKEN が環境に入ると結果に影響する test があるため、外して実行）。typecheck OK、556 件中 556 件 pass（HEAD 13bfba1 時点）。この環境では BANTOU_SESSION_TOKEN は元々未設定。
