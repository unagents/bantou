# master-cap の常時待機（master-cap-availability）

2026-11-10。branch `feat/master-cap-availability`。

## 変更点
- `packages/center/src/system-instructions.ts`: 部品 `MASTER_CAP_AVAILABILITY`（`master-cap-availability@1`）を足し、`SYSTEM_INSTRUCTION_PARTS` で `MASTER_CAP_ROLE` の次に並べた。既存部品の文面は変えていない。
- `packages/center/test/system-instructions.test.ts`: 2 つ目に並ぶ・要点語・label・結合順（空行区切り）・describe が 2 件、の test を追加。
- `docs/design/system-instructions.md`、`packages/center/README.md`: 部品を 1 件追記。
- tools.test.ts の center_info test は部品を注入する形で件数を固定していないため変更不要。

## 文面（全文）
```
[常に指示を受けられる状態]
- master-cap は、利用者の指示をいつでも受けられる状態で働く。自分の turn を長く塞ぐ作業（ビルド、テスト、release、長い待ち、長い調査）はしない。
- 時間のかかる作業は預ける。まず remote-cap（remote_send）。
- この Mac のローカルでしかできない作業（例: release の署名ビルドや publish、ローカルの鍵や道具が要るもの）は、上の「自分では実装・ビルド・テストをしない」の例外として、ローカルのサブエージェント（Agent tool）か background 実行（Bash の run_in_background）に任せる。自分は結果の通知を待つ。
- 待つ時は turn を終えて通知で受ける。remote_wait や長い foreground の command で turn を塞がない。
- 預けた作業が動いている間も、利用者の新しい指示には普通に応える。並行の指示が、動いている作業と独立なら、すぐ別の worker / サブエージェントへ出す。
- 預けた作業の完了・失敗は通知（task_result、worker の report、background の完了）で受ける。結果を確かめてから、利用者に短く報告する。
- 利用者の判断が要る点が出たら、他にできる事を先に進めてから聞く。
```

## 判断
- 既存部品を変えない指定のため、「自分では実装・ビルド・テストをしない」との矛盾は、新部品側で「上の…の例外として」と明示して解消した。
- 部品は session 名を使わないので `text: () => ...`。
- title は 1 行。

## テスト結果
- `npm run typecheck`（packages/center）: OK。
- `npm run test`（node --import tsx --test）: 507 件中 507 pass、fail 0。
- bun は host に無いため npm install --no-package-lock -w で代替。bun.lock は変更なし。

## 残課題
- なし。version bump はしていない。
