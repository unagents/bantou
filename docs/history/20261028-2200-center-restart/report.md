# 報告書: desktop が center の異常終了を検知して自動再起動する（204）

- 日付: 2026-10-28 / 作成: 204 remote cap `wcap-bantou`
- 指示書: 同 dir の `task.md`
- worker: sonnet（実装）。変更範囲が desktop の center.rs と設定画面に限られるため、opus の調査は省いた。

## commit（develop、6aba390..79c9e37 を push 済み）

| commit | 内容 |
|---|---|
| `a825b0f` | center sidecar の異常終了を検知して自動再起動 |
| `79c9e37` | bantou 0.1.11（desktop/package.json、src-tauri/Cargo.toml、Cargo.lock、bun.lock） |
| 本報告書 | 別 commit（task.md 含む） |

- main・release には触れていない。server/・plugin/・packages/center も変更していない。
- 変更したファイル:
  - `desktop/src-tauri/src/center.rs`
  - `desktop/src/types/index.ts`
  - `desktop/src/components/SettingsDialog.vue`
  - `desktop/e2e/mock/bantou.ts`（型を通すため `restartCount: 0` を追加）

## 設計

### 再起動の判断（純関数。時刻は引数で受けるので、テストで sleep しない）
- 待ち時間 `backoff_delay(n)` は 2 秒 × 2^n で、60 秒が上限。
- `Supervisor` が持つもの:
  - 失敗時刻の履歴
  - 起動時刻
  - 再起動回数
- 異常終了ごとの判断（`on_abnormal_exit(now)`）:
  1. 起動から 5 分以上動いていれば、失敗の履歴を消す。
  2. 10 分より古い失敗を捨てる。
  3. 今回の失敗を履歴に足す。
  4. 失敗が 5 件を超えたら停止（`GiveUp`）。超えなければ、待ってから再起動（`Retry`）。
- 待ち時間は 2・4・8・16・32 秒と伸び、6 回目の異常終了で止まる。

### 状態遷移（`on_terminated`）

| 結果 | 条件 | 動作 |
|---|---|---|
| `Ignored` | 終了したのが古い世代のプロセス | 何もしない |
| `Stopped` | desktop が意図して止めた（`stopping` フラグあり） | 失敗に数えない |
| `Retry` | 上記以外 | state を `restarting` にし、待ってから再起動 |
| `GaveUp` | 失敗の上限を超えた | state を `error` にし、理由と直近ログ 5 行を `error` に入れる |

### 意図した停止との区別
- 世代カウンタ `generation` は、spawn のたびに増える。
- `stopping` フラグは、`stop_locked` が kill の前に立てる。
- 設定 off、設定変更による再起動、アプリ終了（`RunEvent::Exit` → `stop()`）は、どれも `stop_locked` を通る。
- `stopping` が立っていれば、exit code や signal に関係なく失敗に数えない。

### 再起動予約の取り消し
- `epoch` は `stop_locked` の冒頭で必ず増える（再起動待ちで子が居ない時も）。
- 再起動の予約は、待った後でロックを取り直し、epoch が予約時と同じで、state が `restarting` の時だけ起動する。
- アプリ終了は、ロックを握ったまま epoch を増やす。その後に予約が動いても何もしない。
- 再起動待ちの間に止められたら、state を `stopped` に戻す。

### status と画面
- status に次の項目を追加した。
  - `restartCount`（再起動回数）
  - `lastExit`（最後の異常終了の理由。exit code / signal）
  - state `restarting`
- serde を camelCase にしたが、既存の項目（state / pid / error / logs）は 1 語なので名前は変わらない。
- 設定画面:
  - バッジは `restarting` を warning 色にした。
  - 自動再起動の回数と、最後の終了理由を表示する。
  - error は複数行で出す。
  - 直近ログは既存の欄に出る。
- 停止した後にユーザーが設定を保存すると、失敗履歴と再起動回数を 0 に戻して起動し直す。

## テスト結果

