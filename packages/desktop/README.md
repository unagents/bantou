# bantou

Multi-agent task bridge. bantou sits between the user and the Claude Code work
sessions: work sessions send questions over agent-messenger, bantou shows them
as waiting icons on a Cork-format task board, and a bantou responder (Claude
Code, started only while the thread is open) helps the user answer and relays
the answer back.

Architecture follows careery: Tauri 2 (Rust) + Nuxt 4 SPA (Nuxt UI +
Tailwind CSS 4). The Rust app shell is derived from careery / [Cork](https://github.com/koki-develop/Cork)
(MIT, see `LICENSE-Cork`).

- Workspace = folder (Cork workspace selection). Flat `*.md`, one task per file,
  file name = title, frontmatter `status` / `order` / `tags` / `date` + `id`.
- Session = tag value. In-progress tasks are listed right under the session,
  queued (first status) below them, done (last status) folded.
- Message format and storage: [`../../docs/protocol.md`](../../docs/protocol.md).

## インストール（macOS）

Homebrew cask で配る。正本は `packages/desktop/Casks/bantou.rb`。tap の実体は別リポ `unagents/homebrew-tap`。

```sh
brew tap unagents/tap
brew install --cask bantou
```

更新は `brew update && brew upgrade --cask bantou`。リリース時の cask 更新は
`scripts/publish-cask.sh <version> <sha256>`。GitHub の tap リポ `unagents/homebrew-tap` の `Casks/bantou.rb` を API 更新する。

## アップデート

アプリ自身が更新する（`tauri-plugin-updater`、Cork と同じ仕組み）。cask には `auto_updates true` を付けてあるので、brew からの upgrade は不要。

- 起動時に `main` ウィンドウだけが自動チェックする（更新が無い・失敗した時は何も出さない）。アプリメニューの「アップデートを確認...」は手動チェックで、最新なら「bantou は最新です」と出す。
- 更新の操作はヘッダーの更新ボタン（cmux 方式）。通常は「アップデートを確認」で、押すと手動チェックする（最新なら「最新」が約2秒出て戻る）。更新があると「アップデートして再起動（v<ver>）」に変わり、押すとダウンロード（進捗表示）、インストール、再起動まで進む。失敗時は理由が出て、押すと再チェックする。
- 確認先は `https://github.com/unagents/bantou/releases/latest/download/latest.json`。`src-tauri/tauri.conf.json` の `plugins.updater`（endpoints / pubkey）と `bundle.createUpdaterArtifacts: true` で設定。権限は `capabilities/default.json` の `updater:default` / `process:default`。
- 更新物は署名必須。ビルド時に Mac の `~/.tauri/bantou-updater.key`（パスワード無し）を `TAURI_SIGNING_PRIVATE_KEY` で渡し、`bantou.app.tar.gz` と `.sig` を作る。`scripts/make-latest-json.sh <version> <sig-file>` で `latest.json`（`darwin-aarch64`）を作り、release に `.app.tar.gz` / `.sig` / `latest.json` を添付する。手順は `CLAUDE.md` の Release。
- e2e は updater の command をモックしている（seed の `update` に version を入れると「更新あり」になる。`e2e/updater.spec.ts`）。

## ローカルネットワーク許可が更新で外れる時（macOS）

- 症状: 更新直後から、bantou.app 配下のプロセス（center・session の messenger MCP）だけ LAN（192.168.x.x）宛ての TCP が `EHOSTUNREACH`（No route to host）。internet・127.0.0.1・Terminal の `curl` / `ping` は通る。header の messenger 表示にカーソルを載せると「ローカルネットワークの許可を確認」と出る。
- 直し方: System 設定 > プライバシーとセキュリティ > ローカルネットワーク で bantou を OFF→ON し、bantou.app を再起動する。
- 原因: ad-hoc 署名（`signingIdentity: "-"`）は版ごとに code identity が変わり、許可が引き継がれない（Apple TN3179 / TN3127）。
- 根本対策: 自己署名の code signing 証明書で署名する。手順・根拠・未確認点は [`docs/ops/desktop-signing.md`](../../docs/ops/desktop-signing.md)。証明書が無い環境は今までどおり ad-hoc で build できる。

## Dev

```sh
bun install
bun run build:sidecar   # tauri dev / build の前に必須（下記）
bun run tauri dev -- -- "$PWD/fixtures/demo-ws"
```

`fixtures/demo-ws` has three sessions of Cork tasks (waiting threads live in
`~/.local/share/bantou/`, so the UI flows are covered by the e2e seed).

The broker is found with agent-messenger's discovery order (env
`AGENT_MESSENGER_HOST` → `~/.agent-messenger/config.json` → UDP probe →
`127.0.0.1:7901`); bantou keeps no connection setting of its own. In dev, point
`AGENT_MESSENGER_HOST` at a test broker so the dev build does not register a
second `bantou-core` on the shared broker.

