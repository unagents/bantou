# session 作成ダイアログの「既に使われている名前」エラー

## 症状
desktop の session 作成ダイアログで名前を入れて作成すると「既に使われている名前」系のエラーが出る。session 自体は作成され一覧に出る。app 0.1.39 で再現。

## 原因（AddSessionDialog.vue）
- center は `session_create` の中で session を一覧へ載せてから（`created` event）起動・settle する。desktop は event で一覧を読み直すので、作成中に `existing` へ自分の名前が入る。
- `nameError` が `existing.includes(name)` だけで判定していたため、自分の作成中に「既に使われている名前」を表示していた（作成は成功し続ける）。
- `create()` に送信中ガードが無く、`nameError` が出る前（event 到着前）の Enter 連打 / 再押下で `session_create` が 2 回送られ、2 回目が center の `name が既に使われている` で落ちる余地があった。
- 観点別の結果:
  1. 二重送信: 該当（上記。ガード無し）。
  2. タイムアウト再送: 非該当。Rust は 404 SessionGone のみ 1 回再送、timeout（600s）では再送しない。
  3. center の判定: 非該当。`conflictsWith` は自分自身を衝突扱いしない。重複は同名の並行 create のみ拒否（unit で確認）。
  4. 成功後の再検証: 非該当（`nameError` の表示のみが原因）。
- 0.1.39 と develop(8265347): AddSessionDialog.vue は差分なし。同じ挙動。

## 修正
`packages/desktop/src/components/AddSessionDialog.vue`（パス欄には触れない、2 行）
- `create()` に `busy` ガードを追加。
- 作成中（`busy`）は `existing` による重複判定を行わない。

## テスト
- e2e `session-add.spec.ts` に 2 件追加。mock に `centerSessionCreateDelayMs`（center が一覧へ載せてから遅れて応答）を追加。
  - 「slow create is sent once」: 同期 Enter 2 回 + Enter + click で `create_session` が 1 回。エラー表示なし。
  - 「name does not turn into 'already used' while its own create runs」。
- 修正前: 2 件とも fail（create_session 呼び出し Received 2 / Expected 1、エラー文言表示）。
- 修正後: 2 件 pass。desktop e2e 全 120 件 pass。
- center unit `sessions.test.ts`: 1 回の create で add / start が 1 回、`created` event 時点で一覧に載る、並行の同名 create は重複で拒否される。center 全 432 件 pass、typecheck OK。
- cargo test: Rust 未変更のため未実施。

## 再現手順
遅い center（起動に数秒）で名前を入れて作成 → 作成中に名前欄が「既に使われている名前」になる。ダイアログの Enter 連打で `session_create` が 2 回飛ぶ。

## review 指摘と対応
（後で追記）
