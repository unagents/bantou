# 報告: center 欄の整理（on/off 出し分け、bind と IP 選択の統合）

- 日付: 2026-10-28（204 remote cap の worker）。commit / push はしていない（cap が行う）。

## 変更ファイル

- `desktop/src/components/SettingsDialog.vue`
- `desktop/src/api/center.ts` / `desktop/src/api/index.ts` / `desktop/src/types/index.ts`
- `desktop/src-tauri/src/center_snippet.rs` / `center.rs` / `lib.rs`
- `desktop/e2e/mock/bantou.ts` / `desktop/e2e/settings.spec.ts`
- `desktop/README.md`

## 挙動の変化

- center OFF: トグルと「別ホストの center に接続（貼り付け）」だけ。ON: 同じ場所に port / bind / token / 接続設定 / projects / servers / claudePath だけ（貼り付け欄は出ない）。同時表示なし。保存値は切替で消えない。
- bind は自由入力を廃止し、この PC の IP 一覧（IPv4、127.0.0.1、IPv6）の select 1 つ（`data-testid="center-bind"`）。選んだ IP が `--bind` であり、接続設定 URL のホスト。「接続先 IP」欄（`center-connect-host`）は廃止。
- `0.0.0.0` / `::`（全 IP 待ち受け）は選べなくなった。待ち受けは選んだ 1 IP のみ。
- Rust: `center_connect_hosts` を `center_local_ips()` に置換、`center_connect_snippets(bind, port, token)`（host 引数なし、bind がホスト）。`host_choices` / `resolve_host` / `HostChoices` 削除。`pick_bind`（移行）と `snippet_host` を追加。`CenterSettings.connect_host` は読み込み専用（`skip_serializing`）の旧キー扱い。

## 移行の判断（`pick_bind`、`load_settings` で実行して保存し直す）

1. 保存済み bind がこの PC の IP 一覧にある: それ。
2. 無ければ旧 `connectHost` が一覧にある: それ（旧 `0.0.0.0` + 接続先 IP 指定の人は、ユーザーが選んでいた IP になる）。
3. どちらも無い: 一覧の先頭（LAN IPv4 優先）。一覧が空なら 127.0.0.1。
- 例外（判断）: `localhost` / `::1` / `[::1]` は 127.0.0.1 に寄せる。先頭へ落とすと loopback 限定の center が LAN に公開されるため。
- 注意: 規則 3 では、ホスト名 bind や一覧に無い IP の人は LAN IP に変わる（公開範囲が広がり得る）。指示（無ければ先頭）に従ったが、127.0.0.1 の方が安全という見方もある。cap 判断を仰ぎたい。
- 冪等（移行後の再実行で変化なし）。`connectHost` は以後書かない。UI 側は、保存 bind が一覧に無い場合も select に現在値を残す（隠さない）。

## テスト

- `cd desktop/src-tauri && CARGO_BUILD_JOBS=2 cargo test -j 2`: 205 passed / 0 failed / 5 ignored（既存 warning 4 件は今回の変更外）。`pick_bind` 系 4、`snippet_host`、`connect_host` 読み捨て（`center.rs`）の unit を追加・更新。
- 型チェック `npx nuxt typecheck`: 実行不可。`vue-router/volar/sfc-route-blocks` が解決できず vue-tsc が起動しない（環境の依存解決問題。今回の変更とは無関係に起きる）。
- e2e（Playwright, `e2e/settings.spec.ts`）: 未実行。このホストに system Chrome（`channel: "chrome"`）が無く、チャンネルを外して chromium で試したが、`nuxt dev` が起動時にフォント取得（fonts.google.com 等）を行いサンドボックスのネットワーク制限で ready にならず 180 秒でタイムアウトした。許可外ホストへの迂回はしていない。spec は追加・更新済み（下記）で、mac200 等での実行が必要。
  - 追加: 「1 つの IP 選択が bind と接続設定のホストを決める」（選択肢の並び、選択で URL が変わる、両タブ、IPv6 の `[]`、保存で bind が変わる）、「ON で token/接続設定、貼り付け欄は出ない・OFF で逆」。更新: 「center off で隠す」（bind は select 表示で確認、OFF で貼り付け表示 / ON で非表示）。
  - 旧 spec「IP を切り替える」は削除（統合により不要）。
- 起動したプロセスは無し（nuxt dev は起動に失敗/タイムアウトで終了、残存なし確認済み）。

## 残課題

- **後始末のお願い**: `desktop/playwright.local.config.ts`（chromium で試すため一時作成した未追跡ファイル）が残っている。削除がこの worker に許可されなかったため、cap が `rm` すること。commit しないこと。
- e2e と型チェックを実機（mac200 等）で実行して確認すること。
- 隣接する挙動（未変更・要判断）: `settings.remote` が保存されたまま center を ON にすると、貼り付け欄は隠れるが `select_target` は remote を優先するので、desktop は自分の sidecar ではなく remote に接続し続ける。ON にした時に remote を解除するか、cap の判断を仰ぎたい。
- 既存の stale な nuxt dev ロック（PID 44、存在しないプロセス）があり、起動には `NUXT_IGNORE_LOCK=1` が必要だった。

## 追記（2026-10-28 main cap 判断）

- 規則 3 を変更: 保存 bind も旧 `connectHost` も IP 一覧に無い時は、一覧の先頭ではなく `127.0.0.1`（公開範囲を勝手に広げない）。規則 1・2、loopback 別名の扱い、冪等性は不変。`center_snippet.rs` の `pick_bind`。
- center ON 時の接続先: 保存済み `settings.remote` を使わず自分の sidecar に接続。OFF に戻すと保存済み remote を使う。remote の保存値は消さない・書き換えない。`center_mcp.rs` の `select_target`（接続先は呼び出しごとに設定から決まるので、ON/OFF 切替の再接続経路は追加変更なし）。
- テスト: `CARGO_BUILD_JOBS=2 cargo test -j 2` で 205 passed / 0 failed / 5 ignored。規則 3 の期待値を 127.0.0.1 に更新、ON で remote 無視・OFF で remote 使用・remote 保存値が残ることの unit を更新。
- 上記「移行の判断」の規則 3 と「残課題」の隣接挙動は、この追記で解消。
