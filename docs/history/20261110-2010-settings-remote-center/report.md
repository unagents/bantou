# settings-remote-center

指摘: 「center向けの設定がcenterを起動してないdesktop側で見えてしまってるのは問題」。
branch: fix/settings-remote-center（基点 develop）。

## 設定画面の分類（SettingsDialog.vue / CenterDialog.vue / AppHeader.vue）

| 項目 | 呼ぶ API / コマンド | 分類 | 表示条件（変更後） |
|---|---|---|---|
| 見出し「この PC の center」+ 「center を起動する」スイッチ | `center_set_settings`（enabled） | sidecar 向け | remoteOnly 以外 |
| port / 接続設定の IP（bind）/ token（コピー・再生成）/ 接続設定 snippet / workspace / claudePath | `center_set_settings` `center_regenerate_token` `center_local_ips` `center_connect_snippets` | sidecar 向け | enabled（従来どおり。remoteOnly では enabled=false なので出ない） |
| IP の警告帯（保存 IP が無い / listen 失敗） | `center_ip_status` `center_status` | sidecar 向け | enabled（従来どおり） |
| 「状態」節（state バッジ・pid・自動再起動回数・最終終了理由・エラー・ログ・更新ボタン） | `center_status` | sidecar 向け | remoteOnly 以外（**今回の修正点**。従来は常に出ていた） |
| 「別ホストの center に接続」（貼り付け・parse・現在の接続先 URL / token・解除） | `center_parse_connect`、保存は `center_set_settings`（remote） | 接続状態 | OFF の時（従来どおり）。remoteOnly ではヒント文を足す |
| 全 session 共通の設定（instructions / addDirs / outputStyle / servers） | `center_settings_get` / `center_settings_update`（MCP） | 接続先 center | 常に（従来どおり）。フォルダ選択ダイアログは enabled の時だけ（従来どおり） |
| ダイアログの説明文 | - | - | remoteOnly は「接続先 center の設定」、他は従来の文 |
| CenterDialog 全体（接続状態 URL・remote/sidecar の別、rc_list、server 一覧・退役・版） | `center_connection` `rc_list` `server_list` `server_peers` `server_retire` | 接続先 center | 常に（変更なし） |
| AppHeader の更新ボタン（アップデートを確認 / インストール） | updater plugin | desktop アプリ自身（center ではない） | 常に（変更なし） |
| session 設定（ProjectSettingsDialog 等） | `session_settings_*` | 接続先 center | 常に（変更なし。触っていない） |

memory 節: この branch の基点には無い（別 task feat/external-memory-settings）。共通設定の節（`ProjectSettingsFields`）に入れば remoteOnly でも同じく出る（節を隠していないため）。

「自己更新」「再起動」: center sidecar 側に UI 上の自己更新・再起動操作は無い。ヘッダーの更新は desktop アプリ自身なので隠さない。再起動は center の自動再起動回数の表示（状態節）だけで、これは隠す。

## sidecar 判定の根拠

- 判定: `remoteOnly = !settings.enabled && !!settings.remote`（SettingsDialog の draft）。
- 根拠: 接続先を決めるのは `center_mcp.rs::select_target` で、enabled なら sidecar、そうでなければ remote。sidecar を起動する・止めるのも `center.rs::apply` が見る `enabled` だけ。同じ 1 つの値で「どちらに繋ぐか」と「sidecar を動かすか」が決まるので、これを根拠にした。`center_status`（runtime の state）は、保存で enabled=false にすると `apply` が即 stop するため enabled=false かつ running は過渡状態のみで、根拠にすると保存直後にちらつくので使わない。`center_connection` は非同期で取得中がある（`connection` が null の間は未確定）ので使わない。
- 境界:
  - enabled=false + remote あり: remoteOnly（隠す）。
  - enabled=true + remote あり（保存済み remote は使われない）: 従来どおり sidecar 向けを出す。
  - enabled=false + remote 無し（未接続）: remoteOnly ではない。スイッチが sidecar を起動する唯一の入口のため、スイッチと「状態」を出す（既存 e2e もこの構成を前提にしている）。
  - 未取得: `settings` が null の間はダイアログ本体を描画しない（既存）。settings が載った時点で判定が確定し、`status` の取得を待たないので、ちらつかない。
  - remoteOnly で「解除」すると draft の remote が外れてスイッチが戻る（sidecar に戻る入口）。貼り付け中に remote が入ると、その時点でスイッチは消える（draft 基準）。
- 副作用の無い取りこぼし: remoteOnly でも load() は `center_status` / `center_local_ips` / `center_ip_status` を呼ぶ（値は使わない。変更を最小にするため触っていない）。

## 変更

- `src/components/SettingsDialog.vue`: `remoteOnly` を追加。スイッチ（と見出し）・「状態」節を `v-if="!remoteOnly"`、説明文を切り替え、remote 節にヒントを追加。
- `e2e/settings-remote-center.spec.ts`（新規。mock は変更なし。既存の `center.enabled` / `center.remote` を使う）。
- `README.md`: 設定画面の説明。
- 既存 e2e は変更なし（期待値を緩めていない。既存は enabled=true、または remote 無しの OFF で、remoteOnly に当たらない）。

## テスト

- `npx nuxt typecheck`（bun 無し host。vue-tsc を nuxt typecheck が呼ぶ）: exit 0。
- `nuxt generate` の静的ビルドを node の簡易サーバー（port 14200）で配信し、ms-playwright の chromium-1243 を自己完結の一時 config で指定、mock bundle は bun build の代わりに esbuild で作成: 全 203 件 pass（retries 0）。新規 6 件を含む。
- 新規 e2e:
  - sidecar OFF + remote: スイッチ・own section・port/bind/token/snippet/claudePath/workspace・状態・ログ・IP 警告帯が出ない。共通設定の instructions / addDirs / outputStyle / servers 節と接続先（URL）が出る。共通設定の保存が従来どおり通る。解除でスイッチが戻る。CenterDialog が remote の URL と server 一覧を出す。
  - sidecar ON（remote 保存済みでも）: 従来どおり全部出て remote 節は出ない。
  - OFF + remote 無し: スイッチ・状態・貼り付け欄が出る。
- 簡易サーバーは停止し port 14200 の解放を確認。
