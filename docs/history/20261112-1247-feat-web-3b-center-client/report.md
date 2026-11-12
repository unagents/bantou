# feat/web-3b-center-client report

まとまり 3b: 共有 package `packages/center-client` の新設と center 設定の部分（設計書 10.2「3b」、5.5、5.6）。

## 入れたもの

- `packages/center-client`（`bantou-center-client`、private、TS、framework 非依存）
  - `normalize.ts`: `normalizeRemote`、`redactUrl`
  - `settings.ts`: `validateSettings`、`selectTarget`、`parseStored`（serde と同じ読み方）、`ensureToken`/`mintToken`、`repairRemoteUrl`、`redactSettings`、`SettingsPolicy`（`allowEnabled`）
  - `store.ts` / `file-store.ts`: `SettingsStore` 注入点、file 保存（一時 file→chmod 600→rename）
  - `center-settings.ts`: `createCenterSettings({ settingsStore, policy, redactSecrets, env })` が `get` / `set` / `selectTarget` / `envLocks`
- `packages/ui/types/index.ts`: `CenterSettings.bind` を optional、`CenterSettings.tokenSet?`・`CenterRemote.tokenSet?` を追加。この 3 点だけ。
- MCP client・SessionCache・events は作っていない（3c）。Rust・protocol は変更なし。

## 設計書との差・判断

