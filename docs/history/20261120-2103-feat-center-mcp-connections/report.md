# feat/center-mcp-connections（M1: 接続の設定・鍵・command）

## 基点

- 基点: `e5a438e38763a12520fc3ac12b4ff445579816f6`（fix/center-mcp-redact の先頭 = M0。作業の終わりまで動いていない）。
- 設計: docs/mcp-connection-design の M1 の節・実装のまとまりの表・review の反映（R-01〜R-22）・実測の章。

## 変えた file（すべて packages/center）

| file | 内容 |
|---|---|
| `src/mcp-json-file.ts`（新） | 3 つの file の共通の読み書き（一時 file → rename、0600、dir は新規の時 0700、mtime/size/inode の cache、壊れた時は理由の種類だけ） |
| `src/mcp-secrets.ts`（新） | `mcp-secrets.json`（鍵の名前 → 値・rev・更新時刻）。値の検査（4096 文字まで、空白・制御・非 ASCII 不可） |
| `src/mcp-connections.ts`（新） | 接続の形（zod）・検査・合成（共通 + session の項目ごとの上書き、null で外す）・`mcp-connections.json` の読み込み・見える道具名（前置き・絞り込み・memory の `event` 隠し）・設定の hash |
| `src/mcp-status.ts`（新） | `mcp-status.json`（分類・道具の数・見える名前・設定の hash・先の一覧の写し 1 MB まで） |
| `src/mcp-probe.ts`（新） | 「試す」の本体（MCP の SDK の client。initialize → tools/list をページを辿って。道具は呼ばない） |
| `src/mcp-cli.ts`（新） | `bantou-center mcp list/get/set/unset/secret/test` |
| `src/cli.ts` | `mcp` の分岐を足しただけ |
| `src/project-settings.ts` | `memoryUrlSchema` に `export` を付けただけ（URL の検査を再利用） |
| `README.md` | 「MCP の接続の設定」の節 |
| `test/mcp-connections.test.ts`（新）・`test/helpers/fake-relay.ts`（新） | test と偽の中継 |

触っていない物: `wrapper.ts`・`remote-control.ts`・`memory-events.ts`・`memory.ts`・`memory-settings.ts`・session / 画面 / web / master-cap の道具、protocol・server・Rust・packages/memory。

## command の使い方

README の節に同じ内容がある。要点:

- `bantou-center mcp set <名前> --url <URL> [--secret <鍵の名前>] [--auth-header H] [--auth-format "Bearer {secret}"] [--header N=V]... [--identity-header H] [--tool-prefix P] [--allow T]... [--deny T]... [--role memory] [--session S] [--off]`
- `printf %s "$KEY" | bantou-center mcp secret set <鍵の名前> --stdin`（または `--file <path>`）。引数に鍵を書くと値を出さずに断る。
- `bantou-center mcp test <名前> [--session S] [--json]`: 終了 code 0 = 取れた、1 = 取れない、2 = 使い方の誤り。結果は `mcp-status.json` に残す。

## 判断

- 新しい接続を作る時、`transport: "http"` は CLI が補う（利用者に書かせない）。
- `--secret` / `--auth-header` / `--auth-format` のどれかを付けると `auth` ができる。`--secret` を省くと鍵の名前は接続の名前（設計の既定どおり）。session の `set` は、その session で有効な合成後の値を元に、触った入れ子の項目を丸ごと上書きに書く（設計の「入れ子は丸ごと置き換え」）。
- `set` の全体の検査は「今までに無かった問題」だけで断る（既存の別の問題で無関係な `set` が止まらないように）。ただし file 自体が壊れている・一部の項目が捨てられた時は、書き込み系の command は断る（壊れた内容を上書きして消さないため）。
- 共通の接続を `unset` する時、session の上書きが残っていれば断る（上書きだけ残ると不完全な定義になるため）。`unset` は鍵を消さない（`secret unset` で別に消す。設計は `memory unset` だけ「他の接続が使っていなければ消す」と書いており、`mcp unset` の鍵の扱いは書いていなかった）。
- 5xx は `unreachable` に分類（設計の分類に 5xx の行き先が無かったため。gateway が落ちている事が多い）。それ以外の 4xx（401 / 403 以外、404 以外）と MCP として読めない応答は `protocol`。鍵が未設定の `auth` 付き接続は、接続せずに `config-error`。
- 「試す」の識別の値: `--session` の値、無ければ `bantou-center-test`。接続に `identity.value` があればそれを優先する（設計の 5.2 は session の値としか書いていない。`identity.value` は合成後の session の上書きで入る agent の ID なので、そちらが実際に使われる値と一致する）。
- http: の公の host の判定は設計の列挙（loopback・RFC 1918・ULA・link-local・`localhost`）だけ。host 名だけの LAN 内の名前は「公」として扱い、`--allow-plain-http` が要る（保存はされない。set の時の確認だけ）。
- `mcp-status.json` の key は `<scope>/<名前>`（scope = `common` か session 名）。

