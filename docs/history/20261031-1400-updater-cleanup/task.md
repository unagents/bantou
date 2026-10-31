# 指示書: ヘッダー updater 化の後始末（README と使われなくなったコード）

- 日付: 2026-10-31 / 発行: Mac main cap
- 実行: 204 remote cap。worker は sonnet（Fable は使わない）。cargo は `CARGO_BUILD_JOBS=2`・`-j 2`、コマンドは逐次。
- 作業 dir: `/home/vagrant/work/bantou/develop`（branch develop）。前回: `docs/history/20261031-1300-header-updater/report.md`。

## ユーザー承認済みの内容

1. `desktop/README.md`（35〜36 行目付近）の古いトーストの説明を、ヘッダーの更新操作（cmux 方式）の説明に直す。
2. トースト廃止で使われなくなったものを削除する:
   - `useUpdater.dismiss()`（`useUpdater.ts`、古いコメント含む）
   - `openReleaseNotes`（`api/updater.ts`）
   - opener プラグイン: `@tauri-apps/plugin-opener`（package.json / bun.lock）、`tauri-plugin-opener`（Cargo.toml / Cargo.lock / lib.rs）、capabilities の `opener:default`
   - 削除前に、他に opener を使っている箇所が無いことを grep で確かめる。あれば削除せず report に。

## 確認

- `cargo test`（並列を絞る）、typecheck（環境で動かなければ report に）。e2e は mac200 で main cap が行う。

## 範囲外

- version bump、release、main への push。

## 報告

- 同 dir に `report.md`。後始末は自分で行い、残ったものを列挙。develop に commit・push（push まで必ず）。
