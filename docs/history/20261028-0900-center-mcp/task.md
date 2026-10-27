# 指示書: packages/center（MCP server）の新設（204）

- 日付: 2026-10-28
- 発行: main cap（Mac）
- 宛先: 204 の remote cap（tmux `wcap-bantou`、cwd `/home/vagrant/work/bantou/develop`）
- 置き場: `docs/history/20261028-0900-center-mcp/task.md`

## お前の立場

前回と同じ。remote cap として worker（実装 `sonnet`、調査 `opus`、`model` 明示）に委譲して統括。質問するな。迷う点は推奨案で進め、報告書に「判断した点」として残せ。

## 背景

`docs/architecture.md` が確定事項。center の役割:
- 素のエージェント（Claude Code の session）が MCP tool 経由で cap 運用できる tool 群
- project ごとの `claude remote-control`（server mode、1 project 1 本）の起動・監視・切断復帰
- desktop が裏で起動する（on/off は desktop 設定）。今回は desktop 側は触らず、center 単体で動く形まで

bantou-server（`server/`、commit `d248344`）は headless 実行層で、messenger の peer `bantou-server` に `kick_cap` / `resume_worker` / `status` を送ると動く（型は `packages/protocol/src/server.ts`、`server/README.md` 参照）。

`claude remote-control` の事実（204、claude 2.1.312、`claude remote-control --help`）: `--name <name>`、`--spawn same-dir|worktree|session`、`--capacity N`、`--permission-mode <mode>`、`-c/--continue`（直近 4 時間以内の記録があれば再接続）、`--session-id <id>`。tmux 無しのバックグラウンド起動で `Connected` になることを確認済み。stdout に `https://claude.ai/code/session_...` と `?environment=env_...` の URL が出る。約 10 分のネットワーク断で終了する（公式 docs）。claude.ai の Pro / Max ログインが必要、`ANTHROPIC_API_KEY` が設定されていると失敗する。

## 目的

`packages/center` を TypeScript の MCP server として新設し、(a) remote-control の supervisor、(b) bantou-server への中継 tool を提供する。

## 要件

1. package: `packages/center/`、name `@agent-hand/bantou-center`（publish しない。後で `@unagents` に揃える）、`bin: { "bantou-center": "dist/cli.js" }`、`@modelcontextprotocol/sdk`（最新安定）を使い、transport は stdio。Streamable HTTP は今回やらない（interface 上は transport 差し替え可能に）。Node >=22、devDependencies は typescript / tsx / @types/node、テストは node:test。protocol は `file:../protocol`。
2. config: `--config <path>`、既定 `~/.config/bantou/center.json`。項目: `projects: [{ name, path, spawn?: "same-dir"|"worktree"|"session", permissionMode?, capacity? }]`、`remoteControl: { claude?: "claude", continueOnRestart?: true, restartDelayMs?, maxRestarts? }`、`servers: [{ name, broker: "http://host:port", token? }]`（bantou-server の内蔵 broker への接続先）、`logDir?`。
3. remote-control supervisor（`src/remote-control.ts`）: project ごとに `claude remote-control --name <project> --spawn <mode> --permission-mode <mode> [--capacity N]` を project の path で spawn（tmux 不使用、stdio は pipe、stdout/stderr を `logDir/<project>.log` に追記）。stdout から session URL と environment URL を抽出して保持。プロセス終了時は `restartDelayMs` 後に `--continue` 付きで再起動（`maxRestarts` 超えで `error`）。状態 `stopped|starting|connected|error` を持つ。center の SIGTERM で全 child に SIGTERM → 猶予後 SIGKILL。
4. bantou-server 中継（`src/server-link.ts`）: `@unagents/messenger-client` の `createMessengerClient`（`brokers` に config の broker を明示、discovery off）で各 server の broker に peer `bantou-center` として接続し、`send` で `kick_cap` / `resume_worker` / `status` を送って返信（`cap_result` 等）を待つ（`onMessage` で message_id or 返信の cap_id で対応付け、timeout は config、既定 35 分）。
5. MCP tools（名前は snake_case、入力は zod で検証、出力は JSON テキスト）:
   - `rc_list`: project 一覧と各状態・URL
   - `rc_start { project }` / `rc_stop { project }` / `rc_status { project }`
   - `server_list`: 接続中の bantou-server 一覧と到達性（`/health`）
   - `cap_kick { server, cap_id, prompt, repo?, branch?, reason? }` → `cap_result`
   - `worker_resume { server, worker_id, prompt, repo?, branch? }` → `worker_result`
   - `server_status { server }` → `status_result`
   起動時に config の project を自動起動するかは `projects[].autostart`（既定 false）。
6. テスト:
   - unit: config 検証、stdout からの URL 抽出、再起動ロジック（fake の child を使う）、server-link の返信対応付け（fake broker か messenger-client の差し替え）。
   - e2e（204 で実行、`npm run e2e`）: (1) `remoteControl.claude` を stub スクリプト（`Connected` と URL 風の行を出して常駐し、SIGTERM で終了する）に差し替えて supervisor の start / status / stop / 再起動を確認。(2) 本物の bantou-server を内蔵 broker（port 0、bind 127.0.0.1、discovery off）で起動し、center の `cap_kick`（軽い prompt）→ `cap_result` を MCP client（`@modelcontextprotocol/sdk` の Client + StdioClientTransport）経由で確認。(3) 本物の `claude remote-control` の起動は、204 の権限・分類器で止まる可能性がある。1 回だけ試し、止まったら理由を報告書に書いて stub の結果で代替する。
7. `packages/center/README.md`: 役割、config 全項目、tools 一覧と入出力、起動方法、e2e 手順、未決（Streamable HTTP、認証、desktop からの起動）。
8. `docs/protocol.md` に節を追加してよい（今回のみ docs の変更を許可）: bantou-server コマンド（`kick_cap` / `resume_worker` / `status` と返信）と center の tool 一覧の仕様文。前回報告の未追記分も含める。
9. commit は英語の通常文、`origin develop` へ push。

## 禁止

- tmux の使用。`desktop/`、`plugin/`、`server/` の変更（`server/` はバグ修正が必要なら最小差分で可、報告書に明記）。
- LAN の本番 broker への登録・送信。
- sudo、systemd、/etc、python。
- ユーザーへの質問。

## 完了条件

- `packages/center` の `npm run typecheck && npm run build && npm test` が通る。e2e が 204 で通る（本物 remote-control は任意）。
- `server/` と `packages/protocol` の既存テストが引き続き通る。
- develop に push 済み。

## 報告

- `docs/history/20261028-0900-center-mcp/report.md`（commit して push）。必須: 変更ファイル一覧、コマンド結果、e2e ログ抜粋（stub と本物の両方、本物が止まった場合はその事実）、commit hash、判断した点、範囲外の問題。
- 報告後、次の指示まで待機。
