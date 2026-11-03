# session と remote-cap を 1 対 1 にする（feature/cap-per-session）

## 仕様

- 利用者の決定: 1 server に cap 1 つを全 session で共有すると、他 session の cap とその指示・結果が見え、指示も混ざる。session（master-cap）と remote-cap を 1 対 1 にする。「作業ごとに cap を作らない」は維持。
- cap は session × server に 1 つ。cap_id = `c-<center-id>-<session 名>`（例 `c-0a1b2c3d4e-main`）。
- `remote_send` は呼び出し元 session（`X-Bantou-Session`）の cap へ送り、無ければ作る（cap は server が最初の `task` で作る）。
- `remote_list` / `remote_wait` / `remote_delete` / `worker_reply` は呼び出し元 session の cap だけが対象。他 session の cap は `remote_id` を指定しても「未定義の remote」。`remote_id` 省略は自分の cap（server が複数なら `server` で絞る。別 session の cap が複数ある外向け呼び出しは `remote_id` の指定を促す error）。
- 通知（完了通知・`worker_report` の push）は cap の session にだけ送る。`worker_report` は未完了の指示が無くても cap の session へ送る。
- 記録（`remotes.json`）は cap_id をキーに `session` を持つ。session 無しの記録 = 旧共有 cap。
- 旧共有 cap の引き継ぎ: 既存の `c-<center-id>`（と旧形式）は session 無しの記録として残す。新しい指示は送らない。session 向け `remote_list` は `include_shared: true` で出す（外向け `remote_list` は全件）。`remote_delete` / `remote_wait` / `worker_reply` は `remote_id` を明示した時だけ旧共有 cap を対象にできる（例 `remote_delete({remote_id: "c-<center-id>"})`）。省略では選ばれない。旧形式が同じ server に複数ある時の整理（動いている記録を残し他へ `stop_cap`）は旧共有 cap の間だけ。session の記録には触れない。引き継ぎ前の未完了の指示の完了通知は、その owner へ届く。
- desktop: remotes 欄は選択中 session の cap（`r.session === owner`、server ごとに 1 行）だけ。中央の center ダイアログは全件を session 名付きで出す（旧共有 cap は「共有（旧）」）。ask への返信は `remote_id` + `server` を渡す。
- server: 変更なし。`cap_id` は `AGENT_ID_PATTERN` の検証だけで使われる（path `<workspace>/caps/<cap_id>`）。cap が増えるだけ。

## cap_id の変換規則

- session 名は `[A-Za-z0-9_-]+`（`SESSION_NAME` / `OWNER_PATTERN`）で、cap_id の `AGENT_ID_PATTERN` と同じ文字種。**変換は恒等でエスケープ無し**（`sessionCapId`、center-id.ts）。
- 文字種外の名前、64 文字を超える名前（`MAX_SESSION_NAME`）は error（別の名前に寄せない・短縮しない）。上限の理由: cap_id は server の `caps/<cap_id>` の dir 名（Linux 255 byte）。server の検証に長さ上限は無いので center で絞る。cap_id は最大 77 文字。
- 衝突しない根拠: center-id は `loadCapId` が 10 桁 hex に検証する固定長（`-` を含まない）。接頭辞 `c-<hex>-` は常に 13 文字なので、session 名に `-` があっても `(center-id, session)` と cap_id は 1 対 1（`c-ab` の session `c` と center-id `ab-c` の共有 cap のような衝突は、center-id が固定長 hex なので起きない）。cap_id は session 名で一意。旧共有 cap `c-<10 桁 hex>` は接尾辞が無く、どの session の cap_id とも違う。
- 大文字小文字を区別しない FS の server では `Main` と `main` が同じ dir になりうる（Linux の server は別。未対応・server の FS は center から分からない）。
- 将来 session 名の文字種を広げる時: 許可外の文字を `_` + 2 桁 hex（UTF-8 のバイトごと）、`_` 自体を `_5F` に変える（今は使わない。`_` を含む今の名前を変えないため）。

## 変更ファイル

- center: `src/center-id.ts`（`sessionCapId`）、`src/remotes.ts`、`src/tools.ts`
- center テスト: `test/remotes.test.ts`（共有 cap 前提の 23 件を session ごとの cap に書き換え）、`test/tools.test.ts`、`test/cap-per-session.test.ts`（新規 17 件）
- desktop: `src/components/RemoteActivity.vue`、`src/types/index.ts`、`e2e/center.spec.ts`、`e2e/terminal.spec.ts`
- server テスト: `packages/server/test/server/utils/bantou/agents.test.ts`（1 件追加）
- docs: `docs/design/center-tools.md`、`docs/architecture.md`、`docs/protocol.md`、`packages/center/README.md`、`docs/design/master-cap-session.md`、この report

## テスト

- center: `bun run test` 392 件 pass（変更前 375 件）、`bun run typecheck` OK
  - 新規 `cap-per-session.test.ts` 17 件: 組ごとの cap_id が衝突しない・64 文字上限、cap_id の変換と衝突しなさ、拒否、session ごとの send、他 session から見えない・触れない（list / wait / delete / workerReply）、通知先、旧共有 cap の引き継ぎ・delete・他 session の cap は消せない、status 追従で他 session の worker を数えない、remote_id 省略の error
- server: `npm test` 233 件 pass、typecheck OK（実装の変更なし。`agents.test.ts` に「77 文字・大文字・- _ の cap_id で作成・status・reapOrphans」1 件追加）
- desktop e2e: `terminal.spec.ts` + `center.spec.ts` 23 件 pass（`bun run generate` の静的ビルド + 簡易静的サーバー + ms-playwright chromium）。session を切り替えると remotes 欄が変わる（careery: 2 行（server ごと）、stroke-board: 1 行、cap 無しの session: 「remote なし」、旧共有 cap は出ない）
- cargo test: 259 件 pass（`bun run build:sidecar` 後）

## review の指摘と対応

別の reviewer による diff 読み取りレビュー。

1. status 追従（`probe`）が worker を server 全体で見るため、他 session の worker が running だと自分の cap が running のまま残る（重要度 中）→ 対応: `statusBusy` を、その cap の activity があればそこに載る worker だけで見る。activity がまだ無い間（center 再起動直後）は従来どおり server 全体（完了判定が遅れることはあっても早まらない）。テスト追加。
2. README・architecture・master-cap-session の一部が旧仕様のまま → 対応: 該当文を session ごとの記述に直した。
3. 外向け呼び出しで別 session の cap が複数ある時の error 文が「server で指定」になる → 対応: remote_id での指定を促す文にした。テスト追加。
4. `remote_wait` の remote_id 省略では旧共有 cap の未完了の指示を待てない → 対応しない（設計どおり。旧共有 cap は `remote_id` を明示する。完了通知は届く）。

## 残存物・未解決

- worker の `AgentStatus` に cap_id が無いため、center 再起動直後で activity が無い間の status 追従は server 全体の worker を見る（完了判定が遅れる側にだけ倒れる）。恒久対応は protocol の status に worker の cap_id を足す（server 変更）。未着手。
- 旧共有 cap は利用者が `remote_delete` で消すまで残る（server 側の cap も残る）。
- 一時物: 作業 dir 内 `tmp/`（静的サーバー・playwright config）は最後に削除。clone 内の `.output` / `node_modules` / sidecar binary は未追跡（commit しない）。
- `feature/session-path-picker`（center_info tool 追加）は develop に未マージ。取り込み後に center の外向け tool 件数テスト（`外向けの tool は 16 個`）が衝突しうる。
