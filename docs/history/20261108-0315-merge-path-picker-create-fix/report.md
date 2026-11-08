# merge: fix/create-duplicate-error + feature/path-picker -> develop

## 内容
- 基点 origin/develop: 8265347bbb128f099080f793b8cac4c59bf6fe23（想定どおり）
- `git merge --no-ff origin/fix/create-duplicate-error`（94caccf）→ d7d46d3、衝突なし
- `git merge --no-ff origin/feature/path-picker`（51d7a92）→ a12f4d9、衝突なし
- merge 後の目視確認: AddSessionDialog.vue / ProjectSettingsDialog.vue に busy ガードと `!busy.value &&` の重複判定が残り、PathField が使われている
- version bump なし、bun.lock の変更は commit せず戻した

## テスト
- packages/protocol: bun run build OK
- packages/center: typecheck OK / test 432 pass, fail 0
- desktop e2e: chromium（playwright bundled）+ 一時 config（channel 指定除去、dev server）で 126 pass / 0 fail

## push
- `git push origin develop`（通常 push）: 8265347..a12f4d9
- ls-remote で 94caccf と 51d7a92 が両方 ancestor であることを確認
- merge 後 HEAD: a12f4d995f9a93ddd6f4dff1df80b4a05e524776（この report commit の前）
