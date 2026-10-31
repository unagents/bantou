# @agent-hand/bantou-protocol

bantou の work session ↔ bantou メッセージの共通 TypeScript 型。

## 位置づけ

- 仕様の正本は `docs/protocol.md`。この package はその型表現であり、仕様を定義しない。
- 食い違いがあれば `docs/protocol.md` が勝つ。

## 内容

- `envelope.ts`: 共通フィールド、`TaskMessage` / `AskMessage`、ping の仕様、reply の見出し定数と `formatReply`。
- `paths.ts`: 保存先規約（`~/.local/share/bantou/<workspace-key>/...`）。`workspaceKey` は `/` を `-` に置換。
- `guards.ts`: `isEnvelope` / `isTaskMessage` / `isAskMessage` / `parseEnvelope`。
- `server.ts`: desktop・peer → bantou-server のコマンド `kick_cap` / `resume_worker` / `stop_cap` / `status` / `hello` / `update_server` と reply `cap_result` / `worker_result` / `stop_result` / `status_result` / `hello_result` / `update_result` / `error` の型、ガード（`isServerCommand` / `isServerReply` / `parseServerCommand` / `parseServerReply`）。

- `messenger/`: agent-messenger の protocol 定義（`protocol.json` と `PROTOCOL.md`、name `bantou`）。`server.ts` の型と一致させる（`MESSENGER_PROTOCOL` と test で確認）。server が `setProtocol` で登録し、npm package `bantou` に同梱される（`server/scripts/copy-protocol.mjs`）。

## 未定義

server コマンドの仕様文は `docs/protocol.md` の「bantou-server commands」節に記載済み。

## 利用側

- desktop フロント（`desktop/`）
- server（`server/`）
- plugin（`plugin/bantou`）

## 開発

```
bun install
bun run typecheck
bun run build
bun run test
```
