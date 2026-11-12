# feat/web-1-transport 実装 report

設計 `docs/web-app-design` の design.md 10.2「まとまり 1」(Tauri 依存の集約) の実装。desktop の動き・見た目は変えない。

## 変更

- 新設 `packages/desktop/src/tauri/`（`@tauri-apps` を import する唯一の場所）
  - `transport.ts`: `Transport`（`invoke` / `listen`）。command 名・event 名・型は従来のまま。`listen` の handler は payload を直接受ける
  - `platform.ts`: command / event 契約に入らない機能の interface（updater・relaunch・openExternal・ファイルドロップ・log・fs 監視・現在 window）
  - `index.ts`: 再 export
- `src/api/*.ts`: `invoke` → `getTransport().invoke`。`updater` / `log` / `attachment`(drop) / `center`(openExternalUrl) は `getPlatform()` 経由
- `~/api` の外の Tauri import（`useTerminalStore` `useBoard` `useSessionRefresh` `ThreadModal` `useUpdater` `useWorkspaceWatcher` `types/index.ts`）を `~/tauri` 経由に
- Rust（`src-tauri`）、protocol、version、`bun.lock` は変更なし

## 設計との差・判断

- `session_attach_bytes` は `invoke(cmd, bytes, {headers})` を `invoke(cmd, undefined, {headers, body})` に表した（設計 3.2 の `opts.body`）。tauri 実装が `opts.body ?? args` で元の呼び出しと同一にする
- platform 機能は 1 つの `Platform` interface に集めた（設計 3.2 の「1 か所の interface」）。drag region は属性 `data-tauri-drag-region`（import ではない）なので今回は触れていない（まとまり 2b 以降）
- `listen` の handler 型を `(payload) => void` にした（設計 3.2 の型どおり）。呼び出し側の `e.payload` を `p` に置換

## 確認

- `grep -rn "@tauri-apps" packages/desktop/src` は `src/tauri/` のみ（`e2e/mock/install.ts` のコメント 1 件は src 外）
- `bun run typecheck`（`nuxt typecheck`）: exit 0、error TS 0 件
- 既存 unit test: desktop に無し（`e2e` のみ）
- 既存 e2e（mock、Linux の headless chromium、`--retries=1`）: 220 passed / 0 failed (8.4m)
- 動かせなかったもの
  - macOS 実機での e2e と `bun run tauri build`（`packages/desktop/CLAUDE.md` の手順）: 他 host へ接続しない制約のため未実施。release 前に実施が必要
  - 保存画像（`board.png` ほか）の人の目視比較: 未実施。コードは表示に触れていない
  - `cargo test`: Rust 未変更のため未実施
- center の rc-orphan 1 件: 既知。今回は center を実行していない
