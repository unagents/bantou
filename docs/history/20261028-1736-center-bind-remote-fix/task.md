# 指示書: center 欄の残課題 2 点を直す

- 起点: `docs/history/20261029-0300-center-section-tidy/report.md` の「移行の判断」注意と「残課題」の隣接挙動。
- 作業ディレクトリ: `/home/vagrant/work/bantou/develop`（branch `develop`）。

## やること（main cap 判断で確定済み）

1. 移行規則 3 の変更（`desktop/src-tauri/src/center_snippet.rs` の `pick_bind`）
   - 保存 bind も旧 `connectHost` も IP 一覧に無い時は、一覧の先頭ではなく `127.0.0.1` にする。
   - 理由: 公開範囲を勝手に広げない。
   - 規則 1・2 と `localhost` / `::1` / `[::1]` の扱い、冪等性は変えない。
2. center ON 時の接続先（`select_target` 周辺）
   - center を ON にした時は、保存済み `settings.remote` を接続先に使わず、自分の sidecar に接続する。
   - `settings.remote` の保存値は消さない・書き換えない。
   - center を OFF に戻すと、保存済み remote を接続先に使う（従来通り）。
   - ON/OFF 切替時に接続先が切り替わる経路（再接続の呼び出し箇所）も合わせる。

## テスト

- 上記 2 点の unit test を追加・更新する（規則 3 の 127.0.0.1、ON で remote 無視、OFF で remote 使用、remote 保存値が残る）。
- 既存テストで規則 3 の旧期待値（一覧先頭）を持つものは新仕様に合わせる。
- e2e spec（`desktop/e2e/`）に関係箇所があれば合わせる（実行はこのホストで不可なので記述のみ）。
- 実行: `cd desktop/src-tauri && CARGO_BUILD_JOBS=2 cargo test -j 2`。並列は 2 を超えない。

## 完了条件

- cargo test が全 pass（件数を記録）。
- `docs/history/20261029-0300-center-section-tidy/report.md` の末尾に「追記（2026-10-28 main cap 判断）」節を足し、2 点の判断・変更内容・テスト結果を短く書く。
- `desktop/README.md` に該当記述（移行規則・接続先）があれば合わせる。
- commit・push は worker はしない（cap が行う）。

## 禁止事項

- 上記以外の挙動変更・リファクタ・整形をしない。
- `settings.remote` の保存値を削除・変更するコードを入れない。
- `git commit` / `git push` をしない。
- 許可外ネットワークへの迂回をしない。
- 質問するな。止まらず最後まで進め。判断に迷ったら安全側（公開しない・保存値を消さない）で進め、報告に書け。

## 報告

- 報告先: `docs/history/20261028-1736-center-bind-remote-fix/report.md`
- 必須: 変更ファイル一覧、挙動の変化、cargo test の結果（pass/fail/ignored 件数）、未実施事項と理由。
- 起動したプロセスがあれば停止し、残存なしを確認して書く。一時ファイルは削除する。
