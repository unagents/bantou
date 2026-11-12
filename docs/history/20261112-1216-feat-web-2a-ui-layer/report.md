# web 版まとまり 2a: packages/ui の抽出（layer 化と import 書換）

- branch: `feat/web-2a-ui-layer`（基点 `origin/develop` = aa3b86d48e455bd41095bbde866eb8415336bf71）
- HEAD: （push 後の full SHA は完了報告に記す。この report を含む commit のため file 内には書けない）
- commit 構成: 1) 移動のみ（`git mv`、中身不変、この commit 単体では build しない）→ 2) import 書換と layer 設定 → 3) この report

## 変更

- 新設 `packages/ui`（`bantou-ui`、private）: `nuxt.config.ts`（modules / css / colorMode / unfonts / `#bantou-ui` alias）、`package.json`、`bun.lock` は ui の workspace 項目の追加のみ。
- `git mv`: desktop の `src/api` `src/assets` `src/types` `src/composables` と `src/components/*`（`AppHeader.vue` 以外）を `packages/ui/` へ（38 file。rename 検出される）。
- `packages/desktop/nuxt.config.ts`: `extends: ["../ui"]`。modules / css / colorMode / unfonts は ui へ移した（desktop 側から除去）。
- desktop に残したもの: `pages/index.vue`、`components/AppHeader.vue`、`plugins/log.client.ts`、`app.vue`、`app.config.ts`、`utils/localNetwork.ts`、`tauri/`。
- e2e の import 追従（3 file）: `e2e/terminal-buffer.spec.ts`、`e2e/mock/bantou.ts`（移動先の path）、`e2e/pane-resize.spec.ts`（comment の path）。
- Rust（`src-tauri`）、protocol、version、pages/index.vue の分離、CLAUDE.md は変更なし。

## `~/` import の書換: 実数 49 箇所（設計書は 47）

- 移動した file 内 45 箇所 → 相対 path（`~/types` 19、`~/api` 16、`~/composables` 10）。
- desktop に残る file 4 箇所（`pages/index.vue` 2、`AppHeader.vue` 1、`plugins/log.client.ts` 1）→ `#bantou-ui/<path>`（types 2、api 2）。
- 数え方: `from "~/..."` と `import("~/...")` の形のみ。`~/tauri`（16 箇所）、`~/utils/localNetwork`（1）は書換えていない。文字列 `~/.bantou` 等は対象外。
- 設計書 47 との差 2: 基点（まとまり 1 後）の実数。設計書は types 21 / api 17 ほか。実数は types 21 / api 18 / composables 10。

## 設計書との差・判断

1. **`#layers/ui/...` は使えない**: 試したところ vite が `Missing "#layers/ui/api/log" specifier in "nuxt" package` で失敗。ui の nuxt.config に named alias `#bantou-ui` を定義して使った。
2. **`~/tauri` は書換えていない（要判断）**: moved file の `~/tauri`（`getTransport` / `getPlatform`）は layer 内で利用側 project の `src/tauri` に解決される。desktop は従来どおり動くが、web は自前の `~/tauri` 相当を持たねば解決できない。契約の置き場（ui 側へ `Transport` を持つ・plugin 登録）は 3b / 5a の設計事項と判断し、2a では内容不変を優先した。`packages/ui` に `@tauri-apps` の import は無い。
3. ui の `package.json` に desktop と同じ pin の依存（nuxt / @nuxt/ui / xterm / vueuse / tailwind / fonts / vue）を書いた。desktop 側の依存は削っていない。
4. `app.config.ts`・`app.vue`・`utils/` は設計書の ui 一覧に無いので desktop に残した。
5. ui の `srcDir` は `.`（`components/` などを package 直下に置く）。
6. 古い参照が残る（変更していない）: `src-tauri/src/center.rs:1097` の comment `src/api/sessions.ts`、`src/app.config.ts:5` の comment、`docs/history/*` の旧 path、`packages/desktop/CLAUDE.md` 等。CLAUDE.md の更新は 2b。
7. `bun.lock`: `bun install` が `packages/server` の version（0.6.4→0.6.7）も書き換えたので、その 1 行は戻した（ui 項目のみ残す）。`bun install --frozen-lockfile` は通る。

## 確認結果

| 項目 | 結果 |
|---|---|
| `bun install --frozen-lockfile` | 通る |
| packages/desktop `nuxt typecheck`（基点・変更後とも） | 通る（exit 0。`vue-router/volar/sfc-route-blocks` の解決警告は基点にもある） |
| packages/desktop e2e（mock、Linux headless chromium shell、一時 config、retries=1、workers=1） | **220 passed / 220**（基点の `--list` も 220、23 file）。8.0 分。flaky 0 |
| `nuxt generate` | 通る。出力 `packages/desktop/.output/public` |
| generate の出力比較（基点 vs 変更後） | file 一覧 37 件で同一。`_nuxt/*.js` `*.css` は名前（content hash）とも同一（`entry.*.css` 210570 B ほか）。差は build id を含む `index.html` `200.html` `404.html` `_nuxt/builds/latest.json` と `builds/meta/<id>.json` のみ。合計 1833444 B で同一 |
| tauri.conf.json（`beforeBuildCommand` = `bun run build:sidecar && bun run generate`、`frontendDist` = `../.output/public`） | generate の出力先が `frontendDist` と一致。変更不要。layer の assets（css）は `_nuxt/entry.*.css` に入り、基点と同一 |
| `@tauri-apps` の import | `packages/desktop/src` では `src/tauri/` のみ、`packages/ui` は 0 件（grep） |
| packages/web test | 38 pass |
| packages/protocol test | 43 pass |
| packages/server test | 349 pass |
| packages/center test | 616 pass / 1 fail（`center を SIGKILL すると rc が孤児で残り、次の center の起動で回収される`＝既知の不安定の rc-orphan） |

## 動かせなかった確認

- `bun run tauri build`: mac が要るため未実施。generate の出力先と `frontendDist` の一致までを確認した。
- 設計書にある「mac200 の e2e」「保存画像（`board.png` ほか）を人が見比べる」: 未実施（Linux headless chromium shell で mock e2e を回した）。見た目の同一性は上の generate 出力の css / js 同一（content hash 一致）で代替確認したが、人の目視ではない。
- 基点の e2e 自体は走らせていない（件数は `--list` の 220 と比較）。
- Rust の `cargo test`: 範囲外（Rust 不変）で未実施。
