# 使う server（settings.servers）を session の個別設定だけにする

branch: `fix/servers-session-only`
基点: `origin/develop`（d20aac2323c39a6bb2ca15ed2e07fcc8bfe5e1ff）。`packages/center/src/project-settings.ts` に settings.servers（session の servers と共通の servers）が入っていることを確認したので develop から切った（merge/retire-server からではない）。

## 変更点
### center
- `center_settings_update` / `center_settings_get` から `servers` を外した（`centerSettingsPatchSchema` = session 用 schema から `servers` を除いたもの）。
- `composeServers(own)` は session の値だけを見る（共通を見ない）。session の未設定=全部、`[]`=使わない、`null`=削除は従来どおり。
- 保存済みの `center-settings.json` に `servers` が残っていても、読み込み時（`readCenterSettings`）に捨てる。次の保存で消える。
- tool の説明を更新: `center_settings_get` / `center_settings_update` に「servers は共通の設定には無い。session の設定で指定する」、`session_settings_get` / `session_settings_update` の servers は「session ごとの設定だけ。null で削除＝全部に戻る」。
- docs: `docs/design/project-settings.md`（servers 行）、`packages/center/README.md`（tool 表、共通設定の節、servers の節の「合成」）。

### desktop
- 共通設定ダイアログ（SettingsDialog の共通節）から「使う server」欄を外した（`ProjectSettingsFields.vue` に `no-servers` prop を 1 つ追加。共通ではこの欄を出さず、`server_peers` も引かない）。
- 共通の更新は `toCenterUpdate`（`toUpdate` から servers を除く）。型 `CenterCommonSettings`（`ProjectSettings` から servers を除く）。
- session の設定ダイアログ（歯車）と追加ダイアログは既存のまま: 発見済み server のチェック形式が主、手入力が補助。欄の説明文から「共通に従う」を外した。
- `packages/desktop/README.md` を更新。

## 判断
- 共通設定に `servers` を渡した場合: `null` 以外は**明示エラー**（「servers は center 共通の設定では持てない。session の設定（…）で指定する」。他の項目も保存しない）。
  - 理由: 黙って無視すると「設定したのに効かない」が利用者に分からない。tool の説明にも書くが、LLM が読み落とすことがあるのでエラーで知らせる。
  - `servers: null` は無害（削除＝元々無い）なので通す。古い desktop が毎回 `servers: null` を送るため、これを拒否すると古い desktop の共通設定保存が全部失敗するのを避ける。
  - schema 側で `.passthrough()` を残したので、unknown key の扱いは session 側と同じ（素通し）。`servers` だけ `updateCenterSettings` で拒否する。
- 共通設定ダイアログの draft 形（`SettingsDraft.servers`）は session と共用のまま残した（共通では常に null）。衝突回避のため既存行は動かしていない。

## テスト結果
- center: `npm run typecheck` OK、`npm test`（node --import tsx --test）547 pass / 0 fail。
  - 追加: 共通への servers はエラーで保存されない（他の項目も）、null は無害、既存の共通設定ファイルの servers は読み捨てられ session の動作（serversOf）に影響しない、保存し直すと消える、session の servers は効く（serversOf、remotes の範囲制限は既存の session-servers / remotes テストが通る）。
- desktop: `nuxt typecheck` OK。e2e（nuxt generate の静的ビルド + 簡易サーバー + ms-playwright chromium-1243、一時 config）198 passed / 0 failed（retries 0）。
  - 追加・変更: 共通設定に servers 欄が無い・`server_peers` を引かない・古い center の残り servers は表示も送信もされない、追加ダイアログにチェック形式があり session_create に入る。既存の session-servers の共通の servers テストを置き換えた（期待値は緩めていない）。`session-instructions.spec.ts` の送信値から `servers: null` を除いた。

## 残課題
- 実 center の tool 層（MCP 経由）で servers を渡した時のエラー表示は、manager 層のテストのみ（tool 経路の結合テストは無し）。
- 古い desktop（servers 欄あり）で新しい center につなぐと、共通に servers を保存しようとしてエラーになる。desktop と center は同時更新の前提。
