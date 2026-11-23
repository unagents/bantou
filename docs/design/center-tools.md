# center の tool 仕様（実装済み、2026-10-29）

ドラフトを実装に落とした版。前提は `docs/concept.md`。各項目に「概念」（ユーザー確定の原則）か「今は」（いずれ変わり得る実装）を付ける。

## 前提（概念）

- ユーザーは番頭（bantou）と話し、番頭が全部を切り盛りする。PM（master-cap）を用意するのも番頭。
- master-cap は「考えて指示を出す」だけの中継役。実体（起動手段・場所・path）は本質ではない。
- center は master-cap に必要な道具を持たせてよい。agent-messenger の通信部分は center が持ち、master-cap ごとに messenger の MCP を抱えさせない。
- どの server で作業するか、worker を何本使うかは、ユーザーからはできるだけ見えなくする（master-cap に見えるのは構わない）。

## A. center 上の session（番頭が使う）

| tool | 引数 | 返り値 | 動作 |
|---|---|---|---|
| `session_create` | `name`（英数 `_-`）、`path?`、`permissionMode?`（既定 `auto`）、`settings?`（プロジェクト設定 `{ instructions?: string, … }`） | `{name, path, state, pid, sessionUrl, startedAt, source, lastError?}` | `claude remote-control --name <name>` を path で起動し、監視対象に加える |
| `session_delete` | `name` | `{name, deleted}` | remote-control を停止し、監視と保存から外す。path は消さない |
| `session_update` | `name`、`newName?`、`path?`（絶対パス）、`move?`（`path` 指定時のみ。true で今のフォルダを新しい `path` へ rename で移動、省略・false は新しい `path` を作るだけ） | `SessionInfo`（`session_create` と同じ） | session_create で作ったものの名前と path を変える。停止 → フォルダの移動 / 作成 → 記録の更新 → 新しい名前で resume 起動（path を変えると `--continue` が効かず素の起動）。settings は引き継ぎ、remote の記録は新しい名前へ付け替え（cap_id は変わらない）。別の session の remote 記録と衝突する名前は拒否。失敗時は元に戻す |
| `session_settings_get` | `name` | `{name, settings}` | session のプロジェクト設定を返す（未設定・config 由来は `settings: {}`） |
| `session_settings_update` | `name`、`settings`（項目ごとにマージ。`null` で項目を削除） | `{name, settings}` | プロジェクト設定を更新して `sessions.json` に保存。次の起動から効く。config 由来の project は拒否 |
| `session_list` | なし | 同上の配列（`auth`, `loginUrl`, `loginError` 付き） | config の project と session の全部（`source` で区別） |
| `session_login` | `name` | `{name, loginUrl}` | session の claude に `/login` を打ち、認証 URL が出るまで待つ |
| `session_login_code` | `name`、`code` | `{name, ok, auth, error}` | 認証コードを投入し、`Login successful` / `Invalid code` / `Couldn't save your login` を待つ |
| `center_info` | なし | `{ workspace: string \| null }` | center の情報。`workspace` は config の `workspace`（未設定は `null`）。`session_create` が `path` 省略時に使う `<workspace>/<name>` の親を、desktop の追加ダイアログが既定表示に使う。object のまま将来の項目を足す |

決めた点（今は）:

- 実体は supervisor（`remote-control.ts`）の entry。構築時固定だった entry を `add` / `remove` で動的に足し引きできるようにした。`remove` できるのは `add` したものだけ（config 由来は不可）。
- 保存は center 自前の状態ファイル（config と同じ dir の `sessions.json`）。config の projects には書かない。center 起動時に復元し、`--continue` で起動する。`--continue` が接続前（30 秒以内）に終了したら、素の起動へ fallback する（claude は約 4 時間以内の記録が無いと `--continue` で error exit する。実測: `No recent session found in this directory or its worktrees`）。
- `path` 省略時は config の project `workspace`（desktop が渡す 1 件）の path の下に `<name>` を作る。`workspace` が無ければ `path` 必須。
- 拒否: name 重複、既存 project 名（`workspace` 含む）との衝突、他の project / session と同じ path、相対 path。
- 新規 path の trust（実測、claude 2.1.312）: プロンプトは出ず `Error: Workspace not trusted. Please run \`claude\` in <path> first ...` で即 exit 1。親 dir が trust 済みなら配下は通る。未 trust の path では `session_create` は `lastError` 付きの `starting` を返し、再起動を繰り返して上限で `error`。center が claude の設定に trust を書く案は、ユーザー設定の書換えになるので入れていない（今は。人が一度 `claude` を起動して承認する）。
- 同じ folder を直前まで別の remote-control が握っていると、`This folder is already served by a terminal ...` で約 1 分待たされて終了する（実測）。
- `session_delete` は path を消さない（ドラフトの案どおり）。

## 既存 tool との重複（整理はユーザー判断）

| 既存 | A / B との関係 |
|---|---|
| `rc_list` | `session_list` と同じ情報（`session_list` は `source` 付き、`RcStatus` の全項目ではない） |
| `rc_start` / `rc_stop` | config の project（`workspace` など）を起動・停止する。session は `session_create` / `session_delete`（`rc_stop` は session の entry も止められるが外さない）。desktop の再ログイン画面の「再起動」は session に対して `rc_stop` → `rc_start { resume: true }` を使う |
| `rc_status` | `session_list` の 1 件分（`RcStatus` の全項目 `args` `claude` `restarts` `environmentUrl` を含む） |
| `server_list` | `config.servers` ベース。B の発見ベースの選択とは別系統（B 用の一覧 tool は無い） |

## 未決

1. owner を master-cap の接続に自動で載せる手段（上記）。
4. `running` のまま返信を失った remote の再同期（server の `status` と突き合わせる）。
5. 未 trust の path に session を作る手段（trust の付与を center が担うか）。
6. remote 記録の寿命（`done` / `failed` を自動で消すか）。
7. 古い peer が broker に残っている時の server 選択（先頭が古い peer になり得る）。
8. claude.ai 側に残る remote-control の environment / session 表示の後始末（CLI で消す手段を確認できていない）。