## 設計書・指示との食い違い

- 設計は `test` の `mcp-status.json` に「道具の一覧の写し（1 MB まで）」を求めている。実装した（`toolsCopy`）。口が返す側（M3）は未実装。
- 設計の「`--expose-memory-write`」は `--no-expose-memory-write` も足した（外す手段が無かったため）。`--no-tool-prefix`・`--allow-plain-http` も同様に足した（設計の usage に無いが、設計の本文が要求する動き）。
- 設計の 5.1 の `memory` command の読み替え（`bantou-center memory` → `mcp`）は M4 なのでしていない。`bantou-center memory` の動きは変えていない。
- 設計は「表示の文に、次の起動から効く物と次の呼び出しから効く物の違いを書く」とあるが、M1 は session にも書き込みにも使われないので、代わりに「この版は使わない」旨を `set` の出力・usage・README に書いた（役割 `memory` の時は設計が指定した文意）。
- 指示にあった `mcp_connections_status` や `assertCenterOnly` の変更は M0 / M5 の範囲で、この branch では触っていない。

## 確認

- `packages/protocol` を `tsc` で build 済み。`packages/center` の `tsc --noEmit`: 0 件。
- `node --import tsx --test test/*.test.ts`（packages/center 全体）: 703 件、702 pass、1 fail。落ちたのは既知の不安定 test「center を SIGKILL すると rc が孤児で残り、次の center の起動で回収される」だけ（指示で既知の不安定とされた test。M1 の変更は触っていない所）。
- 新しい test は 24 件（`test/mcp-connections.test.ts`）、すべて pass。内訳: 検証 9（予約の名前、形の崩れた URL、鍵付きの平文の http、`{secret}` の数、固定の header、役割 memory の重複、入力値を含まない誤りの文、合成、見える道具）、設定・鍵の往復と権限 3、鍵が出ない 3（引数の拒否、不正な鍵、全出力 + 状態 file の検索）、試す 9（3 つの鍵の形 + ページ、401、403/404/503/壊れた応答/落ちている/遅い、config-error、使い方の誤り、識別の header と `event` を呼ばない、session の上書き）。
- 偽の中継: `test/helpers/fake-relay.ts`（127.0.0.1 の空き port だけ。鍵の header 名と形の切り替え、受けた header の記録、drop / 401 / 403 / 404 / 503 / 遅い / 壊れた応答、ページ、道具の呼び出しの記録）。実の中継・実の外部記憶には接続していない。

## 変異の確認（入れて落ちる事を確かめて戻した）

| 変異 | 落ちた test |
|---|---|
| `get` / `list` の鍵の状態の表示に鍵の値を足す | 往復、全出力の検索（2 件） |
| 401 の分類を外す（`auth` → `protocol`） | 「鍵が違うと auth」 |
| file の mode を 0644 に | 「file は 0600」 |
| 役割 memory の重複検査を外す | 「役割 memory は 1 つまで」と入力値を含まない文の test |

戻した後の `git status` は変異の痕跡なし。

## 気づいた事

- `--value` などの拒否は、`REFUSED` に当たらなくても「不明な引数」で断られるので、値は出ない（二重の防御）。
- `bun install` の後、per-package の `node_modules` に `.bin` ができる形だった（root の `node_modules/.bin` は無い）。`tsc` は `packages/*/node_modules/.bin/tsc` を直接呼んで確認した。

---

# review の反映（往復 1 回目）

基点: `d7b7fa1b65e0a8bc3101dc18e6c40c93d2778d5d`（M1 の初回の先頭）。この上に commit した。

## 直した 2 件

### 1. 鍵の「名前」に値を書いてしまう取り違え（medium）

