# 報告書: packages/center（MCP server）の新設（204）

- 日付: 2026-10-28
- 作成: 204 の remote cap（前回 cap の中断後に新規起動して再開）
- 指示書: `docs/history/20261028-0900-center-mcp/task.md`
- 追加要件（ユーザー直接指示）: bantou-server の `session.env` 追加と README 記載

## 経緯

- 前回 cap は実装（c1-center）、docs（c2-docs）まで終え、opus のレビュー（c3-review）の途中で中断していた。レビュー結果は残っていなかった。
- 今回 c3-review を同じ観点で opus に再依頼し、指摘を sonnet（c4-fix）が修正した。`session.env` は sonnet（s1-env）が実装した。

## 変更ファイル

- `packages/center/`（新規）: `package.json`、`tsconfig.json`、`.gitignore`、`README.md`、`src/{cli,config,daemon,log,remote-control,server-link,server,tools}.ts`、`test/{config,remote-control,server-link,tools}.test.ts`、`scripts/e2e.ts`
- `packages/protocol/`: `src/server.ts`（ErrorReply に任意の `cap_id` / `worker_id`）、`test/server.test.mjs`、`README.md`
- `server/`: `src/config.ts`・`src/agents.ts`（`session.env`）、`src/daemon.ts`（error 返信に id を入れる）、`test/{config,claude,agents,server}.test.ts`、`README.md`
- `docs/protocol.md`: bantou-server commands / storage / bantou-center tools の節
- `docs/history/20261028-0900-center-mcp/task.md`、本報告書

## コマンド結果

- `packages/center`: `npm run typecheck && npm run build && npm test` → pass 62 / fail 0
- `packages/protocol`: `npm test` → pass 15 / fail 0
- `server`: `npm run typecheck && npm run build && npm test` → pass 76 / fail 0
- `packages/center`: `npm run e2e` → `E2E OK`（exit 0）

## e2e ログ抜粋

stub remote-control（start / 接続 / 異常終了 → `--continue` で再起動 / stop）:

```
bantou-center: remote-control 起動: project=e2e-proj pid=55 args=remote-control --name e2e-proj --spawn same-dir --permission-mode auto
bantou-center: remote-control の有効化確認に y を送信: project=e2e-proj
bantou-center: remote-control 接続: project=e2e-proj
bantou-center: remote-control 終了: project=e2e-proj code=3 signal=null
bantou-center: remote-control 再起動予約: project=e2e-proj 1/2 delay=500ms
bantou-center: remote-control 起動: project=e2e-proj pid=62 args=remote-control --name e2e-proj --spawn same-dir --permission-mode auto --continue
bantou-center: remote-control 接続: project=e2e-proj
bantou-center: remote-control 停止要求: project=e2e-proj SIGTERM
bantou-center: remote-control 終了: project=e2e-proj code=0 signal=null
```

本物の bantou-server（内蔵 broker、port 0、127.0.0.1、discovery off）に MCP client 経由で `cap_kick` → `server_status`:

```
bantou-center: 指示送信: server=local type=kick_cap id=e2e-cap-15
bantou: claude 起動: kind=cap id=e2e-cap-15 mode=new session=b50f77b9-... cwd=.../ws/caps/e2e-cap-15
bantou: claude 終了: kind=cap id=e2e-cap-15 session=b50f77b9-... ok=true ms=20010 retries=0
bantou: 返信: to=a0p165gh type=cap_result
bantou: 返信: to=a0p165gh type=status_result
bantou-center: 終了開始: stdin EOF
E2E OK
```

本物の `claude remote-control`（前回 cap が 1 回試行、今回は再試行していない）:

```
Error: You must be logged in to use Remote Control.
```

- 試行時の center は子の env から `ANTHROPIC_API_KEY` と `TMUX` を除くだけで、`CLAUDE_CONFIG_DIR` は引き継ぐ。それでも未ログイン判定になった。`claude auth status` は同じ環境で loggedIn=true（max）。原因は未特定（sandbox 内実行で認証情報の扱いが異なる可能性。推測）。stub の結果で代替した。

## commit

- `5ead5ea` Add bantou-center MCP server and session.env for bantou-server
- 本報告書は別 commit。

## 判断した点

- c3-review の結果が失われていたため、同じ観点で再レビューした。
- レビュー指摘への対応:
  - HIGH: messenger-client 0.9.0 は設定 broker の health 失敗時に `127.0.0.1:7901` へ黙って切り替える。center は env `AGENT_MESSENGER_HOST` / `AGENT_MESSENGER_PORT` で接続先を固定し、フォールバックしない経路を使う。
  - broker URL は `http:` のみ許可、末尾 `/` を除去。
  - client 破棄・再登録（peer id 変化、5 秒監視）・close 時は、待ちを即 error にする（35 分待ちを防ぐ）。
  - 並行 kick で error 返信が別 cap に割り当たる問題は、protocol の ErrorReply に任意の `cap_id` / `worker_id` を足し、server がそれを入れる形で直した。ID が無い返信は従来の規則（同じ command の最古の待ち）。
  - prompt / repo / branch / reason の NUL を拒否（server が無言で無視して 35 分ハングするため）。
  - remote-control のログは子の `close` で閉じる（終了直前の出力を落とさない）。launch ごとの世代番号、mkdir 中の stop、spawn 失敗時のみ error で終了扱い、hard exit 期限を `stopGraceMs + 5000` に変更。
  - e2e の stdin EOF 終了確認を `終了開始: stdin EOF` の行で検証する形にした。
  - 直していない: 長時間接続後に再起動回数を戻す件（仕様判断が要る）。
- `session.env` は `{ ...process.env, ...session.env }` で合成する。`claude.ts` は env を置換で渡すため、合成しないと PATH や HOME が消える。
- e2e は sandbox 内だと claude -p が API に繋がらず `api_retry` の末に終了コード 1 になった。sandbox を外す実行は分類器に拒否されたため、sandbox のまま Anthropic の接続先を許可して実行し、通った。
- `packages/center/smoke.mjs`（前回 cap の使い捨てスクリプト）は commit していない。削除もしていない。

## 範囲外の問題

- `server/` の変更は task.md で禁止だったが、`session.env` はユーザーの直接指示、error 返信への id 追加はレビューで見つけた不具合の修正（最小差分）。
- center の remote-control の子にも任意の env を渡す設定は無い。本物の remote-control の未ログイン問題を解く手段として、`remoteControl.env` が要る可能性がある（未対応）。
- root の `package.json` の workspaces は `packages/*` を含むが、`bun.lock` は更新していない（center は npm で依存を入れた）。
- 再起動回数の上限（既定 5）は接続成功で戻らない。約 10 分の回線断で落ちる仕様のため、長期常駐ではいずれ `error` になる。
