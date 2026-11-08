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
- 残り: ProjectSettingsFields の行ボタン「選択…」が全行同じラベルで aria-label が無い（low、今回は直さない）。
- review 第1回の low 5 件のうち、残り 2 件は指示に内訳が無かったため未記載（受領後に追記）。

## review 第1回（HEAD 9159943）の指摘と対応
- [medium] center 起動フォルダ欄が常に readonly で、pickDirectory が使えない環境で編集手段が無い → 対応済み。PathField が pick 失敗時だけその欄を text 入力に切り替える（値保持、エラー emit）。成功・取り消しは readonly のまま。他の canPick 欄も同じ部品なので同様。e2e 追加: settings.spec（workspace 欄、mock `pickError`）、session-path.spec（add-folder）。
- [medium] readonly 欄のキー操作が Enter のみ → 対応済み。Space（preventDefault）追加、canPick 時は欄とボタンに aria-haspopup="dialog"。e2e 追加: Enter / Space で pick が呼ばれ、aria-haspopup が付く。
- [low] pick() の多重呼び出し → 対応済み。busy ガード（e2e では押しっぱなしの検証はしていない）。
- [low] ProjectSettingsDialog の canPick 時 help に「無ければ作られる」が無い → 対応済み。AddSessionDialog と揃えた。
- [low] report 更新 → 本節。
- [low] 行ボタンのラベル / aria-label → 今回は直さない（上の「残り」）。

## review 第2回（HEAD 99a865a）の指摘と対応
- [medium] 参照フォルダの「フォルダを追加…」（pickAdd）が pick 失敗でエラーを出すだけで text へ切り替わらず、ダイアログ不可環境で新規追加の手段が無い → 対応済み。ProjectSettingsFields に failed ref を持ち、失敗後は追加ボタンが「パスを入力して追加」（空行 + text 入力）に切り替わる。共通/個別とも同じ部品で有効。併せて、行の PathField に渡す canPick も `dialog`（canPick && !failed）にした（渡さないと新しい空行が readonly のまま入力できなかった。e2e で発覚）。e2e 追加: 個別（失敗→空行→text 入力→保存）、共通（同）。
- [low・任意] 失敗フォールバック後に Enter で create が走る検証 → 対応済み（session-path.spec。keyup が閉じたダイアログの opener を再クリックするため keydown のみ送る）。
- [low] report 更新 → 本節。

## 再テスト結果（第2回対応後）
- e2e 123 passed / 0 failed（第1回後 121 + 追加 2）。Rust 無変更のため cargo test は省略。

## 再テスト結果（第1回対応後）
- e2e 121 passed / 0 failed（前回 119 + 追加 2）。Rust 無変更のため cargo test は省略。