## ログ

調査用のログを `tauri-plugin-log` でファイルに書く（Rust 側と webview 側は同じファイル）。

- 置き場所: OS のログ置き場の `bantou.log`。macOS は `~/Library/Logs/jp.grrow.bantou/bantou.log`。
- ローテーション: 5 MiB で切り替え、古い 5 世代を残す（`lib.rs` の `LOG_MAX_FILE_BYTES` / `LOG_KEEP_FILES`）。
- 記録するもの: center の MCP 呼び出し（tool 名・HTTP status、失敗時は応答本文）、ターミナル出力 stream の状態変化と拒否（status・応答本文）、入力とサイズ変更の失敗（status・応答本文・送った cols/rows。入力の中身は書かず長さだけ）、セッション一覧の取り直しの結果、アップデータの失敗、broker 接続、webview の失敗（`[webview]` 付き）。
- 自分の sidecar center のログは別: `~/.local/share/bantou/center-logs/center.log`（`packages/center/README.md` の「ログ」）。

## ペインの幅

左（セッション一覧）・中央（remote と task）・右（ターミナル）の境界 2 本をドラッグして幅を変える（`PaneResizer.vue`、`composables/usePaneWidths.ts`、新しい依存なし）。

- 仕切りは 6px の当たり判定に 1px の線。ホバー・フォーカス・ドラッグ中は accent 色の 3px になり、cursor は col-resize。ダブルクリック（または Enter）で既定に戻す。
- 最小幅: 一覧 160px / 中央 320px / ターミナル 320px。既定: 一覧 240px / 中央 420px（右は残り）。ウィンドウが 812px（最小幅の合計＋仕切り）より狭い時は幅を詰めず、ペイン行が横スクロールする。
- 操作: pointer events + `setPointerCapture`（ターミナル上・ウィンドウ外へ出ても追従）。ドラッグ中は選択を止め、cursor を固定する。仕切りは `role="separator"` / `aria-orientation="vertical"` / `aria-valuenow|min|max`。フォーカスして ←→ で 16px（Shift で 64px）、Home / End で最小 / 最大。
- 保存: webview の `localStorage` の `bantou.paneWidths` に `{"v":1,"side":240,"middle":420}`（px）。ドラッグ・キー操作の終了時に書く。読めない値は既定に戻す。狭いウィンドウでは表示だけ詰め、保存値は変えない（広げると戻る）。
- ターミナルは幅が変わると xterm の fit が走り、100ms まとめて 1 回 `session_resize` を center へ送る（ドラッグ中の連続 resize はこれで間引かれる）。e2e は `e2e/pane-resize.spec.ts`。

## 画像の添付（master-cap の session）

選択中の session のターミナル欄に、画像を 3 つの方法で渡せる。session の claude は center のホストで動くので、画像は center のホストに保存され、その絶対 path がターミナルの入力に入る（前後に空白 1 つ、Enter は送らない。複数枚は空白区切り）。Enter を押すと claude がその path の画像を読む。

- 貼り付け: クリップボードに画像がある時の Cmd+V / Ctrl+V。文字も一緒にある時は今まで通り文字を貼る。
- ドラッグ＆ドロップ: 画像ファイルをターミナル欄の上に落とす（欄の外に落としても何も起きない）。
- 添付ボタン: ターミナル欄の見出し右端のクリップ。ファイル選択ダイアログ（複数選べる）。キャンセルは何も起きない。
- 受ける型は png / jpeg / gif / webp、1 枚 20MB まで。型の違うもの・超えるものは、理由を見出しに赤字で出して何もしない（他の画像は進む）。送信中は見出しに「画像を送信中… N 枚」。
- 画像は webview から直接 center に送らず、Rust 側が center へ送る（ターミナル入力と同じ接続先・token）。保存先・route・手で消す方法は `packages/center/README.md` の「添付画像」。自動では消えない。
- ログ: 保存（path・bytes）・拒否・失敗は `bantou.log` に書く（画像の中身は書かない）。center 側は `center.log`。

