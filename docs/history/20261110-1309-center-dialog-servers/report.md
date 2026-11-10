# center 設定画面の整理（remote session と server 一覧のみ）

branch: fix/center-dialog-servers

## 変更点

- `CenterDialog.vue`: `<RemoteActivity />` を外した（component は session 画面で使うため残す）。
- 「server の版」(`server_peers`) と「servers」(`server_list` + `server_status`) を 1 つの「server」一覧に統合。
- `server_status` は呼ばない（cap / worker の行が無くなったため）。
- 「remote-control」見出しを「remote session」に変更。中身は従来通り。
- e2e / mock を合わせた。remotes 詳細のテストは dialog から session 画面（`session-` 接頭辞）へ移した。

## 型とフィールドの意味（読んで確認した事実）

- `server_peers[]`（center `Follow`）: broker で発見した server。`id` = その server の現在の peer id、`host` / `server_id` / `user` / `workspace` / `server_version` / `state` / `detail`。
- `server_list[]`（center `ServerInfo`）: 設定済みの接続。`name` = 設定名、`connected` / `reachable` = center と server の接続状態、`peerId` = **center 自身**の peer id（server のものではない）、`serverPeer` = center が最後に送った先（peer id、無ければ名前 "bantou-server"）。

## 設計判断

- join: `server_list.serverPeer` = `server_peers.id` で一致 → 無ければ `serverPeer` = `server_peers.name` が一意に 1 件の時のみ一致。理由: `peerId` は center 自身の id で join に使えない。名前が複数 peer に当たる時は誤結合を避け結合しない。
- 行の基準は `server_peers`（host / 版を持つ）。join できなかった `server_list` は別行（host 欄に設定名、版 badge なし）。join できなかった peer は接続「不明」。
- 接続状態は 1 badge: `!reachable` → 到達不可 / `connected` → 到達可 / それ以外 → 未接続 / 接続情報なし → 不明。
- detail は `state !== ok` の時だけ 1 行。
- 空表示: 統合で「server なし」(`center-versions-none`) と「server 未登録」が重なるため「server なし」1 つにした。「project 未登録」は残した。
- `server_peers` が失敗しても `server_list` の行は出し、エラー文を残す。

## 画面（connected 時、上から）

1. 接続 badge / URL / 更新
2. remote session: project ごとに state / pid / 再起動 / lastError / sessionUrl（`project 未登録` の空表示）
3. server: 組の版（小さく 1 行）→ 行ごとに
   `host（太字・先頭）| server_id（無ければ peer id）| user workspace（同 host 複数時のみ）| 版 badge | server 版 | 接続 badge | 待機 cap/worker（更新中のみ）`
   問題時のみ detail 1 行。

## testid

- 廃止: `center-versions`, `center-version-row`, `center-version-server-id`, `center-version-who`, `center-version-badge`, `center-version-running`, `center-version-detail`, `center-agent`, dialog 内の `center-remote*` / `center-task-*` / `center-worker-*`（RemoteActivity の center 接頭辞）。
- 変更: `center-server-row`（意味が変わった。`data-host` / `data-server-id` / `data-state` / `data-link`）。
- 新規: `center-servers`, `center-server-host`, `center-server-id`, `center-server-who`, `center-server-version-badge`, `center-server-version`, `center-server-link-badge`, `center-server-running`, `center-server-detail`。
- 維持: `center-dialog`, `center-conn-state`, `center-conn-url`, `center-conn-error`, `center-error`, `center-refresh`, `center-rc`, `center-pair`, `center-versions-error`, `center-versions-none`。

## テスト（この host: Linux）

- `nuxt typecheck`: exit 0。
- `nuxt generate` の静的ビルドを簡易 node サーバーで配信し、ms-playwright の chromium（self-contained config）で全件: **146 passed**（center.spec は 20 件）。
- bun は host に無く、`bun build` の代わりに esbuild で mock を bundle した。
- 簡易サーバーは停止、ポート 1420 解放を確認。

## 残課題

- `RemoteActivity.vue` の `owner` 未指定（`center-` 接頭辞・全 session 一覧・「共有（旧）」）経路は、dialog から外したため未使用。触らずに残した。
- `types/index.ts` の `CenterServerStatus` / `CenterAgentState` は未使用になった。触らずに残した。
- 作業中に誤って空の `/tmp/x` を作った（`cat > /tmp/x`）。rm が拒否されたため残っている。
