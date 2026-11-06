# path-picker: パス指定をフォルダ選択ダイアログ形式に統一

branch: feature/path-picker（base: develop 8265347）

## 変更点（packages/desktop のみ）
- 新規 `src/components/PathField.vue`: `canPick` true で読み取り専用 + 欄クリック/Enter または「選択…」でフォルダ選択ダイアログ（`pickDirectory`）。取り消しは値を変えない。false は従来の text 入力。
- AddSessionDialog `add-folder` / ProjectSettingsDialog `settings-path` / SettingsDialog `center-workspace` を PathField 化。旧 `pick()` / `pickWorkspace()` は孤児になるため削除。help 文言を更新。
- ProjectSettingsFields（共通/個別）: 参照フォルダ行を PathField 化（`<prefix>-add-dir`）。canPick 時の「追加」は空行を作らずダイアログを開いて直接 1 行追加（取り消しは何も足さない）。canPick false は従来の「パスを入力して追加」。
- 保存ロジック（toUpdate/toCreate/draftError、ADD_DIRS_MAX 20、絶対パス検証）は無変更。center 側 tool/スキーマも無変更。
- README（packages/desktop）の該当 2 箇所を更新。

## testid
- 維持: center-workspace / center-workspace-pick / settings-path / settings-path-pick / settings-path-move / add-folder / add-folder-pick / `<prefix>-add-dir` / `<prefix>-add-dir-add` / `-remove`
- 変更: `<prefix>-add-dir-pick`（追加ボタン）を廃止。canPick 時の追加は `<prefix>-add-dir-add`（ラベル「フォルダを追加…」）が担う。行ごとのボタンは新規 `<prefix>-add-dir-row-pick`。spec と README を同時更新。

## テスト結果
- e2e（nuxt generate の静的ビルド + 簡易サーバー + ms-playwright chromium）: 119 passed / 0 failed。
- 追加・更新した検証: canPick 時の readonly、欄/ボタンで pick が呼ばれ値が入る、取り消しで値不変（add-folder / settings-path / center-workspace / 参照フォルダ行）、参照フォルダ追加で空行が作られない、canPick false で text 入力が残り空行追加・保存まで通る。
- cargo test（src-tauri、空 sidecar 資源）: 262 passed / 0 failed / 5 ignored。Rust は無変更。
- bun.lock の差分は commit していない。

## 残り・判断メモ
- center workspace 欄は元々「sidecar は常にボタンを出す」仕様だったため、常に canPick 扱い（text フォールバック無し）。Linux など rfd が使えない環境の扱いは従来どおり未対応。変更するなら別途判断が必要。
- `nuxt typecheck` は未実行。
- review 指摘と対応: （後で追記）
