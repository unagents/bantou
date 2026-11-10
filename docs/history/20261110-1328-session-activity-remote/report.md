# session-activity-remote: report

問題: master-cap のように仕事を remote-cap に預けて待つ session が、worker が作業中でも「待機」と出る。worker の ask / approve に未返答でも「判断待ち」にならない。center の詳細は `center-notes.md`。

## 設計
- center が `session_list[].remote = { running, waitingReply }` を返す（running = pending がある server の数、waitingReply = 動いている cap の未返答 ask/approve 数）。変化時だけ `GET /events` に `reason: "remote"`。
- desktop の優先順位（`useBoard.ts`）: thread の waiting／claude の needs-input → remote の waitingReply > 0（判断待ち）→ claude の working → remote の running > 0（remote 作業中）→ idle。claude が unknown/idle でも remote の事実は出す。
- 表示条件（判断）: claude の状態と remote running は **connected の session だけ**。停止・起動中・error の session に残った pending でスピナーが回り続けるのを避け、既存の「停止・error は今の表示のまま」に合わせるため。一方 **未返答の worker の質問は state に関わらず出す**: 人の返事を待つ事実で、thread の ask の合成（state 非依存）と同じ扱い。center に問い合わせられない時はどちらも出さない。
- 印: `data-testid="session-activity"`、`data-activity="remote-working"`（label「remote 作業中」、回る `i-lucide-server-cog`、色は作業中と同じ info）。判断待ちの tooltip は「…（worker の質問に未返答 N 件）」。
- 集計・絞り込み: 「remote 作業中」は「作業中」に数える（chip は増やさない。`session-activity-summary-working` の `data-count` に含む）。「作業中」の絞り込みは remote-working の行も残す。
- 更新契機: 既存の `center-sessions-changed` 経路。reason は列挙して絞っていないので "remote" もそのまま `session_list` の取り直しになる（`center_events.rs` は reason を素通し、`useSessionRefresh.ts` も絞らない）。新しい polling は無し。

## 変更点（packages/desktop）
- `src-tauri/src/session.rs`: `Session.remote: Option<SessionRemote { running, waiting_reply }>`（serde default。旧 center は None）+ unit test。
- `src/types/index.ts`: `Session.remote`、`SessionActivity` に `remote-working`。
- `src/composables/useBoard.ts`: 合成、`SessionGroup.remoteWaiting`、集計（remote-working→working）。
- `src/components/SessionActivityMark.vue`、`src/pages/index.vue`（絞り込み、waiting-reply の受け渡し）。
- `e2e/mock/bantou.ts`（remote の mock）、`e2e/session-activity.spec.ts`（4 ケース追加）。
- `README.md`（desktop）。触っていない: CenterDialog.vue、e2e/center.spec.ts、useUpdater.ts、packages/server。

## テスト
- desktop `nuxt typecheck`: error 0。
- e2e（session-activity 9 + board 8 + context-usage 4）: 実行 21 件。初回の同時実行（typecheck と並走）で board の先頭 1 件が cold start の timeout で落ち、board 単独で再実行して 8/8 通過。session-activity は 9/9 通過（追加: remote running が idle の claude で「remote 作業中」・集計は作業中に数え chip は 3 つのまま・絞り込み、waitingReply で判断待ち＋tooltip と集計、優先順位と connected 外の扱いと旧 center、SSE reason "remote" で session_list が取り直される事＝クリック無しでイベントのみ）。
- center: typecheck error 0、test 491/491（protocol を先に build）。
- bun が無いので npx / esbuild shim で代替。
- `cargo test`: cargo が無く **未実施**（追加した `remote_is_read_when_the_center_sends_it_and_none_otherwise` は未実行）。

## 画面
`sidebar-remote.png`: 作業中（回る icon）、待機、remote 作業中（server-cog が回る）、判断待ち（黄・太字）が並ぶ左サイドバー。

## 残課題・未確認
- 実 server・実 center 常駐・実 Tauri アプリとの結合は未確認（mock の e2e のみ）。
- center 側の限界を引き継ぐ: worker_reports 20 件上限で古い未返答 ask は数えなくなる、返答せず worker が進んだ場合は未返答のまま残る。
- 前 task から継続: 拒否・Esc 中断で needs-input/working が残りうる（hook に出口が無い。実機未確認）、対話モードの needs-input 未確認。
- 停止中 session の未返答の質問を「判断待ち」に出す判断は、実運用で古い記録が残った場合に誤表示になりうる（center が停止時に止まった cap の未返答を数えない前提）。
