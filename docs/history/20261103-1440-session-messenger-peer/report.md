# center が起動する session を messenger の peer にする

branch: `fix/session-messenger-peer`（`origin/fix/remote-done-notify` から切った）

## 原因

- center の完了通知は owner の session 名の messenger peer へ `push` する（`notifyPeer`）。
- `session_create` の session は pty wrapper 経由の `claude --remote-control <name>` で、agent-messenger に接続していなかった。peer が見つからず `notifyError` になっていた。

## 届け方と根拠

`--mcp-config` の JSON に stdio の MCP `bantou-messenger` を足す。`npx -y @unagents/messenger@0.12.2 mcp`（agent-messenger の `plugins/messenger/.mcp.json` と同じ起動）、env `AGENT_MESSENGER_NAME=<session 名>`。

根拠（agent-messenger 0.12.0 のコードと README）:
- `packages/client/src/config.ts`: `name` は `AGENT_MESSENGER_NAME`。登録時に broker へ送る。
- `packages/client/src/session.ts` `postToSession`: 受信は Claude Code の inbox socket（`CLAUDE_CODE_MESSAGING_SOCKET`、claude が MCP 子プロセスへ継承、2.1.224 以降）へ書く。会話に別セッションのメッセージとして現れる。`push` は本文そのもの。
- broker は client が env → `client.json`・旧 config → UDP 発見 → `127.0.0.1:7901` で解決する。center は指名しない。
- pty への文字の書き込みは使っていない。channel（`--dangerously-load-development-channels`）は socket が使えない時の代替なので付けない。

選択肢の比較:
- A: `--mcp-config` に足す（採用）。起動のたびに組み直すので再起動・`--continue` で同じ名前になる。ファイルを書かない。
- B: session の `.mcp.json` / `~/.claude.json`。ファイル書き換え・承認プロンプトの問題で設計書が不採用にしている。
- C: claude 本体の env に名前を入れる。plugin 入りの環境で同名 peer が 2 つ並ぶので不採用（名前は MCP の env にだけ入れた）。

entry 名は `bantou-messenger`。user scope の `agent-messenger` と同名にすると、どちらが勝つか未確認なので別名にした。

## 同名・古い登録

- broker は同じ pid + hostname の再登録だけを置き換える（`handlers.ts` `register`）。再起動で pid が変わるので、旧 client が unregister せず落ちると heartbeat 失効（60 秒）まで同名が 2 件並ぶ（実測で確認）。
- `notifyPeer` を、同名が複数なら `registered_at` が最新のものへ送るようにした（以前は先頭）。
- 並んでいる間、他 peer の名前宛て `send_message` は broker が ambiguous で拒否する（id 宛ては届く）。直していない。
- `mcpUrl`（bantou の窓口）が無い時も `--mcp-config` を付け、messenger だけを入れる（以前はフラグごと無し）。

## 変更ファイル

- `packages/center/src/wrapper.ts`: `mcpConfigJson(url|null, session)` に messenger entry。`MESSENGER_VERSION`、`MESSENGER_SERVER_KEY`。
- `packages/center/src/remote-control.ts`: 常に mcp-config を渡す。
- `packages/center/src/server-link.ts`: `LinkPeer` に `registered_at` / `last_seen`、`notifyPeer` の選択。
- `packages/center/test/remote-control-wrapper.test.ts`, `test/server-link.test.ts`
- `docs/design/master-cap-session.md`（6.1 を追加）、`packages/center/README.md`

## テスト

- center: `bun run test` 254 件 pass / 0 fail（既存 252 + 新規 2）、`bun run typecheck` エラーなし。
- 新規: `notifyPeer` の同名複数、`--continue` 再起動で同じ peer 名。変更: 起動引数の期待値、mcpUrl なし、`mcpConfigJson`。
- 結合（commit していない node script、作業 dir 内）:
  - 0.12.0 の broker を 127.0.0.1:17951 で起動し、実 `createServerLink().notifyPeer` → broker → 実 client（`mcpConfigJson` の entry をそのまま起動）→ inbox socket、の push 到達を確認。
  - client を SIGKILL して再起動すると同名 2 件が並び、`notifyPeer` が新しい方へ届く。
  - 実 claude 2.1.317 を tmux で起動し同じ `--mcp-config` を渡すと、peer 名 `e2e-pm1` で登録され、着信通知（未読 1 件）が会話に出た。claude 終了で unregister された。この claude は未ログインで応答はしていない。
- desktop は触っていないので cargo test・e2e は未実施。

## 実機で確かめるべきこと

- mac の desktop から起動した center の子プロセスの PATH に `npx` があるか（Finder 起動は PATH が最小）。無いと messenger が起動しない。
- 実 session で、remote 完了時に会話へ push が現れるか（上の確認は pull 通知 + socket 直接の push まで）。
- plugin `messenger` も入っている環境で、`list_peers` の session 名の peer が 1 つか（plugin 側は名前なしで登録される想定）。
- 初回の npx 取得による起動遅れ。center と broker の版差（center は client 0.10.0、session は 0.12.0）。
- config の `projects`（サーバー型）は `--mcp-config` を受けないので対象外。

## merge の順番

1. `fix/remote-result-followup`
2. `fix/remote-done-notify`
3. 本 branch（`fix/remote-done-notify` の上に積んである）

## 後始末と残存物

- 作業 dir の `itest/`（script・broker 状態・出力）は `find -delete` で削除、broker・tmux は停止済み。
- 残存: 作業 dir 内の clone（`bantou/`, `agent-messenger/`）と `node_modules`。作業 dir 外に npx のキャッシュ（`~/.npm/_npx`, `~/.agent-messenger/pkgs`）。
- `bun.lock` は commit していない。version bump なし。develop / main へ push・merge なし。
