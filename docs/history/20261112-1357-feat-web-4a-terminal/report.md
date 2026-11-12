# まとまり 4a: packages/center-client の端末の module

- branch: `feat/web-4a-terminal`（基点 origin/develop 5d0511b8ce7e0e9cc2a174e5f2e9f5bbc4c6032d）
- HEAD の full SHA: この report を含む commit の SHA は自分自身を書けないため、cap への done report に記載
- 設計書: origin/docs/web-app-design db7a9f7e659dff08dedf614ae0d48cdfbed17f42 の 5.1 / 5.3 / 5.4 / 5.6 / 10.2「4a」

## 足した物（packages/center-client のみ）

- `src/sse.ts`: `SseParser`（terminal.rs の SseParser と同じ規則）
- `src/terminal.ts`: `sessionUrl` / `centerUrl`、`toPayload`、`streamOnce`（Last-Event-ID、45 秒無音で切る、接続 5 秒）、`postSession`（input / resize、10 秒）、`reconnectDelayMs`（1,2,4,8,15 秒）、`createTerminals`（`openOutput` / `outputStart` / `outputStop` / `input` / `resize` / `close`）、検査（session 名、base64、cols/rows 1〜1000）、`scrub`、`clipBody`
- `src/attachment.ts`: `sniffType`、`checkSize`（20MB）、`loadBytes`、`upload`、`createAttachments().attachBytes`（保存後に ` <path> ` を input へ）
- `test/terminal.test.ts`: 37 件。Rust test（terminal.rs / attachment.rs）の入力と期待値を写し、出典を名前に書いた。center は 127.0.0.1 の偽 HTTP server
- 接続先と token は注入された `getTarget`（= `createCenterSettings().selectTarget`）の結果だけを使う。url / token を組み直さない

## 共通 file に足した物

- `packages/center-client/src/index.ts`: export の追記のみ（末尾 2 ブロック）。既存の行は変えていない
- `package.json`、`bun.lock`、policy の型（`allowTool`）: 変更なし。新しい依存: なし

## test 結果

- center-client: 92 件 pass / 0 fail（55 → 92）、typecheck 通過
- web 38 pass、protocol 43 pass、server 349 pass
- center: 617 件中 616 pass、1 fail（`rc が孤児で残り…` = 既知の不安定 rc-orphan）。http 413・添付は今回 pass

## 設計書・Rust との差と理由

- URL の userinfo: Rust は URL をそのまま reqwest に渡す。fetch は userinfo 付き URL を拒否するので、`origin` から組み立てて userinfo を落とす（token は Bearer header）。error 文・log・status の message は `redactUrl` と `scrub`（token と `//user:pass@` を除く）を通す
- 検査の前倒し: Rust の input / resize は検査せず center の 400 に任せる。TS は session 名・base64・cols/rows を送る前に検査（center と同じ規則。設計書 5.1「検査の二重化」）。文言は center の 400 と同じ
- 添付の source: Rust の file path / file dialog は desktop 専用（fs を持たない方針）なので写していない。bytes（クリップボード・upload）のみ。Rust の `load_reads_a_file_*` と `b64` の test は写していない（b64 は Buffer）
- `after` は Rust と同じく `Last-Event-ID` header で送る（`?after=` は 4b の route が受けて `after` に渡す）
- 出力 stream は `openOutput`（購読ごと、web backend の接続ごと）を足した。Rust の `session_output_start` 相当の `outputStart` は session 名で置換
- 実 center に対する確認（10.2 の確認方法）は未実施。偽 server の test のみ（4a の依頼どおり）
