# 報告: 追加指示 4（起動直後にセッション一覧が「つながらない」のまま残る）

- 日付: 2026-11-01 / 実行: 204 remote cap（worker は sonnet、w-hotfix）
- branch: `hotfix/startup-session-refresh`（main b5783eb から）。修正 commit は 10e3b1d、その上に本報告の commit。version bump はしていない。develop と main への merge はしていない。

## 変更（desktop のみ）

- `src/composables/useSessionRefresh.ts`、`src/api/sessions.ts`、`src/api/index.ts`、`src-tauri/src/center.rs`、`e2e/mock/bantou.ts`、`e2e/session-add.spec.ts`、`README.md`（取り直しの時機の記述に 1 文追記）。
- 起動時の取り直しが失敗した時（`reachable:false` か例外）は、2 秒ごとに取り直す。
  - 60 秒たったら打ち切り、その後は従来の時機（操作・スリープ復帰・ネットワーク変化・設定を閉じた時・5 分ごと）に任せる。
  - 最初に成功した時点で止める。取り直しは 1 つずつ行い、重ねない。unmount で timer を止める。
  - 間隔と上限は定数 `STARTUP_RETRY_MS`・`STARTUP_RETRY_CAP_MS`。
- sidecar の center を起動した時（`center.rs` の `start_locked` の spawn 直後）は、Rust が Tauri event `bantou://center-running` を出す。
  - desktop はこれを受けてすぐ取り直す。失敗が続けば、同じ 2 秒・60 秒の取り直しをもう一度始める。center を再起動した時にも効く。
  - spawn した時点では、center がまだ listen していないことがある。そのため event だけには頼らず、取り直しと組み合わせた。
  - アプリ起動時の spawn では、画面が listen を登録する前に event が出る。その場合は起動時の取り直しが拾う。
- 取り直しは既存の経路（`refreshNow` → `refresh_sessions`）を通す。`SessionCache`・`SessionList.rev`・`useBoard.setCenterList` は変えていない。

## テスト結果

| | 前 | 後 |
|---|---|---|
| desktop `cargo test` | 212 passed / 5 ignored | 213 passed / 5 ignored（event 名のテスト 1 件を追加。cap が再実行して確認） |
| e2e（静的ビルド） | 56 passed（新規 2 件は旧コードで failed） | 58 passed / 0 failed（2 回とも） |
| e2e（mock の invoke に 12ms 遅延） | - | 58 passed / 0 failed |

- 新しい e2e は 2 件。
  - 起動時は center が答えず、少し後に答える。操作しなくても一覧が出て「つながらない」が消え、答えた後は取り直しが止まる。
  - `bantou://center-running` を受けると、すぐ取り直す。
- e2e は 204 の sandbox で nuxt dev が動かないため、静的ビルドと headless shell で回した。mac200 の通常の `bun run e2e` では未確認。

## develop（3 列画面）との統合について

- develop（d9c2c35）とこの branch を merge すると、3 つの file が衝突する（`git merge-tree` で確認）。
  - `desktop/src/composables/useSessionRefresh.ts`
  - `desktop/e2e/mock/bantou.ts`
  - `desktop/e2e/session-add.spec.ts`
- 衝突するのは、develop 側にも次の変更があるため。
  - `useSessionRefresh.ts`: `center-sessions-changed` の listener
  - `mock/bantou.ts`: terminal 用の case
- 解き方は、両方の変更を足し合わせる。
  - `useSessionRefresh.ts` には、起動時の取り直し、`center-running` の listener、`center-sessions-changed` の listener の 3 つを並べる。どれも `refreshNow()` を呼ぶ。
  - mock と spec は、両方の case とテストを残す。
- この merge は 204 では行っていない（追加指示 4 で merge は Mac main cap が行うため）。204 で解消版を作る必要があれば指示がほしい。

## 要判断事項

1. 接続先が無い時（center が OFF で、貼った接続先も無い）も、起動直後の 60 秒は 2 秒ごとに取り直す。invoke が失敗するだけで害は無いので、場合を分けていない。
2. `README.md` への追記は、「取り直すきっかけ」の記述と合わせるため。不要なら外してよい。

## 後始末

- static server と browser は停止した。port 1470 が空いていることを確かめた。
- worktree の `desktop/pw.tmp.config.ts`（未追跡）は、`rm` が権限で拒否され、残っている。