- 状況: `--secret sk-live-…` や `secret set <値> --stdin` の `<値>` が、名前の正規表現に通って `mcp-connections.json` に保存され、set / get の表示にも出た。
- 方針: 名前の形を絞り、名前らしくない物は**値を出さずに**断る（「鍵の名前の形でない（短い識別子にする。鍵の値は標準入力か file で渡す）」）。`checkSecretName`（`src/mcp-secrets.ts`）に集約し、次の 4 か所で使う: `set --secret`、`secret set <名前>`、`secret unset <名前>`、接続の file の `auth.secret` の検査（zod）と鍵の file の読み込み（値らしい名前の entry は捨てて「不正」と出す）。
- 規則: 英数字と `. _ -` の **64 文字以内**（設計の名前の規則は 100 文字だった。`<接続名>.<session>` を許すため 32 より長くし、値としては長い方を落とす）。次のどれかなら名前として認めない: 値によくある接頭辞（`sk-` `pk-` `ghp_` `github_pat` `glpat` `xox*` `AKIA` `ASIA` `eyJ`（JWT）`Bearer` `Basic` `key-` `token-` `secret-` `pass-` の後に英数字 8 文字以上）、英数字の連続が 24 文字以上、または 16 文字以上で英字と数字が混ざる連続（高エントロピーの近似）。
- 理由: 名前として通る形の値は事前に区別できない。なので「保証」でなく緩和として、現実の鍵（長い・接頭辞つき・英数字の混在）が通りにくい形にした。短い文字列の鍵（例: 10 文字の英数字）は名前として通りうる。この限界は残る。
- usage に「`--secret` は名前の参照で値ではない。鍵を入れるのは `secret set <名前> --stdin|--file` だけ。`<名前>` の位置に値を書かない」と書いた。
- 設計書との差: 設計の 2.2 は鍵の名前を `[A-Za-z0-9._-]{1,100}` としていた。実装は 64 文字以内 + 上の拒否に変えた。

### 2. `constructor` / `toString` などの名前で prototype を拾う（low）

- 状況: 鍵名・接続名・session 名が prototype の property と同名だと、「設定済み rev undefined」や誤った「消した」が出た。
- 直し: 自分の property だけを見る `own()` と、`__proto__` でも prototype を書き換えない `setOwn()`（`src/mcp-json-file.ts`）を足し、鍵・接続・session の読み書きの全箇所で使った。`effectiveRaw` の結果は null prototype の object。`Object.hasOwn` を `unset` の存在確認に使った。

## test（`test/mcp-connections.test.ts` に 4 件足した。全体は 28 件）

- `--secret` に値らしい 7 種類（`sk-live-…`・`ghp_…`・JWT・`AKIA…`・混在の 20 文字・26 文字の英字・65 文字）を書くと exit 2、断る文と全出力に値が出ない、`mcp-connections.json` ができない。
- `secret set / unset` の位置引数に同じ値を書くと exit 2、値も標準入力の値も出ない、`mcp-secrets.json` ができない。
- 普通の名前（`relay`・`memory.alice`・`k-1_x`・`relay-prod.s_1`）は通る。鍵の file に手で入れた値らしい名前の entry は一覧に出ず「不正」と出る。
- 鍵名 `constructor` / `toString` / `hasOwnProperty` / `valueOf` / `__proto__`、接続名 `constructor` / `valueof`、session 名 `constructor` / `toString` / `__proto__` で、「未設定」「元から無い」「共通の接続なし」が正しく出る・入れて消せる・`Object.prototype` が汚れない。

## 確認

- `packages/protocol` を build。`packages/center` の `tsc --noEmit`: 0 件。
- center 全体: 707 件、706 pass、1 fail。落ちたのは既知の不安定「center を SIGKILL すると rc が孤児で残り…」だけ。
- 変異（入れて落ちる事を確かめて戻した）:
  - 値らしい名前の検査（接頭辞・長い連続・混在）を外す → 3 件が落ちる（`--secret`、位置引数、普通の名前と値らしい名前の読み込み）。
  - `own()` を素の参照 `o[k]` に戻す → prototype の名前の test が落ちる。
  - 戻した後の `git status` は変異の痕跡なし。

## 直さない low（内容だけ残す）

- `--allow '*'`（全許可）の書き方は未実装。`allow` は先頭一致の `prefix*` と完全一致だけ。
- 平文 http の確認は `set` の時だけ（保存形に「許可済み」を残さない）。保存後に file を手で書き換えれば通る。`test` は確認しない。
- `mcp-status.json` の書き込みに lock が無い。2 つの command が同時に `test` すると後勝ち（他の接続の結果が消えうる）。壊れた file は空として読み、次の `test` で上書きされる。
- `--stdin` を端末で使うと入力が端末に表示される（echo off にしていない）。パイプか `--file` を使う前提。
- status の key `<scope>/<名前>` は、session 名に `/` が入らない規則（`[A-Za-z0-9_-]`）なので衝突しないが、scope に `common` という名前の session があると共通と区別できない。
