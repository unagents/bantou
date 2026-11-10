# 再ログインの URL を desktop 側のブラウザで開く

branch: fix/relogin-local-browser（基点 develop 0.1.44）

## 要望

desktop は普段使いの Mac、center は別 host（mac200）の構成で、認証 URL は手元の Mac で開きたい。center の host で開いても見えない場合がある。

## 調査: claude のブラウザ自動起動を抑えられるか

結論: **抑える設定は center に入れない（変更なし）**。起動しても流れに影響しない。

根拠（claude 2.1.322、この host の binary の文字列 / 公式 docs）:

- 公式 docs（env-vars / settings）に、`/login` のブラウザ起動を止める env・flag の記載は無い。`claude auth login --help` の option は `--claudeai` `--console` `--email` `--sso` のみ（`--no-browser` 相当なし）。
- binary 内の URL を開く関数: 開く command は「settings の `browser`、無ければ env `BROWSER`、無ければ `xdg-open`」。Linux で `BROWSER` 無しかつ `DISPLAY` / `WAYLAND_DISPLAY` 無しなら開かず `no_display`。TTY 判定・`SSH_CONNECTION` の有無を見る関数もある。
- ただし (1) `/login` の画面がこの関数を通るか、(2) macOS（center host の想定）で同じか、(3) `BROWSER` を空/ダミーにした時に URL の表示が残るか、は **未確認**（確かめるには `/login` の実行が要り、制約で実行していない）。`BROWSER=true` は claude 側で「未設定」扱いの判定もあり、`true` で偽装すると「開けた」と見なされ URL 表示が変わる恐れがある。確証なく center の spawn env を変えると、検知（text から URL を拾う）が壊れるリスクがあるため入れない。
- 今の経路で足りる根拠: binary に `Use the URL below to sign in` と `Browser didn't open? Use the url below to sign in` の両方があり、ブラウザが開いた場合・開かない場合のどちらでも URL は画面（= wrapper の text）に出る。center は text から URL を拾う（0.1.44 の `findLoginUrl`）ので、host 側のブラウザ起動の成否に依存しない。開いても利用者に見えないだけで無害。

## 変更点

- `packages/desktop/src/api/center.ts`: `openExternalUrl(url)`。http(s) 以外は reject。`invoke("plugin:shell|open", { path })`。
- `packages/desktop/src/api/index.ts`: export 追加。
- `packages/desktop/src/components/LoginDialog.vue`: URL の横に「開く」（`data-testid=login-open`）。失敗時は「ブラウザで開けない（URL をコピーして開く）」を出し、流れは続行。案内文を「この Mac のブラウザで開く（center の Mac では開かない）」に変更。「コピー」は既存の `navigator.clipboard`（SettingsDialog と同じ仕組み）のまま。コード入力 → `session_login_code` は変更なし。
- `packages/desktop/e2e/mock/bantou.ts`: `plugin:shell|open` を受ける。
- `packages/desktop/e2e/login.spec.ts`: 「開く」で `plugin:shell|open` に `{ path: <loginUrl> }` が渡る・center への追加呼び出しが無い・「コピー」で clipboard にその URL が入る・「開く」失敗時の表示、の 2 件を追加。
- docs: `packages/center/README.md`「再ログイン」、`packages/desktop/README.md`。
- center / protocol / server: 変更なし。

## capabilities の変更

`packages/desktop/src-tauri/capabilities/default.json` に `shell:allow-open` を追加。tauri-plugin-shell（`=2.3.6`）は `lib.rs` で既に `init()` 済みで、JS 側 package（`@tauri-apps/plugin-shell`）は入れず、既存の `@tauri-apps/api` の `invoke` で plugin command を呼ぶ（新規依存なし、Cargo.lock / package.json 変更なし）。scope は plugin 既定（http(s) / mailto / tel）。`shell:default` ではなく `allow-open` だけにして execute / spawn は許可しない。center の sidecar 起動は Rust 側からの呼び出しで capability の対象外。

## テスト結果

- `packages/protocol` `npm run build`: OK。
- center `bun run typecheck` OK、`bun run test` 519 pass / 0 fail。
- desktop `bun run typecheck`（nuxt typecheck）: exit 0、TS error 0。`vue-router/volar/sfc-route-blocks` の解決警告が出るが、変更前（stash）でも同じ。
- desktop e2e: `nuxt generate` の静的ビルドを簡易 node server で配信し、ms-playwright の chromium（自己完結の一時 config）で全件実行: 170 passed（retries 0、新規 2 件含む）。簡易 server は停止し 1420 解放を確認。
- Rust（`cargo test` / 実機の Tauri `open`）は未実行。**実機でだけ確かめられる**: capability `shell:allow-open` で実際に既定ブラウザが開くこと。

## 残課題

- 実機確認: desktop(Mac) → center(mac200) で再ログイン → 「開く」で手元のブラウザが開く。
- 上記 (1)〜(3) の確証が要るなら、実機で `BROWSER` を center の env に入れた時の `/login` 画面（URL が text に残るか）を観察する。残るなら center の spawn env で `BROWSER` を抑える案が成立する。
- `bun.lock` が `bun install` で変わったが commit していない。
