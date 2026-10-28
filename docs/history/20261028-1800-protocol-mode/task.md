# 指示書: center ↔ server を agent-messenger の protocol 方式へ移行（204）

- 日付: 2026-10-28 / 宛先: 204 remote cap `wcap-bantou` / 置き場: `docs/history/20261028-1800-protocol-mode/task.md`

お前は remote cap。worker（実装 sonnet、調査 opus、Fable 禁止、model 明示）に委譲。質問するな。迷う点は推奨案で進め、報告書に「判断した点」を残せ。

## 前提
- `@unagents/messenger-*` 0.10.0 が npmjs に公開済み（`set_protocol` / `unset_protocol` / `get_protocol`、`list_peers` の protocol 絞り込み、`send` の `meta`）。仕様の正本: `unagents/agent-messenger` の `docs/design/protocol.md`（branch `feature/protocol` もしくは公開版に同梱の docs）。npm の package 内 README / d.ts も確認せよ。
- 確定設計は `docs/architecture.md`。center ↔ server は protocol 方式でつなぐ。server は bantou protocol の待受。server ↔ cap / worker は変更なし。

## 要件
1. protocol 定義: bantou repo 内に `packages/protocol/messenger/protocol.json` と `PROTOCOL.md` を作る（`name: "bantou"`、`version` は semver、`messages` に server コマンド `kick_cap` / `status` と返信 `cap_result` / `status_result` / `error` の JSON Schema。`packages/protocol/src/server.ts` の型と一致させる）。新しい public repo は作らない。server は `set_protocol` に local path（自分の install 先から解決できる path。npm 配布時に同梱されるよう `server` の package に含める）を渡す。
2. server: 依存を `@unagents/messenger-broker` / `-client` 0.10.0 に上げ、起動時に `setProtocol(<local path>)` で待受登録する。受信 message の `meta` を見て bantou protocol のものを処理する（meta 無しの旧形式も当面受ける）。返信は送信元へ `send(..., meta)` で返す。終了時に `unsetProtocol`。
3. center: 依存を 0.10.0 に上げ、server の発見を `listPeers({protocol: "bantou"})` で行えるようにする（config の `servers` は broker の URL のみ指定し、peer 名は自動発見。従来の名前指定も残す）。送信に `meta: {protocol: "bantou", version}` を付ける。
4. desktop の設定に center の `servers`（name と broker URL の配列）を追加し、center.json に書き出す（今は常に空配列）。設定ダイアログに入力欄。
5. テスト: unit を更新。server の e2e（内蔵 broker、port 0、127.0.0.1、discovery off、実 claude、`CLAUDE_CONFIG_DIR=/home/vagrant/.claude-agent`、`--model sonnet`）で、protocol 登録 → center 相当の client が `listPeers(protocol)` で発見 → meta 付き `kick_cap` → meta 付き `cap_result` を確認。center の unit で発見と meta 付与。desktop は `cargo check`、`cargo test --lib center`、`bun run typecheck`。sandbox 外での実行が要るものは権限で止まったら報告書に書いて終われ（main cap が実行する）。
6. version: desktop 0.1.9、server（npm `bantou`）0.2.0。commit（英語、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` と `Claude-Session: https://claude.ai/code/session_01QXMk7Wq5ZbKa3Aiihhk9Qw`）、`origin develop` へ push。main・npm publish・release は触らない。
7. docs: `docs/protocol.md`、`docs/architecture.md`、各 README を更新。
8. 報告 `docs/history/20261028-1800-protocol-mode/report.md`（commit・push）。

禁止: plugin/ の変更、本番 broker、新しい public repo、sudo、python、tmux、質問。
