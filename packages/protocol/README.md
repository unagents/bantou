# @agent-hand/bantou-protocol

bantou の work session ↔ bantou メッセージの共通 TypeScript 型。

## 位置づけ

- 仕様の正本は `docs/protocol.md`。この package はその型表現であり、仕様を定義しない。
- 食い違いがあれば `docs/protocol.md` が勝つ。

## 内容

- `envelope.ts`: 共通フィールド、`TaskMessage` / `AskMessage`、ping の仕様、reply の見出し定数と `formatReply`。
- `paths.ts`: 保存先規約（`~/.local/share/bantou/<workspace-key>/...`）。`workspaceKey` は `/` を `-` に置換。
- `guards.ts`: `isEnvelope` / `isTaskMessage` / `isAskMessage` / `parseEnvelope`。
- `server.ts`: desktop・peer → bantou-server のコマンド `kick_cap` / `resume_worker` / `status` と reply `cap_result` / `worker_result` / `status_result` / `error` の型、ガード（`isServerCommand` / `isServerReply` / `parseServerCommand` / `parseServerReply`）。

## 未定義

server コマンドの型は `server.ts` で定義済み。その仕様文は `docs/protocol.md` に未記載（追記予定）。

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
