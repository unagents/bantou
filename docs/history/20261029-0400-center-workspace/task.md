# 指示書: center の projects を workspace 1 つにする

- ユーザー指示: 「projects は workspace を 1 つ設定できるだけにする。既定は ~/.bantou」。
- 作業ディレクトリ: `/home/vagrant/work/bantou/develop`（branch `develop`、起点 commit `afd9044`）。

## やること

1. 設定画面（`desktop/src/components/SettingsDialog.vue` ほか）
   - projects 一覧（追加・削除・各項目）を廃止する。
   - workspace のパス 1 つの入力欄にする。既定は `~/.bantou`。
   - project の他の項目（autostart・spawn・permissionMode）は UI から外し、既定値で固定する。
2. 保存と center への受け渡し（`desktop/src-tauri/` 側）
   - 設定に workspace パス 1 つを持つ。既定 `~/.bantou`。
   - workspace のディレクトリが無ければ作る。
   - center には workspace 1 つを project として渡す。`center.json` の `projects` を 1 件で書き出す形でよい。
   - `packages/center` は変えずに済むならそれを優先する。変える場合は report に理由を書く。
3. 旧 `projects` 保存値からの移行
   - 移行規則は worker が判断して決め、report に規則と理由を書く。
   - 判断の軸: ユーザーの既存設定を黙って失わない、冪等（再実行で変化なし）。
4. 合わせる箇所
   - `desktop/e2e/mock/` と関連 spec（`desktop/e2e/*.spec.ts`）。
   - `desktop/README.md` の該当記述。
   - 消した型・API・Rust 関数の参照切れを残さない。

## テスト

- 変更箇所の unit test を追加・更新する（既定値、ディレクトリ作成、center.json の projects が 1 件、移行、冪等）。
- 実行: `cd desktop/src-tauri && CARGO_BUILD_JOBS=2 cargo test -j 2`。並列は 2 を超えない。
- `packages/center` を変えた場合はそのテストも実行する。
- e2e と型チェックはこのホストで実行不可（前回 report 参照）。記述の更新のみでよい。試す場合も許可外ネットワークへ迂回しない。

## 完了条件

- cargo test が全 pass（件数を記録）。
- 報告を書き終えている。
- commit・push は worker はしない（cap が行う）。

## 禁止事項

- 上記以外の挙動変更・リファクタ・整形をしない。
- `git commit` / `git push` をしない。
- 許可外ネットワークへの迂回をしない。
- 質問するな。止まらず最後まで進め。判断に迷ったら安全側（既存設定を失わない）で進め、報告に書け。

## 報告

- 報告先: `docs/history/20261029-0400-center-workspace/report.md`
- 必須: 変更ファイル一覧、挙動の変化、移行規則と理由、`packages/center` を変えたか否か（変えたなら理由）、cargo test の結果（pass/fail/ignored 件数）、未実施事項と理由。
- 起動したプロセスがあれば停止し、残存なしを確認して書く。一時ファイルは削除する。

## 追加指示（同じ task に含める）

- ユーザー指示: 「servers も要らない」。
- 設定画面の servers 欄を廃止する。`center.json` にも `servers` を書かない。
- 旧 `servers` 保存値は読み捨てる（desktop 側・center 側とも）。
- テスト・README（`desktop/README.md`、`packages/center` に README があればそれも）を合わせる。

### 訂正（後から受けたユーザー指示。上の追加指示より優先）

- `cap_kick` 等の tool の仕様（引数・指定方法）は仕様未確定なので変えない。
- `packages/center` の変更は、servers 設定が無くても既存 tool が動く最小限に留める。
- tool の入出力の形（`server_list` の返り値、各 tool の引数）は変えない。
- 当初の「protocol `bantou` で発見した server を自動で一覧・利用」「server 引数を発見した名前 / peer で指定」は、tool の形を変えずに済む範囲でのみ行う。形を変えないと実現できない部分は実装しない。
- 影響が出る箇所（servers 前提で、変えずに残した tool・コード・テスト）は変更せず、report に列挙する。
- `packages/center` を変えたらそのテストも実行する。
- report に、この追加分の変更・最小限に留めた範囲・影響箇所の列挙・テスト結果を書く。

### 訂正 2（後から受けたユーザー指示。上の「3. 旧 projects 保存値からの移行」と「旧 servers 保存値は読み捨てる」より優先）

- 旧 `servers`・旧 `projects` の保存値に対する移行・削除などの処理は入れない。
- `settings.json` の既存値に手を加える専用コードは書かない。
- 項目を型から外すだけにする。
- 未知の項目（旧 `servers` / `projects` が残った settings.json）を読んでもエラーにならないことだけ確認する（unit test で示す）。
- 既に移行・削除コードを書いていたら外す。
- report の「移行規則と理由」は「移行処理なし（訂正 2）」と、未知項目でエラーにならない確認結果に置き換える。
