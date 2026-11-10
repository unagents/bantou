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

- 判定: `remoteOnly = isRemoteOnly(開いた時に読んだ保存済みの settings)` = `!enabled && !!remote`。review 第1回で draft 基準から baseline（保存済み）基準に変更（下記）。
- 根拠: 接続先を決めるのは `center_mcp.rs::select_target` で、enabled なら sidecar、そうでなければ remote。sidecar を起動する・止めるのも `center.rs::apply` が見る `enabled` だけ。同じ 1 つの値で「どちらに繋ぐか」と「sidecar を動かすか」が決まるので、これを根拠にした。`center_status`（runtime の state）は、保存で enabled=false にすると `apply` が即 stop するため enabled=false かつ running は過渡状態のみで、根拠にすると保存直後にちらつくので使わない。`center_connection` は非同期で取得中がある（`connection` が null の間は未確定）ので使わない。
- 境界:
  - enabled=false + remote あり: remoteOnly（隠す）。
  - enabled=true + remote あり（保存済み remote は使われない）: 従来どおり sidecar 向けを出す。
  - enabled=false + remote 無し（未接続）: remoteOnly ではない。スイッチが sidecar を起動する唯一の入口のため、スイッチと「状態」を出す（既存 e2e もこの構成を前提にしている）。
  - 未取得: `settings` が null の間はダイアログ本体を描画しない（既存）。settings が載った時点で判定が確定し、`status` の取得を待たないので、ちらつかない。
  - remoteOnly（保存済み OFF + remote）では remote 節の「この PC の center を起動」ボタンが draft の enabled を true にする（remote は保持）。押すとスイッチ・sidecar の設定が出て、スイッチで取り消せる。「解除」は remote を消す導線で、保存後に remote 無しの OFF になりスイッチが戻る。
  - ダイアログ内の編集（スイッチの切替・貼り付け・解除）では remoteOnly は変わらない。隠れるのは保存して開き直してから。
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

## 追加: 参照フォルダ（addDirs）を sidecar 専用にする

指摘: 「参照フォルダが出てるのはおかしい」。

### 分類表への追記

| 項目 | 呼ぶ API | 分類 | 表示条件（変更後） |
|---|---|---|---|
| 参照フォルダ（addDirs）: プロジェクト設定（歯車）/ 追加ダイアログ / 全 session 共通の設定 | `session_settings_update` / `session_create` / `center_settings_update`（addDirs）、フォルダ選択は `pick_directory`（この PC の dialog） | sidecar 専用 | remoteOnly 以外（sidecar ON、または OFF で remote も無い時）。remoteOnly の間は節ごと出さない |

理由: addDirs は center のホスト上の path で、選ぶ dialog はこの Mac のフォルダ dialog。別ホストの center には意味を成さない。追加指示・出力スタイル・使う server は center 側の設定なので、今までどおり出す。

### 判定

先と同じ根拠（`enabled` = sidecar を起動し接続先を決める値）。`composables/centerRole.ts` の `isRemoteOnly(settings)` に切り出して SettingsDialog も同じ関数を使う（別の判定は作っていない）。
- SettingsDialog（共通設定）: 設定の draft から確定（取得待ちなし）。
- ProjectSettingsDialog / AddSessionDialog: 開く時に `center_get_settings` を読む。読めるまで隠し、読めたら判定。読めなかった時は従来どおり出す（誤って隠して機能を失うより、従来挙動へ戻す方を選んだ）。ちらつきは「隠した状態から出る」方向だけにした（remoteOnly で一瞬出る事は無い）。

### 保存時に既存値を消さない

`toUpdate` は空の `addDirs` を `null`（= center で項目削除）にする。draft は center から読んだ値を持ったままなので、そのまま送れば同じ値の送り直しになり消えはしないが、読み込み前の保存や draft が空の時に `null` が出る余地がある。そこで隠している間は親で body から `addDirs` を外す（`delete body.addDirs`）。center の `*_settings_update` は書いた項目だけ変わる（merge）ので、外した項目は更新されない。`sessionInstructions.ts` は触っていない。入力検証も隠している間は `addDirs` を空として扱い、保存済みの相対パスなどで保存が止まらない。`session_create` は draft の `addDirs` が空のため送られない（e2e で確認）。

