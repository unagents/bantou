# 指示書: 設定画面の保存で画面を閉じる・変更が無ければ保存を押せない

- 発行: Mac main cap（center 経由、2026-11-01）
- 対象: GitHub `https://github.com/unagents/bantou.git` の branch `develop`。
- worker は sonnet（Fable は使わない）。worker は自分の作業 dir の下で `git clone --branch develop https://github.com/unagents/bantou.git bantou` を実行し、その clone で作業する。

## ユーザー指示

設定画面（`desktop/src/components/SettingsDialog.vue`）で保存ボタンを押しても、画面がそのまま残る。保存したら設定画面を閉じる。変更が無い時は保存を押せないようにする。

## 変更内容

- 保存が成功したら dialog を閉じる（`open` を false）。失敗した時は閉じずにエラーを出す（今のまま）。
- 保存ボタンは、開いた時（`load` 後）の値から変更が無い時は disabled。今の `portError` / `tokenError` による disabled は残す。
- 変更に数えるもの: 編集項目の値の変更、IP 変化バナーで新しい IP を選んだ時、接続設定の貼り付け・解除（`remote` の変化）。
- token の再生成はその場で保存・適用されるので、変更に数えない（比較の基準値の token も更新する）。
- 保存成功時の toast「設定を保存した」は残す。
- e2e（`desktop/e2e` の `settings.spec.ts` ほか、保存後も dialog が開いている前提のもの）を新しい動きに合わせる。「変更なしで保存が押せない」「保存後に閉じる」のテストを足す。
- `settings.spec.ts` の既存の失敗（strict mode 違反、develop でも 4 件）は、今回の変更で触る箇所以外は直さず report に書く。

## 環境（204）

- 依存: repo root で `bun install`、`packages/protocol` で `npm run build`。
- 204 には Chrome が無い。e2e は ms-playwright の chromium を指定した一時 config で実行する。repo の `playwright.config.ts` は変えない。一時 config は commit しない。
- nuxt dev は port 1420 固定。開始前に `ss -ltn` で 1420 が空いていることを確かめる。埋まっていたら他の作業のものなので使わず、report に書いて止める。
- Rust は触らない想定。触った場合は cargo を `CARGO_BUILD_JOBS=2`・`-j 2` で逐次。

## git

- commit と push は `GIT_CONFIG_GLOBAL=/home/vagrant/.config/git/agent.gitconfig` を付けて行う。
- 新しい branch `feature/settings-save-close` を切り、それだけを origin に push する。develop と main には push しない。
- version bump はしない。

## 報告

- この指示書を `docs/history/20261101-1100-settings-save-close/task.md` に置く。同 dir に `report.md`（変更ファイル、テスト結果の件数、後始末の結果と残存物、要判断事項）を書き、同じ branch に commit・push する。
- 後始末: 起動した dev server・playwright・chromium を止める。一時ファイルは削除する。消せなかったものは report に列挙する。

完了したら report ツールで報告すること。
