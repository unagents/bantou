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

- `messenger/`: agent-messenger の protocol 定義（`protocol.json` と `PROTOCOL.md`、name `bantou`）。`server.ts` の型と一致させる（`MESSENGER_PROTOCOL` と test で確認）。server が `setProtocol` で登録し、npm package `bantou` に同梱される（`packages/server/scripts/copy-protocol.mjs`）。

## 定義を変える時（版を上げる）

- `messenger/protocol.json`（parse 後の値で比較。空白・改行は無関係）か `messenger/PROTOCOL.md`（1 byte でも）を変えたら hash が変わる。**必ず版を上げる**: `protocol.json` の `version` と `src/server.ts` の `MESSENGER_PROTOCOL.version` を上げ、`messenger/versions.json` に `"<版>": "<hash>"` を 1 行足す。optional 項目の追加・文言の直しも同じ。
- hash は agent-messenger の `sha256(canonicalJSON({manifest, doc}))`。`test/versions.test.mjs` が「今の定義の hash = 今の版に記録した hash」を確かめる。版を上げずに定義を変えると落ちる。
- 複数 hash を持てるのは過去の例外（1.6.0 / 1.8.0）だけ。test が固定している。同じ版の別定義は broker が `PROTOCOL_CONFLICT` で断り、後から更新された server が center の発見から消える（2026-11-11 の事故）。
- 版を上げると center（版が完全一致）が旧版の server へ `task` / `status` を送らなくなる。server を先に publish する。
- 型・ガード・`docs/protocol.md` だけの変更は定義ではないので版は要らない。

## 未定義

server コマンドの仕様文は `docs/protocol.md` の「bantou-server commands」節に記載済み。

## 利用側

- desktop フロント（`packages/desktop/`）
- server（`packages/server/`）
- plugin（`packages/plugin/bantou`）

## 開発

```
bun install
bun run typecheck
bun run build
bun run test
```
