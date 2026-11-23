# @agent-hand/bantou-protocol

bantou の work session ↔ bantou メッセージの共通 TypeScript 型。

## 位置づけ

- 仕様の正本は `docs/protocol.md`。この package はその型表現であり、仕様を定義しない。
- 食い違いがあれば `docs/protocol.md` が勝つ。

## 内容

- `envelope.ts`: v2 の 7 種の型（`LaunchMessage` / `StopMessage` / `AnswerMessage` / `ApproveMessage` / `RejectMessage` / `ServerInfoMessage` / `ServerInfoReply`）、ping の仕様、reply の見出し定数と `formatReply`。
- `paths.ts`: 保存先規約（`~/.local/share/bantou/<workspace-key>/...`）。`workspaceKey` は `/` を `-` に置換。
- `guards.ts`: 7 種のガード（`isLaunchMessage` ほか、`isServerMessage` / `isBantouMessage`）と `parseServerMessage` / `parseServerInfoReply`。通らない物（旧 1.x の message、`callType: "exec"` を含む）は無視する。
- `server.ts`: `MESSENGER_PROTOCOL`、`MODEL_PATTERN` / `isValidModel`、`isProtocolCompatible`。

- `messenger/`: agent-messenger の protocol 定義（`protocol.json` と `PROTOCOL.md`、name `bantou`）。`server.ts` の型と一致させる（`MESSENGER_PROTOCOL` と test で確認）。server が `setProtocol` で登録し、npm package `bantou` に同梱される（`packages/server/scripts/copy-protocol.mjs`）。

## 定義を変える時（版を上げる）

- `messenger/protocol.json`（parse 後の値で比較。空白・改行は無関係）か `messenger/PROTOCOL.md`（1 byte でも）を変えたら hash が変わる。**必ず版を上げる**: `protocol.json` の `version` と `src/server.ts` の `MESSENGER_PROTOCOL.version` を上げ、`messenger/versions.json` に `"<版>": "<hash>"` を 1 行足す。optional 項目の追加・文言の直しも同じ。
- hash は agent-messenger の `sha256(canonicalJSON({manifest, doc}))`。`test/versions.test.mjs` が「今の定義の hash = 今の版に記録した hash」を確かめる。版を上げずに定義を変えると落ちる。
- 複数 hash を持てるのは過去の例外（1.6.0 / 1.8.0）だけ。test が固定している。同じ版の別定義は broker が `PROTOCOL_CONFLICT` で断り、後から更新された server が center の発見から消える（2026-11-11 の事故）。
- patch だけの上げ（通信の形を変えない版の付け直し）は center が通す（下の「版の互換」）。
- 型・ガード・`docs/protocol.md` だけの変更は定義ではないので版は要らない。

## 版の互換

- `isProtocolCompatible(a, b)`（`src/server.ts`）: major と minor が同じなら互換、patch の差は通す。形が崩れた版（空・非数・桁欠け・先頭 `v`・pre-release 付き・`undefined`）は互換でない（false）。
- 通信の形を変える定義の変更は minor 以上を上げる。patch は形を変えない付け直し専用（1.8.0 → 1.8.1 のような版の付け直し）。patch を上げても center は止まらない。
- 定義の版（`protocol.json` / `versions.json`）の扱いは上の「定義を変える時」のまま。互換の判定は版の上げ方を緩めない。

## 未定義

v2 の仕様文は `messenger/PROTOCOL.md`。

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
