# 指示書: server の Nuxt（Nitro）化と cap / worker 連携の実装（204）

- 日付: 2026-10-28 / 宛先: 204 remote cap `wcap-bantou` / 置き場: `docs/history/20261028-1600-server-nuxt-flow/task.md`

お前は remote cap。worker（実装 sonnet、調査 opus、Fable 禁止、model 明示）に委譲。質問するな。迷う点は推奨案で進め、報告書に「判断した点」を残せ。作業量が大きいので段階ごとに commit・push してよい。

## 背景（確定）
- `docs/architecture.md` を先に読め。server は stroke 方式の headless 実行層（現状の素の TS 実装、`server/src/`）。
- 方針: server を Nuxt 4（Nitro）に移す。stroke（Gitea `grrowapp/stroke`、`server/utils/stroke/`、`server/plugins/`）の作法に寄せる。messenger 連携は `@unagents/messenger-nuxt`（1 Nuxt server = 1 peer）が使えるなら使う（無理なら現状の `createMessengerClient` を Nitro plugin で包む）。
- worker → server の kick は、server 内蔵の agent-messenger 経由で行う。server が worker / cap を起動する時に `claude -p --mcp-config <json>` で messenger の MCP（`npx -y @unagents/messenger mcp`、env `AGENT_MESSENGER_HOST=127.0.0.1`、`AGENT_MESSENGER_PORT=<内蔵 broker の port>`、discovery off）を持たせる。worker / cap は `send_message` で `bantou-server` 宛に bantou protocol の JSON を送る。

## 段階 1: Nuxt 化（機能は現状維持）
1. `server/` を Nuxt 4 アプリにする（UI ページは不要、`server/` 配下の Nitro だけでよい）。現行の機能（broker 内蔵、peer 登録、`kick_cap` / `resume_worker` / `status`、state.json、孤児回収、retry、`session.env`、SIGTERM 終了、ログ形式）を移植する。config は runtimeConfig + `--config` の JSON。
2. 配布: `npx bantou` を維持する。`bin` は Nitro の `.output/server/index.mjs` を起動する薄い wrapper。`npm pack` で `.output` を同梱し、`npx` 相当（tarball を一時 dir に install して実行）で起動できることを実測する。
3. 既存の unit / e2e を移植して通す。

## 段階 2: cap / worker 連携
4. protocol（`packages/protocol/src/server.ts`）に追加:
   - `spawn_worker`（cap → server）: `{ worker_id, prompt, repo?, branch?, cap_id }`。worker の path を作り新規起動。worker と cap の対応を state に残す。
   - `worker_report`（worker → server）: `{ worker_id, kind: "done"|"ask", text }`。受けたら対応する cap を `--resume` で起動し、prompt に report を渡す。
   - cap の判断は cap 自身が `resume_worker`（既存）を send して worker に返す。
5. cap / worker 起動時に messenger MCP を `--mcp-config` で注入し、system prompt（`--append-system-prompt`）で「自分の id、送り先 `bantou-server`、使う type」を伝える。
6. e2e（204 で実行、内蔵 broker port 0、127.0.0.1、discovery off）: 外部から `kick_cap`（prompt: worker を 1 つ spawn して「`echo hi` を実行して done で報告しろ」と指示させる）→ cap が `spawn_worker` を send → worker が実行して `worker_report` done を send → server が cap を resume → cap が `cap_result` 相当で完了。ログで流れを確認。実際に claude を起動する（`CLAUDE_CONFIG_DIR=/home/vagrant/.claude-agent`、config の `session.env` で渡す）。
7. README と `docs/protocol.md`、`docs/architecture.md` を更新。

## 共通
- commit は英語、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` と `Claude-Session: https://claude.ai/code/session_01QXMk7Wq5ZbKa3Aiihhk9Qw`。`origin develop` へ push。main は触らない。
- 禁止: desktop/・plugin/・packages/center の変更（protocol の型追加は可）、本番 broker、sudo、python、tmux、質問。
- 報告 `docs/history/20261028-1600-server-nuxt-flow/report.md`（commit・push）。段階ごとの結果、e2e ログ抜粋、npx 起動の実測、判断した点、未解決。