### ProjectSettingsFields.vue の差分

+3/-1 行（prop `hideAddDirs?: boolean` の 1 項目と型コメント、参照フォルダ節の開始タグに `v-if="!hideAddDirs"`）。既存行の並べ替え・整形なし。prop 名を `hide...` にしたのは、Vue の boolean prop は未指定が false になるため、`withDefaults` を足さずに既定=表示にするため。

### テスト

- `nuxt typecheck` exit 0。
- 全 208 件 pass（retries 0。既存 spec は無変更で pass、新規は settings-remote-center.spec.ts に計 11 件）。
- 新規（`reference folders: sidecar only`）: 歯車 / 追加 / 共通設定のそれぞれで、sidecar ON は参照フォルダ節が出る、OFF + remote は出ない。OFF + remote で歯車の追加指示だけ保存しても、保存済み addDirs が残る（update の body に addDirs が無い、centerSettings が addDirs + instructions）。共通設定も同様（`center_settings_update` の引数に addDirs が無く、center 側の addDirs が残る）。保存済みの相対パスで保存が止まらない。追加は create_session の settings に addDirs が入らない。共通設定で remote を解除すると節が戻る。
- 先に書いた spec の「OFF+remote で共通設定 4 節が出る」は、今回の仕様変更で参照フォルダを除く 3 節 + 非表示の検証に直した（自分の spec であり、既存 spec の期待値は緩めていない）。
- session-instructions.spec.ts の「remote center の typed rows」テストは enabled=true（boardSeed）の構成で、名前に反して sidecar ON のまま typed rows を確認している。触っていない（別 task の担当ファイル）。

## 分類表への追記（review 第1回）

| 項目 | 呼ぶ API | 分類 | 表示条件 |
|---|---|---|---|
| 「この PC の center を起動」ボタン（remote 節。draft の enabled を true にするだけで remote は保持。保存で sidecar が起動） | `center_set_settings`（enabled） | sidecar を起動する入口 | 保存済み remoteOnly の時だけ。押した後はスイッチと sidecar の設定が出て、スイッチで取り消せる |

## review 第1回の指摘と対応

- [medium] remoteOnly が draft 基準で、ON + remote 保存済みで「center を起動する」を OFF にした瞬間にスイッチが消え、ダイアログ内で ON に戻せない（戻すには破棄か破壊的な「解除」）。README の「保存値は切り替えても消えない」とも食い違い。
  - 対応: remoteOnly を load() で読んだ保存済み settings から 1 度だけ判定する baseline 基準に変更（`isRemoteOnly` は保存済み settings を渡す。別の判定は作っていない）。スイッチと「状態」節の表示は `sidecarVisible = !remoteOnly || draft.enabled`（起動ボタンを押した後に取り消せる）。
  - 参照フォルダの隠し・検証・送信除外（commonProblem / saveCommon）も同じ remoteOnly（baseline）を使う。ダイアログ内の切替で隠れて検証・送信から外れることは無い。歯車・追加の hideAddDirs は元から保存値基準で変更なし。
  - 保存済み remoteOnly には remote 節に「この PC の center を起動」ボタンを置いた。「解除」は従来どおり remote を消す導線。
- e2e: settings-remote-center.spec.ts に追加・修正。
  - ON + remote 保存済み: スイッチを OFF にしてもスイッチと参照フォルダ欄が残り、ON に戻せる。参照フォルダの検証・送信も効く。
  - 保存済み OFF + remote: スイッチ非表示、起動ボタン表示。押して保存すると `center_set_settings` が enabled=true かつ remote 保持で呼ばれ、開き直すと sidecar 向けが出る。
  - 「解除」は remote を消す（保存で remote 無しになりスイッチが戻る）。
  - 自作 spec の旧期待値（「解除でスイッチが即戻る」「共通設定で解除すると参照フォルダが即戻る」）は draft 基準を前提にしていたため仕様変更として直した。既存 spec の期待値は緩めていない。

## 残り（直さない low）

- fix/servers-session-only との merge 衝突: cap が merge 時に解消する。
- session-instructions.spec の「remote center の typed rows」テストの名前と構成（enabled=true）の食い違い: 別 task。