| 対象 | 結果 |
|---|---|
| `cargo check` | OK（既存の warning 4 件） |
| `cargo test --lib center` | 25 pass / 0 fail（新規 11 件） |
| `cargo test --lib`（全体） | 163 pass / 0 fail / 4 ignored |
| `bun run typecheck` | exit 0（cap が再実行して確認） |

- 新規 test の内容:
  - バックオフの値の列と上限。
  - 5 回までは再起動し、6 回目で停止する。
  - 10 分より古い失敗は数えない。
  - 5 分動けば失敗履歴を消す（299 秒では消さない）。
  - exit / signal の文字列化。
  - 古い世代の終了は無視する。
  - 意図した停止は失敗に数えない。
  - 異常終了で epoch 付きの再起動予約になる。
  - 停止指示なしの exit 0 も異常終了として扱う。
  - 停止時の error に理由と直近ログが入る。
  - stop で epoch が進む。
- `bun run typecheck` について:
  - worker は vue-tsc の `Cannot find module 'vue-router/volar/sfc-route-blocks'` を失敗と判断していた。
  - cap が再実行すると exit 0 で、出ていたのはこの警告だけ（TS エラーなし）だった。この警告は変更前から出ている。
- 実プロセスで center を kill して再起動を確かめる動作確認は、204 ではしていない。

## 判断した点

- 停止の指示なしに center が exit 0 で終わった場合も、異常終了として再起動する。center は自分から終了しない前提のため。
- 再起動待ちを表す state `restarting` を追加し、`error` と区別した。
- 再起動回数は、再起動を実際に実行した時に数える。取り消された予約は数えない。ユーザーが設定を保存すると 0 に戻る。
- 自動再起動の spawn そのものが失敗した時は、それ以上リトライせず、すぐに `error` にする。
- 「10 分以内に 5 回」は、5 回を超えたら停止する（6 回目で停止）と解釈した。
- 設定画面の自動更新は、保存後の数秒間だけ（既存の挙動のまま）。再起動待ちの表示は更新ボタンで反映する。常時ポーリングの追加はしていない。
- `start_locked` は await を持たないので、同期関数に変えた。再起動の予約から呼ぶ形が非同期の再帰になり、spawn の型推論が通らなかったため。

## 未解決

- 実機での再起動の動作確認（下記の mac200 確認項目）。
- 設定画面は、再起動待ちの状態が自動では更新されない（更新ボタンが必要）。
- 一時物の残り: `rm` が permission で拒否され、`/tmp/claude-1002/` 直下に次が残っている。前回までの分も残っている。
  - `p2.mjs`〜`p6.mjs`
  - `tc-cap.log`

## mac200 で確認すべき項目

1. center を有効にして起動し、sidecar を `kill -9` する。
   - 約 2 秒後に新しい pid で起動し直し、remote-control も起動し直すこと。
   - 設定画面に「自動再起動 1 回」と、最後の終了理由（signal 9）が出ること。
2. 続けて `kill -9` を繰り返す。
   - 待ち時間が 2・4・8・16・32 秒と伸びること。
   - 10 分以内の 6 回目の異常終了で停止し、state が error になること。
   - 設定画面に理由と直近ログ 5 行が出ること。
3. error で止まった後に設定を保存すると、再起動回数が 0 に戻って起動し直すこと。
4. 意図した停止では再起動しないこと。
   - 設定で center を off にした時。
   - ポートなどを変えて保存した時（起動し直すが、失敗には数えない）。
   - アプリを終了した時（center も remote-control も残らず、再起動もされない）。
5. 再起動を待っている間（restarting）に設定 off・変更・アプリ終了をしても、予約した再起動が走らないこと。
6. 5 分以上正常に動いた後に `kill -9` すると、失敗回数が戻り、待ち時間が 2 秒から始まること。
7. SIGTERM で止めている最中（最大 15 秒）に、再起動が誤って走らないこと。
8. 再起動した center が、起動時に前回の remote-control の孤児を回収すること（0.1.10 の挙動が保たれていること）。