## center（sidecar）

`packages/center` を `bun build --compile` した単体バイナリを sidecar（`bundle.externalBin`）として同梱し、アプリが起動・停止する。

- ビルド: `bun run build:sidecar`。出力は `src-tauri/binaries/bantou-center-<rust-triple>`（git 管理外）。`--target <rust-triple>` で指定、無ければ環境変数 `TAURI_ENV_TARGET_TRIPLE`、それも無ければ `rustc -vV` の host。`tauri build` は `beforeBuildCommand` で自動実行する。
- `bundle.externalBin` により、binary が無いと `cargo check` / `tauri dev` のビルドスクリプトも失敗する。先に `build:sidecar` を実行する。
- universal mac ビルドは `aarch64-apple-darwin` と `x86_64-apple-darwin` の両方を `--target` で作る。
- 設定: ヘッダーの歯車から開く設定ダイアログ。center の ON/OFF（「center を起動する」）で同じ場所の表示が入れ替わる。OFF の間は「別ホストの center に接続（貼り付け）」だけを出す（この PC は center を持たず、相手の接続設定を貼ると URL と token を取り出して保存し、sidecar ではなくこちらへ接続する）。ON の間はその欄を出さず、この PC の center の設定（port / 接続設定の IP（保存キー `bind`）/ token / 接続設定 / workspace / claudePath）だけを出す。両者は同時に出ない。保存値は表示を切り替えても消えず、ON に戻すと元の値が出る。項目は enabled / port（既定 7910）/ bind（接続設定の URL のホストにする IP。保存値が無い時の既定は、この PC の外側 IP（loopback 以外の IPv4 の先頭。LAN を優先）。外側 IP が 1 つも無い時だけ `127.0.0.1`）/ workspace（center が扱う作業ディレクトリ 1 つ。既定 `~/.bantou`。`~` 始まりまたは絶対パス。欄（`center-workspace`）は読み取り専用で、欄のクリックか横の「選択…」（`center-workspace-pick`）で OS のフォルダ選択ダイアログ（`pick_directory` = rfd）を開き、選んだ絶対パスを表示する（手書きはできない。保存済みの値はそのまま読める。sidecar はこの PC で動くので常にこの形。キャンセルは欄を変えない。共通部品 `PathField.vue`。クリック / Enter / Space で開く。ダイアログ自体が失敗した時（この OS で使えない等）は、その欄だけ値を保ったまま text 入力に切り替わり、エラーを出す）。無ければ起動時に作る。`center.json` には `workspace`（解決後の絶対パス）として渡し、`projects` は書かない（起動時に session は立てず、`session_create` で path を省いた時の置き場所 `<workspace>/<name>` としてだけ使われる）。旧 `projects` / `servers` の保存値は読み捨て、移行しない。`servers` は `center.json` に書かない）/ claudePath（任意・絶対パス。空なら center が login shell から自動解決し、`center.json` の `remoteControl.claude` には設定時のみ書く）/ token（center の Bearer token。初回に自動生成。コピー・再生成ボタンあり。12 文字以上）/ remote（別ホストの center。貼り付けた接続設定の URL と token）。center の待ち受けは常に全アドレス（`--bind 0.0.0.0`。LAN からも Tailscale からも届く。守りは token）で、bind の選択は待ち受けではなく、接続設定の URL のホストを決めるだけ。bind は自由入力ではなく、この PC の IP 一覧（全 NIC。IPv4 を先、127.0.0.1 を含む。IPv6 は後。link-local `fe80::` と `::1` は除く）から選ぶ 1 つの select で、選んだ IP が接続設定（`mcp.json` 形式と `claude mcp add --transport http ... --header 'Authorization: Bearer <token>'`、タブ切替・コピー可）の URL のホストになる（IPv6 は URL で `[addr]`）。`127.0.0.1` も一覧に残り、選べば使える。token を再生成するか IP を切り替えると接続設定の表示も変わる。保存済みの値は書き換えない（旧版の `0.0.0.0` / `::` / ホスト名や、今は無い IP も保存値のまま。旧 `connectHost` は読み捨て）。設定を開いた時に保存済みの IP を今のこの PC の IP 一覧と照合し、一覧に無ければ（または center が起動時に待ち受け（listen）できず、ログに `EADDRINUSE` / `EADDRNOTAVAIL` / `EACCES` が出ていれば）設定画面の上部に「保存の IP … は今このマシンに無い。今の候補: …」の状態を出して、「前と同じ IP のまま」か「新しい IP にする（候補から選ぶ。既定は外側 IP の先頭）」を選ばせる。選ぶまで勝手に切り替えない。新しい IP は保存で接続設定に反映する（待ち受けは変わらないので再起動はしない）。旧版の `remoteUrl` も読み捨てる（保存し直すと消える。貼り付けで入れ直す）。保存先は `settings.json`（tauri-plugin-store）の `center` キー。
- 保存すると `~/.local/share/bantou/center.json` を書き出し、起動中で enabled / port / workspace / claudePath / token のいずれかが変わった時だけ再起動する（remote のみの変更、bind（接続設定の IP）のみの変更は再起動しない。接続先は呼び出しごとに設定から決めるので、次の呼び出しから切り替わる）。enabled を外すと停止する。アプリ起動時に enabled なら自動起動。
- 停止は SIGTERM（center が自身の remote-control 子プロセスを止める。最大 15 秒待って SIGKILL）。Windows は graceful stop が無く center を強制終了するため、子プロセスが孤児として残る場合がある。
- 状態（stopped / running / error、pid、直近ログ）は設定ダイアログに表示する。

