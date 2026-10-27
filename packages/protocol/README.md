# @agent-hand/bantou-protocol

bantou の work session ↔ bantou メッセージの共通 TypeScript 型。

## 位置づけ

- 仕様の正本は `docs/protocol.md`。この package はその型表現であり、仕様を定義しない。
- 食い違いがあれば `docs/protocol.md` が勝つ。

## 内容

- `envelope.ts`: 共通フィールド、`TaskMessage` / `AskMessage`、ping の仕様、reply の見出し定数と `formatReply`。
- `paths.ts`: 保存先規約（`~/.local/share/bantou/<workspace-key>/...`）。`workspaceKey` は `/` を `-` に置換。
- `guards.ts`: `isEnvelope` / `isTaskMessage` / `isAskMessage` / `parseEnvelope`。

## 未定義

desktop ↔ server の通信仕様は未設計。型は作っていない。

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
