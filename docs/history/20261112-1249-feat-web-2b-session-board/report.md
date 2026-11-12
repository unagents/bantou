# web 2b: pages/index.vue のロジック分離と文書更新

branch: feat/web-2b-session-board（基点 origin/develop a81461c）

## 変更
- `packages/ui/composables/useSessionBoard.ts` を新設。`pages/index.vue` の旧 62-158 行（選択・フィルタ・ダイアログ管理・add session・再ログイン）を移した。`ACTIVITY_CHIPS` `ChipKey` も同 file。
- `packages/desktop/src/pages/index.vue`: 372 行 → 293 行。`useBoard` の結果を `useSessionBoard(board)` に渡し、template は変更なし（3 カラムのまま）。thread modal（旧 47-60 行）は設計書の範囲外なので page に残した。
- root `CLAUDE.md`、`packages/desktop/CLAUDE.md` を更新（下記）。
- Rust・protocol・package.json・bun.lock は変更なし。

## 確認
- `nuxt typecheck`: exit 0（vue-router/volar の plugin 解決警告は出る。error TS なし）
- mock e2e: 220 passed / 0 failed / flaky なし（8.8 分、headless shell、--retries=1 --workers=1）
- `nuxt generate`: 成功（`.output/public` 生成）
- 動かせなかった確認: mac200 での実行、`bun run tauri build`、保存画像（board.png ほか）を人が見比べる確認。この環境は Linux headless で、画像比較は未実施。

## 設計書との差
- 設計書は「`pages/index.vue:62-158`」を移す。行範囲どおり再ログイン（loginOpen / onLoggedIn）まで含めた。
- 設計書の「root CLAUDE.md の Map に `packages/center-client` / `packages/web`」は、center-client が未存在、web は 2b の範囲外のため追記していない。`packages/ui` のみ。

## CLAUDE.md の変更文面（全文）
### root `CLAUDE.md`
Map の desktop 行を差し替え:
> - `packages/desktop/`: Tauri 2 + Nuxt 4。`src/`（Nuxt。`pages/index.vue`・`AppHeader`・`src/tauri/` など desktop 固有の部分）と `src-tauri/`（Rust）。画面の共有部品は `packages/ui` から取り込む（`nuxt.config.ts` の `extends: ["../ui"]`）。

Map に追加:
> - `packages/ui/`: bantou-ui（private）。desktop（将来は web も）が共有する Nuxt 4 layer。`components/` `composables/` `types/` `assets/` `api/`。Tauri の package に依存しない。

「役割分離ルール」に追加（既存 2 行は残す）:
> - 画面（Nuxt の components / composables / types / api）の共有部品は `packages/ui/` に置く。`packages/ui/` は Tauri の package を import しない。ui 内の file が `~/tauri` を import する形で、利用側 project の `src/tauri/`（desktop では Tauri 実装）に解決させる。desktop 固有の部分（`pages/index.vue`・`AppHeader`・`src/tauri/`・Rust）は `packages/desktop/` に残す。

### `packages/desktop/CLAUDE.md`
「Review check (before release)」の前に節を追加:
> ## UI の置き場所
>
> - 画面の共有部品（components / composables / types / api / assets）は `packages/ui/`（Nuxt layer）にある。desktop は `nuxt.config.ts` の `extends: ["../ui"]` で取り込む。共有部品の変更も下の Review check（e2e）の対象。
> - `packages/ui/` の file は Tauri の package を import しない。`~/tauri`（desktop では `src/tauri/`）経由にする。`@tauri-apps` を import してよいのは `src/tauri/` だけ。
> - desktop 側の file から ui の file を参照する時は alias `#bantou-ui` を使う（例: `#bantou-ui/api`）。ui 内では `~/` が利用側 project 基準になるため、ui 内の相対 import に `~/` を使わない（`~/tauri` を除く）。
> - `pages/index.vue` の選択・フィルタ・ダイアログ管理は `packages/ui/composables/useSessionBoard.ts`。3 カラムの配置は `pages/index.vue` に残る。
