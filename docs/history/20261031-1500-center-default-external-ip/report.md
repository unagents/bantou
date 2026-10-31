# Report: center の接続先 IP を外側 IP 既定に / 待ち受け 0.0.0.0 / IP 変化の検知

実装: 204 sonnet worker。整理・commit・push: 204 remote cap。

## 変更ファイル
- `desktop/src-tauri/src/center_snippet.rs`: `pick_bind`（127.0.0.1 フォールバック）を撤回。`default_ip` / `ip_status` / `resolve_bind` / `IpStatus` を追加。`snippet_host` は空・wildcard を既定 IP にする。単体テストを差し替え。
- `desktop/src-tauri/src/center.rs`: sidecar の `--bind` を常に `0.0.0.0`（`LISTEN_BIND`）。`bind` 既定を空（保存値なし）にし空を許可。`connect_host` と読み込み時の移行処理を削除。`needs_restart` から bind を除外。`center_get_settings` は保存値なしなら既定 IP を返す。`center_ip_status` コマンドと `CenterStatus.bind_failed` を追加。
- `desktop/src-tauri/src/center_mcp.rs`: 自 sidecar への接続は常に `127.0.0.1`（選択 IP に依存しない）。
- `desktop/src-tauri/src/lib.rs`: `center_ip_status` を登録。
- `desktop/src/types/index.ts` / `desktop/src/api/center.ts` / `desktop/src/api/index.ts`: `CenterIpStatus`、`bindFailed`、`centerIpStatus` を追加。
- `desktop/src/components/SettingsDialog.vue`: 上部に IP 状態バナー（前と同じ / 新しい IP）。bind 項目の表示・説明を「接続設定の IP」に変更。loopback 警告を「全アドレスで待ち受ける」常時注記に変更。
- `desktop/e2e/mock/bantou.ts`: bind 既定を空に。`localIps`、`centerBindFailed`、`center_ip_status` を追加。get_settings で既定 IP を解決。
- `desktop/e2e/settings.spec.ts`: 既定が外側 IP になった分の期待値更新と spec 追加。
- `desktop/README.md`、`docs/architecture.md`: 新仕様に合わせて更新。

## 挙動
### A. 待ち受けと IP 選択の意味
- center は常に `0.0.0.0` で待ち受ける。
- IP 選択は接続設定（mcp.json / `claude mcp add`）の URL ホストだけを決める。UI の select は 1 つのまま。
- IP を変えただけでは center を再起動しない。

### B. 既定値
- 保存値なし: loopback 以外の IPv4 の先頭。private（10 / 172.16-31 / 192.168）を優先。
- 外側 IP が無い時だけ `127.0.0.1`。`127.0.0.1` は一覧に残り選べる。
- 保存値が一覧に無くても自動では切り替えない。移行処理は入れていない。

### C. IP 変化の検知
- 設定を開くと `center_ip_status` で保存 IP を今の一覧と照合。一覧にあれば何も出さない。
- 無ければ上部に「保存の IP X は今このマシンに無い。今の候補: …」と 2 択（前と同じ IP のまま / 新しい IP にする。候補の既定は外側 IP の先頭）。
- 選ぶまで変えない。新 IP は保存で接続設定に反映（center 再起動は不要）。
- バナーは center ON（ドラフト）の時だけ出す。

### 起動時 bind 失敗との接続
- `Center::status()` は state が restarting / error で、sidecar ログ直近 20 行に `EADDRINUSE` / `EADDRNOTAVAIL` / `EACCES` があれば `bindFailed: true`。
- UI は `bindFailed` でも同じバナーを出す（文言「待ち受けに失敗した（port の競合など。ログを参照）。今の候補: …」、同じ 2 択）。

## 確認
- cargo test（`CARGO_BUILD_JOBS=2 cargo test -j 2 --offline`）: `test result: ok. 209 passed; 0 failed; 5 ignored`。
- typecheck: 既知の環境エラー（vue-tsc 起動時 `MODULE_NOT_FOUND`、`vue-router/volar/sfc-route-blocks`）で実行不可。型は未検証。
- e2e: 未実行（mac200 で main cap）。

### Rust 追加テスト
- `default_ip_*`（LAN 優先、外側なしなら 127.0.0.1）、`ip_status_*`（保存なしは既定、保存ありは維持、一覧に無ければ missing かつ保持）、`bind_failure_is_read_from_the_log`、`sidecar_is_dialed_on_loopback_whatever_ip_is_picked`。`needs_restart` / `sidecar_args` のテストを更新。

### e2e spec（`desktop/e2e/settings.spec.ts`）
- 追加: "nothing saved and no external IP: the default is 127.0.0.1, which stays selectable"
- 追加: "a saved IP that is still on this machine shows no banner"
- 追加: "a vanished saved IP is reported with the current candidates, and nothing changes until chosen"
- 追加: "choosing 'keep the same IP' keeps the saved IP"
- 追加: "choosing 'a new IP' switches to the first external IP, saves it and updates the connection settings"
- 追加: "a center that could not listen shows the same IP banner"
- 更新: "one IP choice is the host of the connection snippets (the center listens on all addresses)"（保存なしで 192.168.1.204 が既定、127.0.0.1 も選べる）
- 更新: token 再生成 spec の URL 期待値を 192.168.1.204 に。

## 解釈・判断
- 「LAN を優先」= private アドレスを先に、無ければ外側 IPv4 の先頭。
- 保存キー名 `bind` は据え置き（移行回避、testid も維持）。旧 `connectHost` の読み取り・移行は削除（「移行処理は入れない」に従う）。
- 旧版で保存された `bind` が `0.0.0.0` / `127.0.0.1` の場合はそのまま保持される。`0.0.0.0` は一覧に無いので設定を開くとバナーが出る。`127.0.0.1` は一覧にあるのでバナーは出ず、ユーザーが選び直すまで接続設定は 127.0.0.1 のまま（移行なしの帰結）。
- 起動時 bind 失敗は `0.0.0.0` 固定では主に port 競合。検知はログ文字列ベースで、center（packages/center）側は未変更。
- desktop から自 sidecar への接続は常に 127.0.0.1（選択 IP が古いと自分に繋がらなくなるため）。

## 後始末・残り
- 起動プロセスなし。worker が `$TMPDIR` に残した編集用一時スクリプト `ed.mjs`〜`ed7.mjs`（7 本）は未削除。worker・remote cap とも `rm` が実行許可で拒否された（単独コマンドでも拒否）。
- bun.lock（opener 残り）、version、main は未変更。
