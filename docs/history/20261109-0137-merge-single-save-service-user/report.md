# merge: fix/settings-single-save + feature/service-user-install → develop

## 基点

- origin/develop: `1f2ce896e32142ba6fed050da9089f7241adf716`（想定どおり）

## HEAD 確認

| branch | 期待 HEAD | 実際 | 結果 |
|---|---|---|---|
| fix/settings-single-save | 160fc97cabb22b412ad07d52a392538898a1031b | 同じ | 一致 |
| feature/service-user-install | 70a7eaba9640bab75e7b1a0e95b086cb827aaef9 | 同じ | 一致 |

## merge 順（`git merge --no-ff`）

1. fix/settings-single-save → `8ffb2a2`
2. feature/service-user-install → `b6154ac`

衝突: なし。

## テスト

- `bun install`: 実行。`bun.lock` が変わったので commit に含めず `git checkout` で戻した。
- packages/protocol `bun run build`: 成功。
- packages/center `typecheck`: エラー出力なし。`test`: 432 pass / 0 fail。
- packages/server `npm test`: 261 pass / 0 fail（期待どおり）。
- `packages/server/scripts/install-service.sh`: `bash -n` OK。`--dry-run` は exit 0。
- packages/desktop `nuxt typecheck`: 検証不能。vue-tsc が `Cannot find module 'vue-router/volar/sfc-route-blocks'` を出す（環境側の問題）。exit 0 だが型検査は実質行われていない。
- packages/desktop e2e: 129 pass / 0 fail。`nuxt generate` の静的ビルドを一時の node サーバー（127.0.0.1:14200）で配信し、ms-playwright の chromium-1243 を指定した一時 config（`retries: 0`）で実行した。サーバー停止とポート解放を確認済み。

## push

- 先: origin/develop のみ（通常 push）。
- push 内容: merge 2 件 + この report の docs commit。push した commit sha は done report に記す。
