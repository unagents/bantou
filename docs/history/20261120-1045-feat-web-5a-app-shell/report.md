# まとまり 5a: web の足場・HTTP transport・session 一覧

branch: `feat/web-5a-app-shell`（origin/develop 7e086d7 から）。HEAD の SHA は報告（mcp report）に書く（この file 自体が HEAD に含まれるため）。

## 作った物（packages/web）
- `nuxt.config.ts`: `extends: ["../ui"]`、`ssr:false`、`srcDir: "app/"`（ui の layer が `srcDir: "."` を持つので、web は自分の app/ を明示）。
- `app/tauri/`（ui の `~/tauri` に解決される web 側の実体）
  - `transport.ts`: command → `POST /api/rpc/<cmd>`（body は args の object、失敗は HTTP status + `{"error"}` を `RpcError` に。`String(e)` は message のみ）。event → `GET /api/events` の SSE 1 本を全 listener で共有。
    - 新しい stream が開いた時に `bantou://sessions-changed` を listener へ流す（backend が stream 接続前に変えた一覧は replay が無く、一覧が空のまま止まるため。e2e で見つけた）。落ちて再接続した時は `bantou://os-wake` も流し、center の取りこぼしを読み直させる。
    - browser が諦めた stream（Access 切れの redirect など）は閉じて、5〜60 秒の間隔で開き直す。
    - 端末の出力・入力（`body`）は 5b なので未対応（呼ぶと RpcError）。
  - `session-watch.ts`: 設計書 5.2。SSE の失敗が 3 回続く、または browser が諦めたら `/api/me` を呼び、backend の答えでなければ（redirect・HTML・非 2xx）reload。通信不能（offline）では reload しない。30 秒以内の再 reload は拒否（ログインできない時の loop 防止）。command が 401/403/redirect の時も同じ確認。
  - `platform.ts`: browser 用 Platform。
- `app/pages/index.vue`: スマホ向け一覧（設計書 7.1 の 1 階層目）。`useBoard` / `useSessionBoard`（ui の共有 composable）を使用。「接続先が無い」「center に問い合わせられなかった」「session が無い」の表示。
- `server/plugins/00.guard.ts`: 守りを h3 stack の先頭に積む（下記）。`server/middleware/00.guard.ts` は削除。

## 静的 asset を守りの内側に入れた方法（3a review の宿題）
Nitro の静的配信（public/ と `/_nuxt/*`）は server middleware より先に応答する。`defineNitroPlugin` で `nitro.h3App.stack.unshift(...)` により守りを stack の先頭（静的配信より前）に置いた。守りを切る mode は無い。
配線 test（`test/server/nitro-wiring.test.ts`）に追加: 共有鍵なしで `/` と `/_nuxt/*` の js/css は 403（拒否の応答に中身が出ない）、JWT なしは 401、HEAD も 403、鍵と JWT があれば 200。e2e でも「鍵・JWT なしの browser は `/` に 403」を確認。

## 確認の結果
| 確認 | 結果 |
|---|---|
| packages/web test（`node --test`） | 68 件 pass（既存 62 + 配線 1 + session-watch 5） |
| packages/web typecheck（`tsc --noEmit` と `nuxt typecheck`） | pass（tsconfig の lib に DOM を追加。test が app/tauri を import するため） |
| packages/web `nuxt build` | pass |
| packages/web e2e（Playwright、chromium headless shell を executablePath 指定、`--retries=1 --workers=1`） | 7 件 pass |
| packages/center-client test | 229 件 pass |
| packages/center-client typecheck | pass |
| desktop typecheck（`nuxt typecheck`） | pass |
| desktop の mock e2e（220 件） | 回していない。packages/ui・desktop は 1 行も変えていない（`git diff origin/develop -- packages/ui packages/desktop` が空）ため |

e2e の中身（`packages/web/e2e/`）: 実際に build した backend（守りの内側）+ 偽 JWKS + 署名済み JWT（Cloudflare の代わりに request header で付与）+ 偽 center（127.0.0.1 のみ、空き port）。一覧が出る／center の event で一覧が SSE 経由で変わる／空の一覧／鍵・JWT なしでは何も出ない／接続先なしで「接続先が無い」／stream が戻らず `/api/me` が backend の答えでない時に reload／`/api/me` が答える時は reload しない。`bun run e2e` は `nuxt build` の後に playwright を回す。`CHROMIUM_PATH` で chromium の実行 file を指定できる。

## 動かせなかった確認と理由
- desktop の mock e2e（220 件）: 上記の通り ui・desktop 無変更のため未実施。
- 実 center（本物の broker）に対する e2e: 偽 center で行った（設計書 10.2 は「実 center」）。この host で center を起動してはいけない制約のため。
- この host は IPv6 経路が無く、bun install は npm registry へ直接届かなかったため、作業 dir 内の IPv4 中継（一時 process、停止済み）経由で入れた。bun.lock から中継の URL は除いてある。

## 設計書との差
- 設計書 10.2 は「plugin で HTTP transport を登録」。実際は ui が `~/tauri` を import し、利用側 project の `app/tauri/` に解決される仕組み（申し送り）なので、web は `app/tauri/` に transport と platform を置いた。plugin は不要。
- e2e は偽 center（上記）。「JWT を失効させる」は、stream の失敗と `/api/me` の redirect/HTML を browser 側の route で再現。
- `packages/web/playwright.config.ts` はスマホ幅（Pixel 7）の project 1 つ。

## 足した依存
packages/web の devDependencies に `@playwright/test ^1.63.0`（e2e）と `vue-tsc 3.2.5`（`nuxt typecheck` が要求。desktop と同じ版）。bun.lock は workspace の 2 行のみ。version は変えていない。