- `policy` は 3b では `allowEnabled` だけ（既定 false = web v1。`enabled:true` の保存は「未対応」で拒否）。`allowTool` は 3c。
- 設定 file の中身は `CenterSettings` 1 つの JSON（desktop の `center` キーの中身と同じ形）。`center` キーで包んでいない。
- env で固定した項目の値は設定 file に書かない。固定項目の変更は拒否。`CENTER_URL` 固定で file に `remote` が無い時の「token だけ保存」も拒否。env 固定の有無は `envLocks()` で返す（画面向けの応答型は 3d/5c で決める）。
- `redactSecrets` が偽の時、`get` は desktop と同じ形（token を含み `tokenSet` なし）。
- 保存済みの `enabled:true`（file を手で編集）は、読み込み時には落とさない（Rust と同じ）。保存だけ拒否。
- `redactUrl` は 5.5「userinfo をログ・エラーに出さない」の下地として Rust の `redact_url` を写した（呼び出し側は 3c 以降）。
- `packages/ui/types/index.ts` が `import("~/tauri").Update`（Nuxt の alias）を含むため、center-client の typecheck 用に `src/ui-types-shim.d.ts` で stub した。ui 側は変えていない。
- token 生成は Rust と違い `enabled` が真の時だけ（5.5）。
- `isAbsolute`（workspace・claudePath）は Windows 形（`C:\`、`\\`）も絶対と見る。Rust（Linux ビルド）の `Path::is_absolute` は `/` 始まりだけなので、Windows 形の入力で差が出る（desktop は Windows ビルドなら Rust 側も許容。コードは変えていない）。
- 設定 file の同時書き込みの排他は v1 では無い（temp→rename で file が壊れることは無いが、同時の set は後勝ち）。
- URL の正規化は WHATWG URL（JS）。Rust の reqwest::Url と全 12 行の表で一致を確認。

## 確認

- `packages/center-client`: test 37 件 pass、`tsc --noEmit` pass。
- 既存: web 38/38、protocol 43/43、server 349/349、center 616/617（落ちた 1 件は既知の不安定 `rc が孤児で残り…`）。
- center-client が Nuxt/Nitro/Tauri/h3/vue を import しないことは test で grep 相当を実行。
- 動かせなかった確認: desktop の `nuxt typecheck`（この環境の vue-tsc が MODULE_NOT_FOUND で起動しない）。`bind` optional の影響は `SettingsDialog.vue` / `e2e/mock` を読んで確認（`!bind` で絞り込み、`?? ""`、代入のみ）。desktop の e2e は未実行。
- bun.lock は center-client の追加分のみ（`packages/server` の version 行は戻した）。

## Rust test → TS test の対応

| Rust（出典） | TS test（`test/rust-parity.test.ts`） | 備考 |
|---|---|---|
| center.rs:787 `defaults` | `R:787` | |
| center.rs:797 `partial_json_uses_defaults` | `R:797` | |
| center.rs:804 `rejects_bad_port_bind_and_remote` | `R:804` | bind の 2 行は web に bind が無いので写していない |
| center.rs:823 `saving_a_remote_stores_the_canonical_url` | `R:823` | |
| center.rs:834 `a_broken_stored_remote_url_is_repaired_on_load` | `R:834` | |
| center.rs:846 `token_validation_and_minting` | `R:846` | |
| center.rs:861 `ensure_token_mints_only_when_missing_or_short` | `R:861` | |
| center.rs:872 `old_remote_url_key_is_dropped_on_read` | `R:872` | |
| center.rs:880 `old_connect_host_key_is_dropped_on_read` | `R:880` | web は bind も落とす |
| center_mcp.rs:526〜575 `target_*` 6 件 + `sidecar_is_dialed_on_loopback...` | `M:526` `M:531` `M:540` `M:557` `M:563` `M:569` `M:575` | host は dummy |
| center_mcp.rs:878 `normalize_remote_gives_one_form...` | `M:878` | 全行 |
| center_mcp.rs:902 `select_target_normalizes_a_stored_remote` | `M:902` | |
| center_mcp.rs:910 `redact_url_drops_credentials_and_query` | `M:910` | |
| 写していない | | `bind_failure_is_read_from_the_log`・`config_json_*`・`autostart_*`（sidecar の起動、まとまり S）、`center_mcp.rs` の mock center 系（3c） |

web 側の追加 test（`test/center-settings.test.ts`）: get が token を返さず `tokenSet` を返す／set で空 token は据え置き／`remote.url` を変えると token を引き継がない／env 固定／`enabled:true` 拒否／file 保存（mode 600、temp が残らない）／設定 file の書き換えが次の呼び出しから効く。

## review 1 の修正

- M1: `CENTER_TOKEN` 固定中でも、`remote.url` が変わる時は file の旧 token を捨てる（R29）。url が同じなら残す。test に再現手順（file{a, OLD}、env token、url→b）を追加。
- M2: 設計書 5.5「画面に出すのは url の host 部…まで」「token と url の userinfo は…出さない」、R28「応答で伏せる」に従い、`redactSecrets` が真の時の get/set 応答は `remote.url` に `redactUrl`（userinfo・query・fragment を除く）を適用した。偽の時は desktop と同じ形（保存値のまま）。
  - 判断: 伏せた形を画面が set に送り返しても、同じ宛先とみなし、保存済みの url（userinfo 付き）と token を保つ（伏せた形で file を上書きしない）。別の宛先なら従来どおり token を捨てる。env 固定の url 比較も同じ扱い。
  - 設計書は「Rust の応答と揃える」とは書いていない（desktop の応答は token も含む従来形）。web だけの差として `redactSecrets` に閉じ込めた。
- L1: 入口で型検査（`assertSettingsShape`、`validateSettings` と `set` の先頭）。型不正は TypeError でなく `CenterSettingsError`。
- L3: test 追加。port 整数（7910.5・NaN）、https 受理、parseStored の型不正、enabled:true の file の上位 token（get は空と tokenSet:true、空 token の set で据え置き、新 token で置換、token 無しなら生成して保存）、CENTER_URL 固定で file に remote が無い時の token だけ保存の拒否、env url の正規化。
  - 変異確認（変異は commit していない）: M1 の無条件 file token、redactUrl 無し、伏せた形の同一視無し、set／validate の型検査無し、port 整数検査無し、https 拒否、parseStored の enabled 検査無し、get の token 非表示無し、空 token 据え置き無し、token だけ保存の拒否無し、env url 正規化無し — 12 変異のすべてで test が落ちた。
- L2: 上記「設計書との差」に記載。L4: 直さない（v1 は排他なし）。
- 既存: web 38/38、protocol 43/43、server 349/349、center 616/617（既知の不安定 rc-orphan のみ）。
