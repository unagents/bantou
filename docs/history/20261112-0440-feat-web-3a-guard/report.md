# feat/web-3a-guard: web backend の守り（まとまり 3a）

- 基点: `origin/develop` `2634a9712d0f43ded5601890067b73452c728c99`
- 設計: `docs/web-app-design` `db7a9f7e659dff08dedf614ae0d48cdfbed17f42` の design.md 5.2・10.2（3a）・2.1

## 作ったもの（`packages/web/`）

- 足場: `package.json`（`bantou-web`、private、version 0.0.0）、`nuxt.config.ts`（`ssr:false`・`pages:false`、UI なし）、`tsconfig.json`、`.gitignore`。`extends: ["../ui"]`・plugin・page・transport は 5a の範囲なので作っていない。
- `server/utils/guard/`
  - `config.ts`: env から設定を作る。`CF_TEAM` `CF_AUD` `ALLOWED_EMAILS`（カンマ区切り、小文字化）`PROXY_KEY` が必須。欠けたら 500 で全拒否。
  - `jwks.ts`: 署名鍵の cache（TTL 10 分）。未知の `kid` は 1 リクエストにつき取り直し 1 回だけ。取得失敗は鍵なし扱い（401）。
  - `jwt.ts`: RS256 のみ。署名・`iss`・`aud`（文字列/配列）・`exp`（必須）・`nbf`・`email`。許可外 email は 403、他の不正は 401。
  - `proxy-key.ts`: `X-Bantou-Proxy-Key` を sha256 経由の `timingSafeEqual` で照合。無い・違うは 403。
  - `origin.ts`: GET/HEAD/OPTIONS 以外は `Origin` の host が `Host` と一致する時だけ通す。無い・`null`・不一致は 403。
  - `handler.ts`: 上の順（共有鍵 → JWT → Origin）で全 route に掛ける h3 handler と `/api/me` の本体。
- `server/middleware/00.guard.ts`（全 route）、`server/api/me.get.ts`（`GET /api/me` → `{ email }`）。
- test: `test/server/utils/guard/`。test が生成した RSA 鍵の偽 JWKS（localhost の http server）で署名。メール・team・aud はダミー値。
- `bun.lock`: `packages/web` の分（workspace 追加と依存 5 件）のみ。bun が書き換えた `packages/server` の version 行（0.6.4→0.6.7）は戻した。

## 確認

- `packages/web`: `npm test` 24 件 pass / 0 fail。
  - JWT 無し・署名違い・本文改ざん・alg none/HS256・壊れた JWT・aud 違い・iss 違い・期限切れ・exp 無し・許可外 email（403）・email 無し/非文字列、共有鍵の欠落/不一致/空、POST/PUT/PATCH/DELETE の Origin 不一致/欠落/null、GET は Origin 不問、鍵ローテーション（未知 kid で取り直し 1 回、以降 cache）、JWKS 取得不可は 401、設定不正は 500、正常系（`/api/me` が email を返す）。
- `packages/web`: `npm run typecheck`（`nuxt prepare && tsc --noEmit`）通過。
- `packages/web`: `npm run build` 通過。`.output/server/index.mjs` を実際に起動して curl: 鍵無し 403 / 鍵のみ 401 / 壊れた JWT 401 / `/` も 403 / POST 401（JWT で止まる）。起動したプロセスは停止し、port 解放を確認。
- 既存: protocol 43 pass、center 616 pass / 1 fail（既知の rc-orphan「center を SIGKILL すると rc が孤児で残り…」）、server 349 pass、memory 52 pass。center・server は protocol の `npm test`（`tsc`）で `dist` を作ってから実行した（未ビルドだと import 解決で落ちる。今回の変更とは無関係）。

## 動かせなかった確認と理由

- desktop の e2e（Playwright）: mac200 が要るため未実施。desktop には触れていない。
- JWT が実際の Cloudflare から届くか・鍵の取得先への外向き通信: 設置時の項目（設計 13 章）。実 Cloudflare・実 JWKS には接続していない。

## 設計書との差・判断

- env 名: 設計 5.2 は test 用に `WEB_CF_CERTS_URL` / `WEB_CF_TEAM`、5.5・9.1・10.2 は `CF_TEAM` `CF_AUD` `ALLOWED_EMAILS` `PROXY_KEY` と書いていて食い違う。本番の env は後者に統一した。`WEB_CF_TEAM` は作らない（`iss` は常に `CF_TEAM` から決まる）。`WEB_CF_CERTS_URL` は鍵の取得先だけを変える任意の env で、署名・iss・aud の検証は変わらない（「検証を切るモード」ではない）。
- 時刻の許容: `exp`/`nbf` に 30 秒の leeway を持たせた（設計に値の指定は無い）。host 間の時計ずれで正しい JWT を落とさないため。
- `exp` が無い JWT は拒否にした（設計は `exp` の検証としか書いていない）。
- 判定順は共有鍵 → JWT → Origin。共有鍵が先なのは、鍵を持たない要求が JWKS の取得（外向き通信）を起こさないようにするため。
- JWKS 取得失敗時は旧 cache を残し、`kid` が見つからなければ 401。取得失敗が続く間は要求ごとに取り直しを試みる（共有鍵を通った要求だけ）。
- `PROXY_KEY` の長さ下限は設けていない（空だけ拒否）。
- Origin の比較は `Host` header のみ。`X-Forwarded-Host` は信用しない（nginx が `Host` を保つ前提、設計 8.1）。
- `/api/health` などは 3d の範囲なので作っていない。`/api/me` 以外の route は無い。
