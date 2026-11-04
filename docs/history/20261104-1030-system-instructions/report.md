# システム埋め込み指示・--no-chrome の削除・store の tmp 衝突

2026-11-04。branch `feature/system-instructions`。

- `packages/center/src/system-instructions.ts`: 部品 `master-cap-role@1`（master-cap は作業せず remote-cap に指示。道具・分担・報告の決まり）。`buildSystemInstructions` が部品を空行で結合、supervisor が利用者の追加指示の前に付ける。status に `systemInstructions`、`center_info` に部品一覧。設計: `docs/design/system-instructions.md`。
- `packages/center/src/wrapper.ts`: `--no-chrome` を外した。
- `packages/center/src/store.ts`: 書込ごとに違う tmp 名（同じ pid の同時 save で `rename` が ENOENT になっていた。center.log の「remotes 保存失敗」）。
- テスト: center 410 件中 407 pass（残り 3 件は macOS 環境起因の既知）。typecheck OK。desktop は変更なし。
