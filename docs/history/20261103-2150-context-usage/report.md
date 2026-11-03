# session のコンテキスト使用量を center が把握し desktop に出す

branch: `feature/context-usage`（`develop` から切った）

## 取得方法と根拠

採用: (a) claude の transcript の末尾を読む。

- 実 transcript（`~/.claude-agent/projects/<cwd 変換>/<session id>.jsonl`）を実測。assistant 行の `message.usage` に `input_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens` / `output_tokens` がある。
- dir 名は cwd の英数字以外を `-` にしたもの（実在する dir 名で確認）。設定 dir は `CLAUDE_CONFIG_DIR`（無ければ `~/.claude`）。
- 軽い: 5 秒ごとに mtime / size を見るだけで、変わらなければ読まない。読む時も末尾 64KB（足りなければ 4 倍ずつ、上限 8MB）。
- 不採用 (b) statusLine: `--settings` で与えると利用者の statusLine 設定を上書きする。さらに center へ送る経路（token 付き HTTP。stdio transport では無い）を statusLine の command に作る必要があり、重い。
- 画面（pty）の文字解析は使っていない。

窓の大きさ（実測に基づく判断）:
- transcript の assistant の `model` は `claude-opus-5-5` などで `[1m]` が落ちている（`[1m]` を含む例は 0 件）。
- 同じ素の名前で使用量 805,882 tokens の例があり、素の名前から窓（20 万 / 100 万）は決められない。
- そのため `[1m]` が config の `remoteControl.model` か transcript の model にある時だけ 1,000,000。それ以外は `windowTokens` / `percent` = null（desktop は「ctx 84k」のようにトークン数だけ出す）。20 万と決め打ちはしていない。

transcript の特定: dir の `*.jsonl` のうち、今回の起動時刻の 2 秒前以降に更新された最新の 1 本（center は session id を知らない。`--continue` は session id を指定できない）。

## 仕様

- `session_list` / `session_create` の `SessionInfo` に `contextUsage: { usedTokens, windowTokens, percent, updatedAt } | null` を追加（対象は `session_create` で作った session。config 由来は常に null）。
- 値が変わった時だけ `GET /events` に `reason: "context"` を流す。desktop は reason を見ずに `session_list` を取り直すので、旧 desktop と混在しても動く。項目の省略（旧 center）は Rust 側 `#[serde(default)]` と null で受ける。
- `packages/protocol` は変更なし（`session_list` は center の tool で protocol のメッセージではない）。protocol の version は上げていない。package の version も上げていない。
- desktop: サイドメニューの行と選択中セッションの見出しに「ctx 42% 84k/200k」。丸めた % が 80 以上で警告色（`text-warning`）。窓不明は「ctx 84k」、null は非表示。

## 変更ファイル

- `packages/center/src/context-usage.ts`（新規）、`daemon.ts`、`sessions.ts`、`events.ts`
- `packages/center/README.md`（「context 使用量」節、tool 表、events）
- `packages/center/test/context-usage.test.ts`（新規）、`test/sessions.test.ts`
- `desktop/src-tauri/src/session.rs`（`ContextUsage`、`Session.context_usage`、テスト）
- `desktop/src/types/index.ts`、`composables/useBoard.ts`、`components/ContextUsage.vue`（新規）、`components/SessionColumn.vue`、`pages/index.vue`
- `desktop/e2e/context-usage.spec.ts`（新規）、`e2e/mock/bantou.ts`
- `desktop/README.md`

## テスト

- center: `bun run test` 269 pass / 0 fail（うち追加 9: context-usage 8、sessions 1）、`bun run typecheck` エラーなし。
- 実 transcript（この worker 自身のもの）を tracker で読み、`usedTokens: 165166` を得た（窓は model 設定なしなので null）。
- desktop e2e（静的ビルド + 簡易静的サーバー + ms-playwright の chromium）: 全 77 pass（新規 4: 表示・警告色・窓不明・非表示）。
- `cargo test`（事前に `bun run build:sidecar`）: 245 pass / 0 fail / 5 ignored（新規 1）。

## 実機で確かめること

- master-cap（`[1m]` 無しの `--model` / 既定）で「ctx NNNk」と出るか。`[1m]` 付き model を config に置いた時に % が出るか。
- `--continue` 復帰後に、新しい transcript へ切り替わって値が追従するか。
- 同じ cwd で手動の claude を動かした時に取り違えないか（取り違え得る。README に記載）。
- 会話が進むたび、数秒内に desktop の表示が更新されるか。

## 後始末と残存物

- 一時 config・簡易静的サーバー（port 14200）・一時 dir は停止・削除済み。一時 config は commit していない。
- clone 内の ignored な生成物は残っている: `desktop/.nuxt` `desktop/.output` `desktop/src-tauri/target` `desktop/src-tauri/binaries` `packages/*/target` `packages/protocol/dist` `node_modules`。
- `bun install` で変わった `bun.lock` は戻した（commit していない）。