### center 状態画面と接続先

- ヘッダーのサーバーアイコンから開く。接続状態（接続先 URL と remote / sidecar の別、接続可否、直近エラー）、`rc_list`（project ごとの remote session の状態）、server 一覧（`server_peers` と `server_list` を 1 行 1 server に統合）を表示する。「更新」で再取得する。「server」節の先頭に、この desktop と組の版（server / protocol）を小さく出す。各行は host 名 → server_id（無ければ peer id）→ 同じ host 名が複数ある時だけ user / workspace → 版の状態 → server 版 → 接続状態（到達可 / 未接続 / 到達不可 / 不明）の順。cap / worker の行は出さない。join は `server_list[].server_id` = `server_peers[].server_id`（peer 側で一意な時）→ `server_list[].serverPeer` = `server_peers[].id` → 一意な name の順で行い、片方にしかいない server も行に出す。server_id は再登録（peer id 変更）後も変わらないので同じ server は 1 行にまとまる。制約: `server_list` に `server_id` が無い（center が識別を未学習、または旧 server）link は peer id / name で結合するため、再登録直後は分かれて出ることがあり、name 一致は peer 未発見の link が別 server の peer と一意な name で結合し得る。版の状態: 一致 / 更新中（待っている cap・worker の件数）/ 版違い（protocol の版が違う、または自動更新できない版）/ 更新失敗（理由付き）。版が違う server への更新は center が自動で指示するので、画面に操作は無い。組の server 版は `bun run build:sidecar` が `packages/server/package.json` から center に埋め込む。e2e は `e2e/mock/bantou.ts` の `centerVersions`。操作系（rc_start / cap_kick など）は無い。
- remotes（`RemoteActivity.vue`）は center 画面には出さず、session 画面の中央列に出す。`remote_list` を 3 秒ごとに取得し（前の取得が終わっていなければ飛ばす。画面を閉じると止まる）、remote ごとに cap と worker を 1 行ずつ、状態（動作中 / 停滞 / 待機 / 完了 / 失敗 / 消失）、作業内容（task）、直近の活動、最終出力からの経過時間で表示する。経過時間は `silent_ms` に取得からの経過を足した値で、ホスト間の時計ずれは使わない。center が `activity.stale` を立てた remote には「更新途絶」を付ける。`activity` が無い remote は「活動情報なし」と `state` だけを出す。e2e は `e2e/mock/bantou.ts` の `centerRemotes` に `remote_list` の JSON を入れる（`e2e/center.spec.ts`）。
- セッション一覧と追加: サイドメニューのセッション一覧は、つないでいる center（center が ON なら自分の center、OFF なら貼り付けた別ホストの center）の `session_list` そのもの（desktop 独自の「追加済み」一覧は持たない。他の desktop や MCP から作られたセッションも出る）。取れた最後の一覧だけメモリに持ち（Rust `session.rs::SessionCache`、ファイルには残さない）、center に問い合わせられない時はその一覧を「つながらない」表示付きで出す（一覧から消えたものの「ロスト」表示は無い。次に答えた一覧に無ければ消える）。取り直すきっかけ: 画面の操作の前（毎回）、OS のスリープ復帰と少し後（`bantou://os-wake`）、ネットワーク変化（`bantou://os-network-changed`、2 秒まとめ）、設定ダイアログを閉じた時、自分の sidecar を起動した時（`bantou://center-running`）、center の SSE イベント（`center-sessions-changed`。center_events.rs が `GET /events` の `sessions` を流し、`useSessionRefresh.ts` が受けて取り直す。reason は created / deleted / restored / updated / context / activity / changed）、5 分ごとの保険。起動直後（アプリ起動時・sidecar 起動時）の取り直しが失敗した時は、成功するまで 2 秒ごとに取り直す（上限 60 秒、その後は上の時機に任せる。`useSessionRefresh.ts`）。OS 通知は Rust の `os_events.rs`（macOS: `NSWorkspaceDidWakeNotification`、Windows: `PowerRegisterSuspendResumeNotification`、ネットワーク: `netwatcher`。Linux は復帰通知なし）。ヘッダーの「セッション追加」ボタン（フォルダ未選択でも出る）から開く `AddSessionDialog.vue` は新規作成だけ: 名前（英数字と `_` `-`。center の一覧にある名前と重複不可）を入れて `session_create` で作る（一覧から選んで追加する画面は無い）。「フォルダ」欄（`data-testid="add-folder"`）はその session 用に作るフォルダ（master-cap の claude の cwd。center の session の `path`）で、既定は空。空なら `session_create` に `path` を渡さず（Rust `create_args`）、center が `<workspace>/<名前>` に作る。プレースホルダは center の `workspace`（Rust `session_path_hints` が center の tool `center_info` から取る。取れない・旧 center は「空ならセンターが決める」の汎用文）に名前の入力を追従させて出す。入力は絶対パスで、無ければ center が作る（フォルダ選択ダイアログが使える時は欄が読み取り専用になり、欄のクリックか「選択…」で選ぶ。取り消しは欄を変えない。使えない時は従来どおりの text 入力）。center の error（相対パス・別 session と同じ path・作れない）はダイアログにそのまま出す。フォルダ選択ダイアログ（欄のクリックと、ボタン `add-folder-pick`。既存の `pick_directory` = rfd。`session_path_hints.canPick` が true の時）は、自分の sidecar center かつ macOS / Windows の時だけ使う（別ホストの center では path は center のホスト上のものなので、ダイアログも出さず手入力の text 欄のまま。欄の説明に「この PC のパスではない」と出す）。歯車のプロジェクト設定ダイアログ（`ProjectSettingsDialog.vue`）では名前とフォルダも変えられる。同じダイアログの「再起動」（`settings-restart`。変更があれば「保存して再起動」）は、変更を center に保存してから `rc_stop` → `rc_start { resume: true }` で session を会話を保ったまま再起動する（追加指示・参照フォルダ・出力スタイルは次の起動から効くため）。名前・フォルダの変更は center 側で再起動されるので、その時は重ねて止めない。e2e は `e2e/session-instructions.spec.ts` の「restart from the gear」。「名前」欄（`settings-name`。追加ダイアログと同じ検証: 英数字と `_` `-`、一覧の他の名前と重複不可）と「フォルダ」欄（`settings-path`。値は `session_list` の `path`。center のホスト上の絶対パス。自分の sidecar center かつ macOS / Windows の時（`canPick`）は欄が読み取り専用で、欄のクリックか「選択…」`settings-path-pick` でダイアログから選ぶ。それ以外は text 入力）を編集でき、フォルダを変えた時だけ「今のフォルダを新しい場所へ移動する」チェック（`settings-path-move`、既定 ON）が出る。ON は center が今のフォルダを新しい path へ移動、OFF は新しい path を作るだけ（中身は移らない）。保存の順は、設定（追加指示・参照フォルダ）に変更があれば `session_update_settings`（旧名）→ 名前かフォルダが変わっていれば center の `session_update`（Rust `session_update`。`{ name, newName?, path?, move? }`、`move` は path と一緒の時だけ送る）→ 成功したら一覧を取り直し、選択中の名前を新しい名前に付け替える。失敗（重複名・path の衝突・移動できない等）は center のメッセージをダイアログに出して閉じない。保存ボタンは何かが変わった時だけ有効。保存すると center は session をすぐ再起動する（新しい名前・フォルダで起動し直す。フォルダ欄の help に出す）。フォルダを変えると以前の会話は引き継がれず新しい会話で始まる（移動チェックの有無に関わらず）。名前だけの変更なら会話は続く。この会話の注意はフォルダ欄の下（`settings-path-note`。フォルダが変わっている間だけ）と移動チェックの説明に出す。歯車は行の選択を変えない: 改名した session が選択中だった時だけ選択を新しい名前へ付け替え、選択中でない session の改名・フォルダだけの変更では選択は動かない（保存後は一覧を取り直す）。e2e は `e2e/session-rename.spec.ts`。作った後は一覧を取り直す。ボタンは center が OFF で保存済み `remote` も無い時だけ無効になり、理由を横に出す。プロジェクト（session）の設定は center が session の記録として持つ（`settings`。今は `instructions`＝`--append-system-prompt` に渡す追加指示、16000 文字以内、空は無し。desktop の `settings.json` には持たない。別ホストの desktop からも同じ値が見える）。desktop は center の tool で読み書きする: Rust `session_get_settings`（center の `session_settings_get`）、`session_update_settings`（`session_settings_update`。書いた項目だけ変わり、`null` で項目を削除、空の追加指示は `null` にして送る。center が知らせる未知の項目はそのまま保持される）、`create_session` の `settings`（`session_create` の body の `settings`。載せる項目が無ければ載せない）。入口は 2 つ: 左サイドバーの各 session 行の歯車（`data-testid="session-settings-open"`。行の選択は変えない。center の config 由来の project は center が更新を拒否するので無効）から開く `ProjectSettingsDialog.vue`（保存で `session_settings_update`）と、セッション追加ダイアログの同じ欄。欄は項目ごとの節で `ProjectSettingsFields.vue` にあり、今は「追加指示」の複数行欄と「参照フォルダ」（`addDirs`。master-cap が自分のフォルダ以外に読み書きしてよいフォルダで、center が起動のたびに 1 つずつ `claude --add-dir <path>` で渡す。1 行 1 つの絶対パス（center のホスト上）、20 個以内。自分の sidecar center かつ macOS / Windows の時（`canPick`）は、行が読み取り専用で（`<prefix>-add-dir`。クリックか行の「選択…」`<prefix>-add-dir-row-pick` でダイアログから変更。取り消しは変えない）、「フォルダを追加…」（`<prefix>-add-dir-add`）が空行を作らずダイアログを開いて選んだフォルダを 1 行追加する（取り消しは何も足さない。ダイアログ自体が失敗した時は、その欄だけ「パスを入力して追加」に切り替わりエラーを出す）。「出力スタイル」（`<prefix>-output-style`、節は `<prefix>-section-output-style`、32000 文字以内）は claude の output style の markdown 本文（`~/.claude/output-styles/*.md` の中身を貼る。先頭の frontmatter は `name` だけ center が差し替え、`keep-coding-instructions` 等は残る）で、center が起動のたびに session のフォルダの `.claude/output-styles/bantou.md` に書き `--settings {"outputStyle":"bantou"}` で選ぶ。session に値があれば共通の値は使わない（連結しない）。空なら claude の既定。e2e は `e2e/session-instructions.spec.ts` の「output style」。それ以外は「パスを入力して追加」（同じ `<prefix>-add-dir-add`）で空行を足して手入力する。× で外す。保存時に空行と重複は落とし、相対パスは保存を止める。全部外すと `null` を送って center が項目を消す。`session_create` には設定のある項目だけ載せる）。将来の skill / output style は節と `composables/sessionInstructions.ts` の `SettingsDraft` に足す形（今は実装しない）。どちらも欄の下に「保存後に起動する session から効く。動いている session には効かない」と注意を出す。desktop に session の再起動の操作は無い。再起動・`--continue` は center が記録済みの値で付ける。設定ダイアログ（ヘッダーの歯車）には「全 session 共通の設定」の節（`center-common-section`。同じ `ProjectSettingsFields.vue` を接頭辞 `center-common` で出すので、欄は `center-common-instructions` と `center-common-add-dir`。保存ボタンは持たず、ダイアログ下の「保存」`settings-save` 1 つで center の設定と一緒に保存する）があり、つないでいる center（ON なら自分の sidecar、OFF なら貼り付けた別ホストの center）の tool `center_settings_get` / `center_settings_update` で読み書きする（この PC の `settings.json` には持たない。center 側は `center-settings.json`）。共通の追加指示は全 session の `--append-system-prompt` の先頭に付き、各 session の追加指示は空行を挟んでその後ろ。共通の参照フォルダは全 session の `--add-dir` に付き（共通が先）、各 session のものはその後ろ（重複は除く）。フォルダ選択ダイアログ形式は「center を起動する」が ON の時だけ（OFF = 別ホストの center では、フォルダは相手のホスト上なので手入力の text のまま）。16000 文字以内、空は削除（`null`）。center に問い合わせられない時は欄を無効にして理由を出す。保存は「保存」1 つ（`settings-save`）で、変わった区分だけ API を呼ぶ（共通だけ変更なら `center_settings_update` のみ、center の設定だけなら `center_set_settings` のみ、両方なら 1 回ずつ。変更が何も無ければ無効）。順は共通 → center の設定（center の設定の保存で sidecar の再起動や接続先の切替が起きうるため、共通は読み込んだ center へ先に保存する）。共通の保存が失敗したら center の設定は保存せず、共通の欄にエラー（`center-common-error`）と下部に「共通の設定の保存に失敗した（center の設定は保存していない）」（`settings-error`）を出して閉じない。共通が成功して center の設定が失敗したら、共通は巻き戻さず（保存済み。再保存は center の設定だけ呼ぶ）「center の設定の保存に失敗した（共通の設定は保存済み）」を出して閉じない。全部成功した時だけ閉じる。共通の設定は session の再起動を起こさない（注意書きの通り、保存後に起動する session から効く）。center の設定の保存は sidecar の起動・停止・再起動を伴いうる。center の `instructions`（起動時に追加指示を付けたか）が true の session は、サイドメニューの行と選択中セッションの見出しに小さな印（巻物アイコン、tooltip「追加指示つきで起動した」。`data-testid="session-instructions-mark"`、e2e は `e2e/session-instructions.spec.ts`）を出す。各セッションの作業状態（center の `activity` / `activityAt`。center が hooks で取る）は、サイドメニューの行に印（`SessionActivityMark.vue`、`data-testid="session-activity"`、`data-activity="working|needs-input|idle"`）で出す。印は icon だけで文字は出さない（label は印の `title`（tooltip）と `aria-label` にだけ「作業中: …」の形で持つ）: 作業中（info 色の回る `loader-circle`）/ 判断待ち（warning 色の `message-circle-question`）/ 待機（success 色の `circle-check`）/ remote 作業中（info 色の回る `server-cog`）。`unknown`・null、center に問い合わせられない時、state が connected でない session（停止・起動中・error）は印を出さない。thread の ask（status `waiting`）は center が持たないので、その session のタスクに waiting の thread があれば center の activity に関わらず「判断待ち」にする（`useBoard.ts`。remote に預けた作業も反映する（center の `session_list[].remote = { running, waitingReply }`。旧 center は無し）。優先順位は thread の waiting／claude の needs-input → remote の `waitingReply` > 0（「判断待ち」。center が数える未返答で、返答済み・同じ worker の後続 report（done 等）で解消済みのものは含まれない。印の tooltip に「worker の質問に未返答 N 件」）→ claude の working → remote の `running` > 0（「remote 作業中」。`data-activity="remote-working"`、回る `i-lucide-server-cog`）→ idle。claude の状態と remote running は connected の session だけ、未返答の worker の質問は thread の ask と同じく state に関わらず出す（人の返事を待っているので）。上部の集計・絞り込みでは「remote 作業中」は「作業中」に数える（chip は増えない）。center は変化時に `GET /events` へ `reason: "remote"` を流し、他の reason と同じ `center-sessions-changed` → `session_list` の取り直しになる（新しい polling は無い）。この場合は state に関わらず出す）。サイドメニュー上部の集計（`session-activity-summary`、各 `-working` / `-needs-input` / `-idle`、`data-count`）は icon + 件数だけで文字は出さず（label は chip の `title` と `aria-label`「作業中 N」）、session 数で、判断待ちが 1 以上の chip は warning 色・太字で強調し、押すとその状態の session に絞り込み、もう一度押すか該当 session が無くなると解除（メモリのみ）。center の hook は Esc 中断・permission 拒否で発火するものが公式 docs に見当たらず（未確認）、判断待ち・作業中の表示が実際より長く残りうる。ヘッダーの「返答待ち N」は thread の件数で別物（session 数ではない）。更新は既存の取り直し経路に載せていて、center の `GET /events` の `reason: "activity"` は他の reason と同じく `center-sessions-changed` → `session_list` の取り直しになる（reason で絞っていないので、新しい polling は無い）。e2e は `e2e/session-activity.spec.ts`。各セッションのコンテキスト使用量（center の `contextUsage`）は、サイドメニューの行には「42%」だけ（窓が不明で % が出せない時・無い時は何も出さない。token 数は tooltip）、選択中セッションの見出しには「ctx 42% 84k/200k」の形で出す（どちらも 80% 以上は警告色、見出しは窓が不明なら「ctx 84k」、無ければ非表示。サイドメニューの行に Cork 時代の「0 / 0」は出さない。`ContextUsage.vue`、e2e は `e2e/context-usage.spec.ts`）。e2e は `e2e/session-add.spec.ts` と `e2e/session-path.spec.ts`（フォルダ欄。mock は `e2e/mock/bantou.ts` の `centerSessions` / `centerReachable` / `centerDrop` / `osWake` / `osNetworkChanged`）。
- 再ログイン: center が session の pty から `Please run /login`（OAuth token 切れ）や `Couldn't save your login`（ホストの keychain ロック）を読むと、`session_list` の `auth` が `login_required` / `keychain_locked` になり（center の `GET /events` `reason: "changed"` で即時に取り直す）、サイドメニューの行に鍵アイコン、ターミナルのヘッダーに「要再ログイン」/「keychain ロック中」ボタンが出る。押すと `LoginDialog.vue`: 「ログイン URL を取得」（`session_login`）→ URL を表示・コピー → ブラウザで認証して得たコードを貼って「送信」（`session_login_code`）。結果は成功 / `Invalid code`（貼り直し）/ `Couldn't save your login`（ホストの keychain を解錠してから取り直し）。「再起動」は `rc_stop` → `rc_start { resume: true }`（別 session で既にログインし直した時用）。URL はダイアログの「開く」で desktop 側（この Mac）のブラウザで開く（tauri-plugin-shell の `open`、capability `shell:allow-open`、http(s) のみ）。center の host では開かない（claude が host で開こうとしても無視してよい）。center が別 host でも、認証とコードの入力は手元の Mac で完結する。「コピー」も使える。e2e は `e2e/login.spec.ts`（mock は `centerAuth` / `centerLoginUrl` / `centerLoginCodeResult` / `loginCalls`、「開く」は `plugin:shell|open` の呼び出しを `calls` で検証）。実際の `/login`（claude との往復）は実機でだけ確かめられる。
- 接続先は center が ON なら自分の sidecar（`http://127.0.0.1:<port>/mcp`。center は全アドレスで待ち受けるので常に loopback で接続し、選んだ IP には依存しない）で、保存済み `remote` は使わない（値は消さない）。OFF なら保存済み `remote`。どちらにも Bearer token を付ける（sidecar は自分の token、remote は貼り付けた接続設定の token。token が無い remote は 401 になり「token が必要」と表示する）。どちらも無ければ「接続先が無い」を表示する。
- desktop の Rust 側が center の MCP（Streamable HTTP）に接続する。webview は直接 fetch せず Tauri command `center_call`（tool 名と引数で呼ぶ。結果は MCP の tool result そのまま、`isError` は Err）と `center_connection`（接続先・接続可否・直近エラー）を使う。center の再起動などで session が切れても次の呼び出しで張り直す。
- 注意: reqwest は TLS 無し（`https://` の remote は接続できない。center 側も TLS 無しで、token は平文で流れる）。center は全アドレス（`0.0.0.0`）で待ち受け、loopback 以外の bind では Host 検査をせず Bearer だけで守る。別ホストの desktop から使うには、接続設定の IP が外側 IP（既定）であること。
