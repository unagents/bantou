# 指示書: server の設計更新と Nuxt 化（204）

- 日付: 2026-10-28 / 宛先: 204 remote cap `wcap-bantou` / 置き場: `docs/history/20261028-1600-server-nuxt-flow/task.md`（前版を置き換え）

お前は remote cap。worker（実装 sonnet、調査 opus、Fable 禁止、model 明示）に委譲。質問するな。迷う点は推奨案で進め、報告書に「判断した点」を残せ。段階ごとに commit・push してよい。

## 確定した設計（ユーザーと main cap の合意、2026-10-28）

- **center ↔ server**: agent-messenger の protocol 方式でつなぐ。server は `set_protocol` で bantou protocol の待受として登録する（peer は `bantou-server` 1 つ）。仕様の正本は `unagents/agent-messenger` branch `feature/protocol` の `docs/design/protocol.md`（0.10.0、未公開・実装中）。center から届くのは「起動する cap の情報」を含む protocol メッセージ。server は「どの cap が、どの center（送信元 peer）の依頼で動いているか」を state で管理する。
- **server の責務は 3 つだけ**: (1) center との窓口、(2) cap の起動と resume（stroke 方式、path 分離、`claude -p --session-id|--resume`、stream-json の stdout で結果を受ける）、(3) worker からの報告の受け口。
- **worker は cap の責務**: cap は作業をせず、ユーザー指示を解釈して worker に作業させる。軽い作業は cap 内のサブエージェント（Agent tool）、worktree を切る作業は cap が claudep 方式で別 session を起動する。worker への返答も cap が claudep の resume で渡す。server は worker を起動しない。
- **worker → server**: worker は server を MCP（HTTP）として持つ。cap が worker を起動する時の MCP 設定に、header（または環境変数）で `cap_id` と `worker_id` を入れる。token は使わない（認証は全体で後回し）。worker は MCP tool で進捗・質問・承認依頼・完了を送る。tool はすぐ「受け付けた」を返し、worker はそこでターンを終える。
- **server → cap**: 報告を受けたら、該当 cap を `--resume` で起動し、prompt に報告内容を渡す。cap ごとにキューを持ち、1 つずつ処理する（実行中の cap には、終わってから渡す）。
- **cap → center**: cap の結果（stdout の result）を server が state を見て該当 center へ messenger で返す。

## 段階 0: 設計の文書化
1. `docs/architecture.md` の「server の実行モデル」節を上記で書き換える。旧 `resume_worker` / `spawn_worker` 案は削除する。

## 段階 1: Nuxt 化（機能は現状維持）
2. `server/` を Nuxt 4（Nitro）にする（UI 不要）。stroke（Gitea `grrowapp/stroke` の `server/utils/stroke/`、`server/plugins/`）の作法に寄せる。現行機能（broker 内蔵、peer 登録、`kick_cap`、state.json、孤児回収、retry、`session.env`、SIGTERM 終了、ログ形式）を移植する。`resume_worker` は削除してよい（上記設計で不要）。
3. 配布は `npx bantou` を維持する。`bin` は Nitro の `.output/server/index.mjs` を起動する wrapper。`npm pack` の tarball を一時 dir に install して起動できることを実測する。
4. 既存の unit / e2e を移植して通す。

## 段階 2: worker 報告の受け口（MCP）
5. Nitro に MCP の HTTP endpoint（`/mcp`、Streamable HTTP）を追加する。tool は `report`（`kind: progress|ask|approve|done`、`text`）。header `x-bantou-cap-id` / `x-bantou-worker-id` で送信元を判定し、state に記録して該当 cap のキューへ積む。
6. キューを処理し、cap を `--resume` で起動する。prompt は「worker <id> から <kind>: <text>」の形。
7. e2e（204、内蔵 broker port 0、127.0.0.1、discovery off、実際に claude を起動、`session.env` で `CLAUDE_CONFIG_DIR=/home/vagrant/.claude-agent`）: `kick_cap` で cap を起動 → cap に「server の MCP（URL と header をこの prompt で渡す）を `--mcp-config` に入れた worker を claudep 方式（`claude -p` を `setsid` で親から切り離して起動）で 1 つ起動し、worker に `echo hi` を実行させて `report` done で報告させよ」と指示 → worker の report を server が受ける → cap が resume される → ログで流れを確認。
8. 要検証: cap（`claude -p`）の終了後も、cap が起動した worker プロセスが生き残るか。`setsid` 無しと有りの両方を実測し、報告書に書く。

## 段階 3: protocol 方式（後回し可）
9. agent-messenger 0.10.0 が使える状態なら、center ↔ server を protocol 方式に移す（bantou protocol の `protocol.json` を repo 内に用意）。使えなければ段階 3 は着手せず、報告書に状況を書く。

## 共通
- commit は英語、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` と `Claude-Session: https://claude.ai/code/session_01QXMk7Wq5ZbKa3Aiihhk9Qw`。`origin develop` へ push。main は触らない。
- 禁止: desktop/・plugin/・packages/center の変更（protocol の型追加は可）、本番 broker、sudo、python、tmux、質問。
- 報告 `docs/history/20261028-1600-server-nuxt-flow/report.md`（commit・push）。段階ごとの結果、e2e ログ抜粋、npx 起動の実測、段階 2 の 8 の実測、判断した点、未解決。
