# システム埋め込み指示（system instructions）の設計

2026-11-04。実装は `packages/center/src/system-instructions.ts`。

## 何か

center が master-cap（session の対話型 `claude --remote-control`）を起動するたびに、`--append-system-prompt` の値の**先頭**に付ける bantou 側の決まり文。利用者が設定で入れる追加指示（center 共通の `settings.instructions`、session ごとの `settings.instructions`）とは**別に管理**する。利用者の設定画面には出さず、編集もさせない。

最初の部品は `master-cap-role`: master-cap は自分では実装・修正・長い調査をせず、remote-cap（server 上のオーケストレーター）に `remote_send` で指示を出し、report と `task_result` で結果を確かめ、利用者に報告する、という運用の案内（remote-cap 側の決まりは `docs/design/cap-orchestration.md`）。

2 つ目の部品は `master-cap-availability`: master-cap は常に利用者の指示をいつでも受けられる状態で働く。ビルド・テスト・release・長い待ちで自分の turn を塞がず、時間のかかる作業は remote-cap に預ける。この Mac のローカルでしかできない作業（release の署名ビルド・publish など）は、ローカルのサブエージェント（Agent tool）か background 実行（`run_in_background`）に任せる（`master-cap-role` の「自分ではしない」の例外）。待つ時は turn を終えて通知で受け、並行の指示には普通に応える。

## 並び

```
<部品 1>

<部品 2>
…

<center 共通の追加指示>

<session の追加指示>
```

部品どうし、部品と利用者の指示の間は空行 1 つ。どれも無ければ `--append-system-prompt` 自体を付けない。session の status の `instructions`（追加指示つきで起動したか）は**利用者の指示だけ**を数え、システム部品は数えない（画面の巻物アイコンの意味を変えない）。

## 部品（part）

```ts
interface SystemInstructionPart {
  id: string;        // 英数字と -。固定
  version: number;   // 文面を変えたら上げる
  title: string;     // 1 行の説明（ログ・center_info 用）
  text: (ctx: { session: string }) => string;
}
export const SYSTEM_INSTRUCTION_PARTS = [MASTER_CAP_ROLE, MASTER_CAP_AVAILABILITY];
```

- 文面は center の package の中に TypeScript の文字列として持つ。ファイル・config・環境変数からは読まない。理由: (1) center の版と一緒に配り、版で内容が決まる。(2) bun で 1 本に compile するので外部ファイルの同梱より単純。(3) テストで文面の要点（道具名、役割）を検証できる。
- 部品が見てよい文脈は `ctx` だけ（今は session 名）。将来 center id や permissionMode を足す時も `ctx` に足す。
- 変更の手順: 文面を直す → `version` を上げる → `test/system-instructions.test.ts` の要点を更新する → 必要なら `docs/design` を直す。部品の追加は配列に足すだけ。
- 見える化: 起動した session の status に `systemInstructions: ["master-cap-role@1", …]`、`center_info` に `systemInstructions: [{ id, version, title }]`。本文は status にも log にも出さない（`--append-system-prompt` の値は長さだけに伏せる）。

## 配線

- `daemon.ts` が supervisor に `systemInstructions: { build(ctx), labels }` を渡す。supervisor は起動のたびに `build({ session })` で文面を作り、利用者の指示と結合して `buildWrapperArgs` に渡す（`remote-control.ts`）。
- `server.ts`（MCP）は `center_info` に `describeSystemInstructions()` を出す。テストでは差し替えられる。

## 将来の拡張（設計だけ。未実装）

1. **部品の有効・無効**: center 共通・session の `settings.systemInstructions.disabled: ["<id>"]` で外せるようにする。合成は `sessions.ts` の `composeInstructions` と同じ場所で、`build(ctx, { disabled })` に渡す。既定は全部有効。
2. **適用条件**: 部品に `when?: (ctx) => boolean` を持たせ、permissionMode や wrapper の有無、server の有無で出し分ける。
3. **文面の差し替え（上級者向け）**: config の `remoteControl.systemInstructionsOverride: { "<id>": "<文面>" }` で部品単位に差し替える。版の追跡が効かなくなるので、ログに `override` と出す。
4. **remote-cap / worker 側との共有**: server の `CAP_GUIDE` / `WORKER_GUIDE` は server package にある。共通化するなら protocol package に「文面の部品」を置き、center と server が同じ版を参照する。今は役割が違う（master-cap は指示を出す側、cap は worker を回す側）ので分けたままにする。

## 外した引数: `--no-chrome`

2026-11-04 に `buildWrapperArgs` から `--no-chrome` を外した（master-cap で Claude in Chrome の道具を使えるようにするため）。元は 2026-11-02 に「Chrome 拡張があると対話型 claude が『Claude in Chrome extension detected』の確認で止まる」ため付けたもの（`docs/history/20261102-0830-terminal-resize-loop/report.md`）。center のホストに Chrome 拡張が入っていると、起動直後にその確認が出て master-cap が止まることがある。その時は desktop のターミナルから答えるか、claude 側の設定で拡張の確認を抑える。
