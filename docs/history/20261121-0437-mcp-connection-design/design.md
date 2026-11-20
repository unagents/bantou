# center の MCP の接続（設計）

2026-11-21。設計のみ（code は変えない）。基点は origin/develop の 2009f18。未 merge の `fix/memory-setting-center-only`（4c51914 / f0245b0 / 9f57726）が develop に入った後の状態を前提にする。

同じ日に review を受け、指摘を本文に反映した（11 章が review、12 章が指摘ごとの反映）。本文で `（R-xx）` と書いた所が反映した箇所。

## 0. 要件と結論

要件（利用者の指摘）:

- 外部記憶（memory）の操作は MCP の道具で行う前提なのに、center が「MCP の道具への接続の仕方」を設定として持っていない。
- MCP の中継（1 つの URL の先に複数の MCP の server が並び、鍵 1 本で通る物。以下「中継」）への接続（URL と鍵）を、MCP の道具の設定として仕様に取り込む。
- 画面（desktop / web）が知るのは center への経路だけ。center の内側の運用の設定、とくに秘密の値は center の側だけで扱う。

結論（推奨で進める前提）:

1. center は **「MCP の接続」の一覧**を設定として持つ（`mcp-connections.json`）。1 件 = 名前・種類（HTTP。stdio は形だけ決めて後回し）・URL・鍵を載せる header の名前と値の形・秘密でない固定の header・道具の絞り込み・道具名の前置き・役割（`memory` など）。全 session 共通と session ごと（上書き・無効化）を持つ。
2. 外部記憶は **役割 `memory` を持つ接続の 1 つ**にする。中継経由でも直結でも同じ形（URL・header・前置きが違うだけ）。center 自身の書き込み（MCP の client）も同じ接続を使う。agent の ID は接続の「識別の header」に center が載せる。
3. 鍵は設定の file に書かず、別の **`mcp-secrets.json`（mode 0600、状態 dir は 0700）**に置く。入れるのは center の command だけ（標準入力か file）。
4. session には鍵を渡さない。session は **center の中継の口（`/mcp/conn/<名前>`）**につなぎ、center が鍵と agent の ID を付けて先へ送る（分かれ目 1）。鍵の入れ替えは動いている session にも次の呼び出しから効く。
5. 設定の口は center の command（`bantou-center mcp list|get|set|unset|secret|test`）だけ。画面・web・session の MCP の口からは書けない（同じ OS の user の shell は境界の外。R-05）。画面に見せるのは「名前・役割・設定済みか・つながるか（最後に試した結果）」だけ。
6. いまの `bantou-center memory get|set|unset` は残し、内部で「名前 `memory`・役割 `memory` の接続」に読み替える。`memory-settings.json` は center の起動時に新しい形へ移す。
7. `messenger`（`bantou-messenger`）と `bantou` の 2 つは center が自分で組み立てる物で、この設定の対象にしない。
8. 実装は M0（今、画面・web への応答に載っている外部記憶の URL と agent の ID を伏せる）から始め、読みと書きの切り替えは M4 で同時に行う（8 章。review の R-03・R-04）。

## 1. 現状（事実。file:行は fix/memory-setting-center-only の版）

### session に渡す MCP

- `--mcp-config` は `mcpConfigJson` が組み立てる（`packages/center/src/wrapper.ts:71-98`）。entry は 3 つ:
  - `bantou-messenger`: stdio。`npx -y @unagents/messenger@<版> mcp`（`wrapper.ts:73-79`）。
  - `bantou`: http。center の session 向けの口（`/mcp/session`）。`Authorization: Bearer ${BANTOU_SESSION_TOKEN}` と `X-Bantou-Session`（`wrapper.ts:80-86`）。center が http で待ち受けていない時は付けない（`daemon.ts:64-70`）。
  - `memory`: http。外部記憶の URL を直接指す。token があれば `Authorization: Bearer ${BANTOU_MEMORY_TOKEN}`、`X-Agent-Id` は agentId か session 名（`wrapper.ts:87-96`）。
- token の実値は env で渡す（`remote-control.ts:514-517`）。`--mcp-config` には `${…}` の参照だけが入り、claude が env から展開する。
- `--strict-mcp-config` は付けていない（`wrapper.ts:140-157`）。利用者の個人の設定（user / project の scope）の MCP の server も session に載る。
- 許可は `--settings` の `permissions.allow` に `mcp__bantou-messenger__*`・`mcp__bantou__*`・`mcp__memory__*`（`wrapper.ts:110-116`、`remote-control.ts:499`）。
- status と log に出す引数は `--append-system-prompt` だけ伏せる（`remote-control.ts:86-90`、`522`、`559`）。`--mcp-config` の JSON（外部記憶の URL（query 込み）・header の名前・agent の ID）はそのまま status の `args` と center の log に載る。token は `${…}` の参照なので載らない。
- status は `rc_list`・`rc_start`・`rc_status`（`tools.ts:268-298`、`remote-control.ts:425` の `snapshot` が `args` を写す）で center の `/mcp` から返る。`rc_list` と `rc_start` は web の許可の一覧にある（center-client `tool-policy.ts:6-7`）。**したがって今、外部記憶の URL と agent の ID が画面・web への応答に載っている**（review で確認。R-04）。
- 外部記憶の使い方の指示（system-instructions の部品 `memory@1`）は `mcp__memory__*` の名前を固定で書く（`system-instructions.ts:155-168`）。

### 外部記憶の設定（fix branch の後）

- 保存先は状態 dir の `memory-settings.json`（mode 0600、`common` と `sessions`。session の値があれば共通は使わない）（`memory-settings.ts:14-29`、`84-89`）。
- 書くのは CLI `bantou-center memory get|set|unset` だけ。token は `--token-stdin` か `--token-file`、`--token` は断る（`memory-settings.ts:100-105`、`154`）。表示は URL の origin + path だけ、token は「設定済み / なし」（`memory-settings.ts:116-126`）。
- MCP（画面・web・master-cap）からの更新に `memory` があれば断る（`project-settings.ts:127-134`、`tools.ts:104`、`147`、`170`、`sessions.ts:294`、`326`、`360`）。web は center へ送る前にも断る（center-client `tool-policy.ts:37-51`）。ただし更新の入力の形は `.passthrough()`（未知の項目を素通し。`project-settings.ts:115-123`）なので、断るのは名前を挙げた項目だけ。
- 保存済みの file を読む時、形の合わない entry は黙って捨てる（`memory-settings.ts:34-39`、`49-50`）。
- center は session の起動のたびに読み直す（`remote-control.ts:461-470`）。session の改名・削除で設定を付け替える（`sessions.ts:199-209`、`443`、`493`）。旧形式からの移行あり（`sessions.ts:211-245`）。
- URL は http / https の絶対 URL、`${` と `user:pass@` は不可（`project-settings.ts:61-79`）。

### center 自身の書き込み

- `memory-events.ts` が hook と remote の往復を event にし、`memory.ts` のキューで送る。送り先は `MemoryTarget { url, token?, agentId }`（`memory.ts:37-41`、`memory-events.ts:79-88`）。
- MCP の client（Streamable HTTP）の header は `X-Agent-Id` と `Authorization: Bearer <token>` の固定（`memory.ts:332-334`）。呼ぶ道具の名前は `event` の固定（`memory.ts:361`）。
- 失敗は 1 秒から倍々で最大 60 秒の再試行、lane（宛先）ごとの上限を超えたら古い分から捨てる。`isError` は捨てる（`memory.ts:118-123`、`169-184`、`237`、`263-266`）。
- lane の key は `owner + url + agentId`（`memory.ts:256`）。item は enqueue の時の target（token 込み）を持ち（`memory.ts:150-153`）、再試行も同じ token で送る。1 回の呼び出しの上限は 15 秒（`memory.ts:315`）。log の理由は `redactReason` が token の値と `Bearer …` を伏せる（`memory.ts:132-137`）。

### center の http の口（session 向けを含む）

- `/mcp`（外向けの token）と `/mcp/session`（session の使い捨て token + `X-Bantou-Session`。token は session 名に束縛、`session-auth.ts:14-28`、`http.ts:398-408`）は、MCP の session の数の上限 **32 を共有**する（`http.ts:36`、`499-501`。超えた initialize は 503）。放置 30 分で MCP の session を閉じる（`http.ts:34`）。request の本文は 4 MB まで（`http.ts:32`）。
- bind が loopback 以外の時は Host / Origin の絞り込みをせず token だけで守る（`http.ts:76-86`）。session に渡す口の URL は wildcard の bind なら `127.0.0.1`、それ以外は bind の address（`daemon.ts:65-69`）。
- session の使い捨て token は center の memory の中だけにある（`session-auth.ts`）。center の停止は session も止める（`daemon.ts:189` の `supervisor.shutdown()`）。

### 外部記憶の service の認証と分離（packages/memory）

- `/mcp` への全 request で `Authorization: Bearer <MEMORY_TOKEN>`（定数時間比較）と `X-Agent-Id`（`[\w.@:-]{1,128}`）を検査する。どちらか欠ければ 401（`server/middleware/auth.ts:6-17`、`server/utils/auth.ts:27-36`）。
- 道具の側は **HTTP request ごとの header** から `x-agent-id` を読み直す（`server/utils/tools.ts:9-14`）。
- 読む範囲は認証済みの agent に絞る（SQL の条件 + Row Level Security。`server/utils/recall.ts:80-117`、`162-190`）。他 agent の指定は拒否（`recall.ts:82-83`、`164`）。
- 信頼の境界は token 1 本で、`X-Agent-Id` は自己申告（`packages/memory/README.md:153-155`）。token → 名乗れる agent の対応（`MEMORY_TOKENS`）は「Phase 2 の課題」として未実装。

### protocol

- `packages/protocol` は center と server（remote-cap）の間の約束で、版は `MESSENGER_PROTOCOL 1.8.1`（`protocol/src/server.ts:14`）。memory も MCP の接続も載っていない（grep で確認）。`packages/server` も `--mcp-config` と memory を扱っていない（grep で確認）。

### desktop

- desktop の Rust の `center_call` は道具の名前を検査せず center へ素通しする（`desktop/src-tauri/src/center_mcp.rs:466-478`。review で確認）。center に道具を足しても Rust は変えずに済む。

## 2. 設定の形

### 2.1 保存先

| file | 中身 | 権限 | 書く物 |
|---|---|---|---|
| `<状態 dir>/mcp-connections.json` | 接続の一覧（秘密を含まない） | 0600 | center の command と、center の起動時の移行（5.4）と session の改名・削除の付け替え |
| `<状態 dir>/mcp-secrets.json` | 鍵（名前 → 値） | 0600 | center の command と、center の起動時の移行（5.4） |
| `<状態 dir>/mcp-status.json` | 最後に試した結果・道具の一覧の写し（秘密を含まない） | 0600 | center の daemon と command |

（R-08: 移行と改名で daemon も書くので、「command だけ」を直した。画面・web・session の口から書く経路は無い事は変わらない。）

- 「書く物」が守るのは **center の MCP の口（`/mcp`・`/mcp/session`・`/mcp/conn/*`）から書けない事**まで。同じ OS の user の shell（session の Bash の道具を含む）は file を直接書けるし、`bantou-center mcp` も動かせる。これは境界でない（7.1。R-05）。

- 状態 dir は config と同じ dir（今の `memory-settings.json` と同じ規則。`memory-settings.ts:166`）。作る時は 0700 にする。既にある dir の権限が広ければ log に警告を 1 行出す（直さない。利用者の dir を勝手に変えない）。
- 書き込みは一時 file → rename（今の `memory-settings.ts:83-90` と同じ）。
- center は使うたびに読む（mtime / size / inode が変わった時だけ読み直す。今の `memory-settings.ts:59-79` と同じ）。動いている間に command で変えてよい。

接続と鍵を別の file にする理由: 接続の file は「試す」の表示や不具合の調べで開かれやすい。鍵が同じ file にあると、中身を見せる・貼る・backup する時に一緒に出る。鍵の file は中身を見る理由が無い形にする。

### 2.2 接続の形（`mcp-connections.json`）

```json
{
  "version": 1,
  "common": {
    "memory": {
      "transport": "http",
      "url": "https://<中継>/mcp",
      "auth": { "header": "<鍵を載せる header 名>", "format": "Bearer {secret}", "secret": "relay" },
      "headers": { "<中継の server を選ぶ header 名>": "memory" },
      "identity": { "header": "X-Agent-Id" },
      "toolPrefix": "memory-",
      "tools": { "deny": ["event"] },
      "role": "memory"
    },
    "relay": {
      "transport": "http",
      "url": "https://<中継>/mcp",
      "auth": { "header": "<鍵を載せる header 名>", "format": "Bearer {secret}", "secret": "relay" },
      "tools": { "allow": ["search-*"] }
    }
  },
  "sessions": {
    "<session 名>": {
      "memory": { "identity": { "header": "X-Agent-Id", "value": "<agent の ID>" } },
      "relay": null
    }
  }
}
```

項目:

| 項目 | 型 | 意味 |
|---|---|---|
| 名前（key） | `[a-z0-9][a-z0-9_-]{0,31}` | session から見える entry 名（道具は `mcp__<名前>__<道具>`）。予約: `bantou`・`bantou-messenger`・`mcp`・`conn`（center が組み立てる物と、口の path と重なる物） |
| `transport` | `"http"`（`"stdio"` は形だけ予約） | 今回は HTTP（Streamable HTTP）だけ実装する。stdio は 2.6 |
| `url` | http / https の絶対 URL | 今の `memoryUrlSchema` と同じ検査（空白・制御文字・`${`・`user:pass@` 不可）。加えて query に鍵らしい名前（`key`・`token`・`secret`・`password`・`auth` を含む）があれば断る。`http:` で host が loopback・private の address（RFC 1918 / ULA / link-local）・`localhost` 以外なら、`auth` がある接続は `--allow-plain-http` を付けた時だけ保存する（鍵を平文で LAN の外へ送らない。R-14） |
| `auth.header` | header 名（RFC 7230 の token 文字） | 鍵を載せる header。省略時は `Authorization` |
| `auth.format` | 文字列。`{secret}` をちょうど 1 つ含む | 値の形。`Bearer {secret}`（既定）、`{secret}`（そのまま）など。`${`・空白以外の制御文字・CR / LF は不可（R-16） |
| `auth.secret` | 鍵の名前 `[A-Za-z0-9._-]{1,100}`（R-15） | `mcp-secrets.json` の key。省略時は接続の名前。複数の接続で 1 本の鍵を共有できる（中継の鍵 1 本で `memory` と `relay` を分ける時）。session ごとの鍵は `<接続名>.<session 名>`（session 名は大文字を含み 64 文字まで） |
| `auth` 自体を省く | | 鍵なしで接続する |
| `headers` | `{ 名前: 値 }`、10 個まで | 秘密でない固定の header（中継の server の選び方など）。値の CR / LF・制御文字は断る（R-16）。`auth.header`・`identity.header`・`Cookie`・`Proxy-Authorization` と同じ名前は断る。名前に `key`・`token`・`secret`・`auth` を含む物も断る（秘密の置き間違いを防ぐ。秘密は `auth` に入れる） |
| `identity.header` | header 名 | center が session ごとの識別（agent の ID）を載せる header。省略すると載せない |
| `identity.value` | `[A-Za-z0-9_-]{1,64}` | 識別の値。省略時は session 名。session ごとの設定で上書きする（今の `agentId`） |
| `toolPrefix` | 文字列 | 先の server が道具名に付けている前置き（中継が `<server名>-` のように付ける物）。center はこれで道具を絞り、session に見せる時に剥がす（2.4） |
| `tools.allow` / `tools.deny` | 道具名の配列（末尾の `*` だけ許す）、各 50 個まで | 前置きを剥がした後の名前で書く。allow が無ければ全部、deny が勝つ |
| `role` | `"memory"` か省略 | 役割。`memory` は 1 つの session に 1 つだけ（3 章） |
| `timeoutMs` | 1000〜120000 | 先への 1 回の呼び出しの上限。既定 60000 |

全 session 共通と session ごと:

- `common` は全 session に付く。`sessions.<session>.<名前>` は同じ名前の共通の接続を**項目ごとに上書き**する（今の memory は「session の値があれば共通を丸ごと使わない」だが、`identity.value` だけ変えたい場合が多いので項目ごとにする。項目ごとの合成は 1 段（`auth` などの入れ子の中身は丸ごと置き換え）だけ）。
- `sessions.<session>.<名前>: null` はその session でその接続を付けない。
- session にしか無い名前は、その session だけに付く（完全な定義が要る）。
- session の改名・削除で `sessions` の key を付け替える・消す（今の `moveMemory`（`sessions.ts:199-209`）を接続の一覧に広げる）。

### 2.3 中継の先に複数の server が並ぶ場合

中継の作りによって、1 つの URL の先にある server の選び方と道具名の付き方が違う。設定で表せるのは次の 3 つで、どれも上の項目の組み合わせで書ける:

| 中継の作り | 設定の書き方 |
|---|---|
| URL の path で server を選ぶ | `url` を server ごとの path にする |
| header で server を選ぶ | `headers` に選ぶ header を書く |
| 全 server の道具が 1 つの一覧に並ぶ（道具名に server の前置きが付く） | `toolPrefix` で 1 つの server の分だけにする。前置きを付けずに全部を 1 つの接続として見せてもよい（`relay` の例） |

推奨: 外部記憶のように center が意味を持って使う server は、**それだけを指す接続を 1 つ作り、名前を役割に合わせる**（`memory`）。他の道具は別の接続（`relay` など）にまとめ、`tools.allow` で要る物だけ通す。同じ鍵を `auth.secret` で共有する。

### 2.4 session から見える道具の名前

- session の `--mcp-config` に載る entry 名は接続の名前（`memory`・`relay`）。道具は `mcp__<接続名>__<道具名>`。
- center の中継の口（4 章）は、先の道具名から `toolPrefix` を剥がして session に見せ、呼ばれた時に付け直して先へ送る。中継経由でも直結でも、外部記憶の道具は `mcp__memory__recall`・`mcp__memory__context` のまま変わらない。system-instructions の `memory@1` の文面（`system-instructions.ts:164-165`）を変えずに済む。
- `toolPrefix` がある接続は、前置きで始まる道具**だけ**を見せる（前置きの無い道具は一覧から外し、呼ばれても断る）。したがって前置きの無い道具と剥がした道具が同名になる事は起きない。剥がした後に空になる名前（前置きと全く同じ名前）は外して log に 1 行。`toolPrefix` が無い接続は名前を変えない（R-17。旧版の「前置きの付いた方を優先」は、前置きで絞る規則と食い違うので外した）。
- 剥がした後の名前は claude の道具名の規則に合う物だけ見せる（英数字と `_` `-`、64 文字以内。合わない物は見せずに log。規則の上限は claude の側の値で、確かめていない。実装の時に公式の docs で確かめる）。

### 2.5 道具の絞り込み

- 絞り込みは center の中継の口で行う（一覧から外す + 呼ばれても断る）。session の `permissions` に頼らない（permissions は利用者の設定と足し合わされ、permission の mode によって効き方が変わるため）。
- 役割 `memory` の接続は、`tools.allow` / `tools.deny` に何を書いても `event` を session に見せない（書き込みは center が行う。session が偽の event を書けないようにする。`memory@1` の文面「自分では書き込みの tool を呼ばない」と同じ方針を道具の側でも守る）。見せたい時だけ専用の `--expose-memory-write`（保存形 `exposeMemoryWrite: true`）を付ける。`tools.deny` を明示すると既定の deny が消える旧版の形は、`--deny <別の道具>` を足しただけで書き込みの道具が出てしまうので採らない（R-13）。
- `--settings` の `permissions.allow` には `mcp__<接続名>__*` を入れる（絞り込みは口で済んでいるので、確認の問いを出さない）。

### 2.6 stdio の接続（今回は実装しない）

形だけ決める: `{ "transport": "stdio", "command": "...", "args": [...], "env": { "<名前>": { "secret": "<鍵の名前>" } } }`。center がその process を自分で起動し、中継の口から HTTP として見せる（session の process の下では動かさない。鍵が session の env に入らないようにするため）。cwd が session のフォルダであることを前提にする server とは相性が悪い。需要が出た時に別のまとまりで作る。

## 3. 外部記憶との関係

### 3.1 外部記憶 = 役割 `memory` の接続

- 外部記憶は「役割 `memory` を持つ接続」。その session で有効な接続のうち `role: "memory"` が 1 つあれば、その session に外部記憶がある（system-instructions の `ctx.memory` が真になる）。2 つ以上は設定の誤りとして `set` で断る（共通と session の合成後に検査する。`--session` の無い `set` は、`sessions` に名前のある全 session の合成後も検査する）。
- 実行時に 2 つ以上になっていた時（file を手で直した等）は、その session は**外部記憶なし**で扱う（`--mcp-config` に役割 `memory` の接続を載せず、`memory@1` を付けず、center も書かない。どれか 1 つを選ばない。選ぶと読みと書きの先が食い違いうるため）。log に 1 行（接続名だけ）、`mcp_connections_status` の `reachable` は `config-error`（R-12）。
- 役割 `memory` が 0 個、または session の上書きで `null` にした session は外部記憶なし（今の「設定が無い」と同じ）。
- **読み（session の `--mcp-config`・`ctx.memory`）と書き（center の event）は、同じ 1 つの関数（`resolveMemoryConnection(session)`）の結果だけを使う**。片方だけが別の設定（旧 `memory-settings.json` など）を見る期間を作らない（R-03。8 章の順もこれに合わせた）。
- 読みは session の起動時に決まり（`--mcp-config` に載るか）、書きは event のたびに決まる。動いている間に接続を外した・役割を外した時は、書きは次の event から止まり、session は次の起動まで entry を持つ（口は外れた接続を 404 で断る。4.3）。
- 識別の値の既定は session 名なので、session を改名すると agent の ID が変わる（今と同じ。`sessions` の key は付け替えるが、`identity.value` を書いていない session は記憶が新しい ID に分かれる）。改名の時に `identity.value` が無ければ旧名を書き込んで保つかは分かれ目 8。
- 直結: `url` = 外部記憶の service の `/mcp`、`auth` = `Authorization` / `Bearer {secret}`、`identity.header` = `X-Agent-Id`、`toolPrefix` なし。今の `memory` の設定と同じ意味になる。
- 中継経由: `url` = 中継、`auth` = 中継の鍵の header と形、`headers` / `toolPrefix` = 中継での外部記憶の選び方、`identity.header` = 中継が外部記憶へ渡す識別の header（3.3）。

### 3.2 center 自身の書き込み

- `memory-events.ts` の送り先を `resolveMemoryConnection(session)` から作る。
- キューの item は**鍵も header も持たない**。持つのは `{ connection: 接続名, identity: 識別の値 }` だけで、sink が**送る時に**その時の設定と鍵から URL・header（鍵・固定の header・識別の header）・道具名（`toolPrefix` + `event`）を組み立てる（R-10）。
  - lane の key は `owner + 接続名 + 識別の値`。鍵の rev を lane の key に入れない（入れると新旧の lane が並んで走り、event の順が崩れる）。
  - 鍵を入れ替えると、溜まっている分も次の再試行から新しい鍵で送られる。401 の時の「作り直して 1 回だけ再送」という特別な扱いは要らない。
  - 送る時に接続が無くなっていた（外した・役割を外した）item は捨てて log（件数だけ）。
- `memory.ts` の `createMcpEventSink` の header の組み立て（`memory.ts:332-334`）と道具名の固定（`361`）を外し、送る時の解決の結果から受ける。先への client の key（今の `keyOf`、`324`）は `URL + 接続名 + 識別の値 + 鍵の rev`（鍵の値を含めない。log やデバッグの出力に key が出ても鍵が漏れない）。rev が変われば古い client を閉じる。
- `redactReason`（`memory.ts:132-137`）には、その時の鍵の値と固定の header の値を渡して伏せる（独自の header 名で送る鍵は `Bearer …` の置き換えに当たらないため）。
- 1 回の呼び出しの上限は `min(timeoutMs, 15 秒)`（今の 15 秒を変えない。R-18）。
- 書き込みは center の中継の口を通さず、center の process から先へ直接送る（同じ設定・同じ鍵を使う）。
- agent の ID は `identity.value`、無ければ session 名（今と同じ。`memory-events.ts:87`）。

### 3.3 中継を通した時の「agent ごとの分離」（packages/memory の code で確かめた事）

外部記憶は request ごとに次の 2 つを見る（1 章の事実）:

1. `Authorization: Bearer <MEMORY_TOKEN>` が一致する事。
2. `X-Agent-Id` があり、形が正しい事。道具はこの値で読む範囲を絞る（SQL + RLS）。

したがって、中継を通しても分離が保たれる条件は次のとおり（中継の作りに依る。特定の中継で確かめてはいない）:

- (A) 中継が、外部記憶へ送る request の `Authorization` を**中継の側に登録した外部記憶の鍵**に置き換える事（center の中継の鍵をそのまま流すと 401。中継の鍵と外部記憶の鍵を同じ値にする運用は、鍵 1 本の届く範囲がさらに広がるので勧めない）。
- (B) 中継が、client（center）から来た識別の header（`X-Agent-Id`）を**request ごとにそのまま**外部記憶へ渡す事。中継が header を落とすと全 request が 401 になる。中継が識別の header を固定値で付ける設定だと、全 session が 1 つの agent の記憶を共有し、分離は失われる。
- (C) 中継が先への接続（MCP の session）を複数の client で使い回す場合でも、HTTP request ごとに (B) の header が付く事。外部記憶は request ごとに header を読むので（`tools.ts:9-14`）、request に正しい値が付いていれば混ざらない。中継が接続を開いた時の header だけを使い回す作りだと、別の session の agent の ID で読み書きされる。

(A)〜(C) が満たされれば、分離の強さは今と同じ（「鍵を持つ者は任意の agent を名乗れる。分離は取り違えを防ぐ物」。`packages/memory/README.md:153-154`）。ただし鍵を持つ者の範囲は広がる: 外部記憶の鍵は中継が持ち、中継の鍵を持つ者は誰でも任意の agent を名乗って外部記憶に届く。

この設計で手当てする物と、足りない物:

- center の中継の口（4 章）は、識別の header を **center が付け、session から来た同名の header は捨てる**。口の道具を普通に使う限り、session が他の session の agent を名乗る事はない（取り違えと、道具の呼び出しの引数・header での成り済ましを防ぐ）。
- ただしこれは**境界ではない**（R-05）。同じ OS の user で動く session は、(1) `mcp-secrets.json` を読める（4.1）、(2) 他の session の process の env にある `BANTOU_SESSION_TOKEN` を読める可能性がある（Linux は `/proc/<pid>/environ` が同じ user から読める。macOS は確かめていない。13 章の実測 E5）、(3) `bantou-center mcp` を動かせる。読もうとする session を止めるには center を別の OS の user で動かす事が要る（範囲外）。今の直結の形（鍵が env にある）より弱くはならない。
- 中継の鍵を持つ別の client（他の center・他の道具）が任意の agent を名乗る事は、この設計では防げない。防ぐには、名乗れる agent を鍵に結び付ける仕組みが要る。どちらか:
  - 中継の側: client の鍵ごとに、外部記憶へ渡す識別の header を中継が固定で付ける（client の申告を使わない）。中継がこの設定を持つ場合だけ使える。center の側では `identity.header` を省く。
  - 外部記憶の側: `MEMORY_TOKENS`（鍵 → 名乗れる agent の対応。README の Phase 2）に加え、中継が client ごとに別の鍵を外部記憶へ渡す形。中継が client の鍵ごとに先の鍵を変えられる場合だけ使える。
- 上の 2 つは運用と中継の作りに依るので、8 章のまとまり M6（任意）と 6 章の「運用の側に頼む事」に入れる。

## 4. 鍵の置き場と扱い

### 4.1 置き場

- `mcp-secrets.json`（0600）。形は `{ "version": 1, "secrets": { "<名前>": { "value": "<鍵>", "rev": <整数>, "updatedAt": "<時刻>" } } }`。`rev` は入れ替えのたびに 1 増やす（接続の再利用の key と表示に使う。値の代わり）。
- 同じ OS の user で動く process（session の Bash の道具を含む）は、権限 0600 でもこの file を読める。0600 で防げるのは別の user だけ。center と session は同じ user で動く（center が子として起動する）。これは 7 章の危険に書き（旧版の「8 章」は章の番号の誤り）、分かれ目 2 で扱う。

### 4.2 入れ方

```
bantou-center mcp secret set <名前> (--stdin | --file <path>) [--config <path>]
bantou-center mcp secret unset <名前> [--config <path>]
bantou-center mcp secret list [--config <path>]       # 名前・rev・更新時刻・使っている接続。値は出さない
```

- 値を引数に書かせない（`--value` などは「引数に書けない」と断る。今の `--token` の断り（`memory-settings.ts:154`）と同じ）。
- 末尾の改行 1 つを除く。空白・制御文字・非 ASCII は断る（今の `MEMORY_TOKEN_PATTERN` と同じ）。4096 文字まで。
- 誤りの文に入力値を含めない（項目名だけ。今の `memory-settings.ts:191-194` と同じ）。

### 4.3 session への渡し方

推奨（分かれ目 1 の b）: **session に鍵を渡さない**。

- session の `--mcp-config` に載る entry は、接続ごとに center の口を指す:
  `{ "type": "http", "url": "<center>/mcp/conn/<接続名>", "headers": { "Authorization": "Bearer ${BANTOU_SESSION_TOKEN}", "X-Bantou-Session": "<session>" } }`
  （今の `bantou` の entry と同じ認証。session ごとの使い捨ての token（`session-auth.ts`）を使う）
- session の env に入るのは今と同じ `BANTOU_SESSION_TOKEN` だけ。中継の鍵・外部記憶の鍵は env にも `--mcp-config` にも process の引数にも出ない。
- 今の `BANTOU_MEMORY_TOKEN`（`wrapper.ts:60`、`remote-control.ts:516-517`）は廃止し、継承分も消す（`delete env[...]` は残す）。
- center が http で待ち受けていない時（`sessionMcpUrl()` が null、`daemon.ts:64-70`）は、接続を session に付けない（今の `bantou` の entry と同じ扱い。log に 1 行）。

口の認可（R-01）:

- `/mcp/conn/<名前>` は、`X-Bantou-Session` と token の検査（`/mcp/session` と同じ）を通った後、**その session の合成後の一覧で有効な接続**だけを通す。共通に無く他の session にだけある接続、その session で `null` にした接続、役割 `memory` が 2 つ以上で外した接続（3.1）、`transport` が未実装の接続は、どれも同じ 404（`{ error: "not found" }`。有る / 無いを区別しない）。
- 判定は initialize の時だけでなく、**呼び出しのたびに**行う（動いている間に外した接続を次の呼び出しから断る）。
- MCP の session は `(window = "conn", owner = session 名, 接続名)` に束縛し、別の session・別の接続の path から同じ `mcp-session-id` を使えない（今の `http.ts:468` の検査に接続名を足す）。

口が中継として扱う物（R-11）:

- 扱うのは道具だけ。口の `initialize` の応答の capabilities は `tools: { listChanged: true }` だけにする。resources / prompts / completions / logging は出さない（先が持っていても）。
- `notifications/cancelled`（session が呼び出しを取り消した）は先へ送る。先の `notifications/progress` は session へ送る（session が progressToken を付けた時だけ）。
- 先から client への request（sampling・elicitation・roots/list）は、口が先へ「対応しない」error で返し、session へは送らない（session の会話の中で先の server が問いを出す経路を作らない）。
- 先の通知のうち session へ送るのは `notifications/tools/list_changed`（口の一覧が変わった時に口が自分で出す）と progress だけ。他は捨てる。

先への client（R-07）:

- MCP の SDK の client の transport は header を接続の時に決める（今の `memory.ts:332-334` も同じ使い方）。識別の header を session ごとに変えるため、先への client は `(接続名, 識別の値, 鍵の rev)` ごとに 1 つ持つ。同じ識別の値の session が 2 つあれば共有してよい。
- 先への MCP の session の数 = 動いている session の数 × その session の接続の数（+ center の書き込み 1 つずつ）。中継の側に client ごとの上限があれば当たりうる（13 章の実測 E7）。session が止まったら、その session の client を閉じる。放置 10 分で閉じ、次の呼び出しで開き直す。
- 先の redirect は追わない（3xx は `protocol` の error）。fetch は別の origin への redirect で `Authorization` を落とすと考えられるが（確かめていない）、独自の header 名に載せた鍵は落とさないので、追うと鍵が別の host へ届く（R-14）。

口の MCP の session の数（R-02）:

- 今の上限 32 は `/mcp` と `/mcp/session` で共有している（1 章）。口を足すと、claude の session 1 つが `bantou` + 接続の数だけ MCP の session を開くので、session が 8 つ・接続 2 つで `/mcp/session` 8 + `/mcp/conn` 16 = 24 になり、画面の分と合わせて上限に当たる。当たると initialize が 503 になり、その session は道具なしで起動する（claude が起動の後に initialize をやり直すかは確かめていない。13 章の E3）。
- 手当て: 上限を窓口ごとに分ける。`/mcp`（画面・web）は今の 32、`/mcp/session` と `/mcp/conn` は「session 1 つあたり (1 + 接続の数) × 2」を足した数（同じ session が取り直した時の重なりの分を ×2）。同じ `(owner, 接続名)` の MCP の session が既にある時の新しい initialize は、古い方を閉じてから受ける（claude が再接続した時に古い分が上限を食わない）。
- 放置 30 分で閉じる（`http.ts:34`）。外部記憶は「起動した時と判断の前」にしか呼ばれないので、30 分以上空く事は普通にある。閉じた後の呼び出しは 404 になり、claude が initialize し直すかは確かめていない（13 章の E2）。やり直さない場合は、`/mcp/conn` の放置の上限を session の寿命まで延ばす（session が止まった時に閉じる）。E2 の結果で決める。今の `/mcp/session` も同じ問題を持つ（この設計の範囲外だが E2 の結果を共有する）。

### 4.4 表示・log・error・画面への応答

- command の表示: URL は今の `displayUrl`（origin + path。query と fragment は伏せる）、鍵は「設定済み（rev N）/ なし」、固定の header は名前だけ（値は出さない。秘密でない前提だが念のため）、識別の値は出す（agent の ID は秘密でない）。
- log: 接続名・結果の種類（下の分類）・HTTP の status の数字だけ。URL・header の値・鍵・道具の引数と結果の本文は出さない。
- error: 先から返った error の文をそのまま session や画面へ返さない。分類して返す: `unreachable`（名前解決・接続の失敗）・`timeout`・`auth`（401 / 403）・`not-found`（404）・`protocol`（MCP として読めない）・`tool-error`（道具が `isError` を返した。道具の結果の本文は session には返す。道具の結果は道具の利用者の物なので）・`refused`（絞り込みで断った）。SDK の例外の message は URL を含みうるので使わない。
- status の `args`: `--mcp-config` の値も `<mcp: bantou-messenger, bantou, memory, relay>` のように entry 名だけに伏せる（`redactAppendSystemPrompt` と同じ所で）。center の口の URL しか入らなくなるが、画面が center の内側の構成（どの接続があるか以外）を知る必要は無い。
  - **今すでに**外部記憶の URL（query 込み）と agent の ID が `rc_list` / `rc_start` / `rc_status` で画面・web へ返っている（1 章）。この伏せる処理は接続の設計を待たずに、最初のまとまり M0 で出す（R-04）。`--settings` の JSON（hook の URL と session 名）は鍵を含まないので今回は伏せない。
  - 伏せた後の値を log にも使う（`remote-control.ts:559` の `shownArgs`）。spawn の失敗の文（`remote-control.ts:551`、`554`）は `err.message` を出すが、引数を含まない（node の spawn の error は command の path と code だけ。確かめていない。M0 の test で確かめる）。
- 画面への応答: 5.3 の項目だけ。

### 4.5 入れ替え（鍵の更新）

手順（運用の側と組む。6.2）:

1. 中継の側で新しい鍵を発行し、古い鍵と両方が通る期間を作る。
2. `bantou-center mcp secret set <名前> --stdin` で新しい鍵を入れる（rev が増える）。
3. `bantou-center mcp test <接続名>` で新しい鍵で道具の一覧が取れる事を確かめる。
4. 中継の側で古い鍵を止める。

動いている session への効き方:

- center の口（推奨の形）: 口は呼び出しのたびに鍵の file を読み（mtime の cache）、rev が変われば先への接続を閉じて新しい鍵で開き直す。**動いている session にも次の呼び出しから効く**（session の再起動は要らない）。session が持つのは center の口への token だけで、それは変わらない。
- center の書き込み: item は鍵を持たず送る時に解決するので（3.2）、溜まっている分も含めて次の送信・再試行から新しい鍵で送る。先への client は rev が変われば閉じて開き直す（R-10）。
- 今の直結の形（`BANTOU_MEMORY_TOKEN`）は session の起動時の env なので、効くのは次の起動から。移行（5.4）までの間だけ残る。

## 5. 設定の口

### 5.1 center の command

```
bantou-center mcp list  [--config <path>] [--session <name>]
bantou-center mcp get   <名前> [--config <path>] [--session <name>]
bantou-center mcp set   <名前> [--config <path>] [--session <name>]
        [--url <url>] [--auth-header <名前>] [--auth-format <形>] [--secret <鍵の名前>] [--no-auth]
        [--header <名前>=<値>]... [--clear-headers]
        [--identity-header <名前>] [--identity <値>] [--no-identity]
        [--tool-prefix <前置き>] [--allow <道具>]... [--deny <道具>]... [--clear-tools]
        [--role memory | --no-role] [--timeout-ms <n>] [--off]
bantou-center mcp unset <名前> [--config <path>] [--session <name>]
bantou-center mcp secret set|unset|list ...（4.2）
bantou-center mcp test  <名前> [--config <path>] [--session <name>] [--json]
```

- `--session` を省くと全 session 共通。`--session` を付けた `set` は項目ごとの上書き。`--off` は `null`（その session で付けない）。
- `list` は共通・session ごと・各 session で有効な合成後の一覧（名前・役割・transport・URL の表示形・鍵の状態・識別の header の名前と値・絞り込みの件数・最後に試した結果）。
- `set` は合成後の検査（役割 `memory` が 1 つまで、`auth.secret` の鍵があるか（無ければ警告で保存はする）、予約名）を通った時だけ保存する。
- center が動いている間に変えてよい。session の起動時に読む物（どの接続を `--mcp-config` に載せるか、`memory@1` の有無）は次の起動から効く。center の口と center の書き込みが読む物（URL・鍵・header・絞り込み）は次の呼び出しから効く。表示の文にこの違いを書く。
- 同梱の center を使う人の `--config` の扱いは今の `bantou-center memory` と同じ（README の 1 か所にまとめる）。

### 5.2 「試す」

`bantou-center mcp test <名前> [--session <s>]`:

1. 合成後の設定と鍵で、MCP の client（Streamable HTTP）として先へ接続する（識別の header は `--session` の値、無ければ `bantou-center-test`。外部記憶は試すだけでは何も書かない）。
2. `initialize` → `tools/list`（ページを辿る）。
3. 表示: 結果の分類（4.4）、HTTP の status、先の server の名前と版（`initialize` の応答の `serverInfo`）、道具の数、`toolPrefix` と絞り込みを当てた後に session に見える道具の名前の一覧、役割 `memory` なら `event`（前置き込み）が先にあるか。所要時間。
4. 結果を `mcp-status.json` に残す（時刻・分類・道具の数・見える道具名。秘密を含まない）。道具の一覧の写しは、名前だけでなく**先の一覧そのもの**（`name`・`description`・`inputSchema`・`annotations`。接続ごとに 1 MB まで、越えたら写しを残さない）を、写しを取った時の**設定の hash**（URL・`headers`・`toolPrefix`・絞り込み。鍵は含めない）と一緒に残す。口が写しを返すのは hash が今の設定と同じ時だけ（R-09。旧版は「見える道具名」だけで、7.4 の写しを返す事に足りなかった）。
5. 終了 code: 0 = 一覧が取れた、1 = 取れない、2 = 使い方の誤り。

- 試すのは command を動かした host から（= center と同じ host で動かす前提。README に書く）。
- center の daemon も、起動時と 10 分ごと（session に付いている接続だけ）に同じ確かめを行い `mcp-status.json` を更新する（画面の「つながるか」に使う。道具の一覧の写しは 7.4 にも使う）。この定期の確かめは M3 で作る（R-19）。口が先の一覧を取れた時も写しを更新する。

### 5.3 画面と session から書き換えられない事・画面に見せる物

- 書く口は command だけ。center の `/mcp`（画面・web・master-cap が使う）にも `/mcp/session` にも `/mcp/conn/*` にも、接続と鍵を書く道具を作らない。今の `project-settings` の更新（`session_create` の settings、`session_settings_update`、`center_settings_update`）に `mcp` / `mcpConnections` / `mcpSecrets` の項目が来たら、`memory` と同じく理由つきで断る（`assertNoMemory` を `assertCenterOnly` に広げる）。web の `tool-policy.ts` の引数の検査も同じ名前を足す。
- 断る一覧は「黙って保存されない」ための親切で、保証ではない（更新の入力は `.passthrough()`。1 章）。**保証は、session の `--mcp-config`・口・書き込みが `mcp-connections.json` と `mcp-secrets.json` だけを読み、`sessions.json` / center の設定の項目を読まない事**。これを test で固定する（`sessions.json` に `mcp` を手で入れても `--mcp-config` に出ない）（R-20）。
- `assertCenterOnly` は M0 で出す（接続の設定が入る前に、画面から同じ名前の項目を保存できないようにしておく）。
- 読む口は `/mcp` に 1 つだけ足す: `mcp_connections_status`（引数なし、または `session`）。返す物:

| 項目 | 例 |
|---|---|
| `name` | `memory` |
| `role` | `memory` / なし |
| `scope` | `common` / `session` / `off` |
| `configured` | 鍵が要る接続で鍵があるか（真偽） |
| `reachable` | `ok` / `unreachable` / `auth` / `timeout` / `protocol` / `config-error`（役割 `memory` が 2 つ以上など。3.1）/ `unknown`（未確認） |
| `checkedAt` | 最後に確かめた時刻 |
| `toolCount` | session に見える道具の数 |

  URL・header の名前と値・鍵の名前・rev・識別の値は返さない。画面は「どの接続があり、使えるか」だけ分かれば足りる。直し方は「center を動かす host で `bantou-center mcp test` を使う」という定型の案内だけ出す。
- `/mcp/session`（master-cap の session 向け）には何も足さない。session は自分の接続を `mcp__<名前>__*` の道具として使うだけ。

### 5.4 既存の物との関係・移行

`bantou-center memory`（fix branch の command）:

- 残す（分かれ目 3）。内部で「名前 `memory`・役割 `memory`・直結の形」の接続に読み替える:
  - `memory set --url U [--agent-id A] [--token-stdin|--token-file F|--clear-token]` = `mcp set memory --url U --auth-header Authorization --auth-format "Bearer {secret}" --secret memory --identity-header X-Agent-Id [--identity A] --role memory` + `mcp secret set memory`（`--session S` の時は鍵の名前を `memory.S`。session ごとに別の鍵を持てる今の動きを保つ）。
  - `memory get` = `mcp get memory` を今の 1 行の形で出す。中継経由など直結の形で表せない設定になっている時は「`bantou-center mcp get memory` を使う」と出す。
  - `memory unset` = `mcp unset memory`（鍵は他の接続が使っていなければ消す）。
- usage と README に「新しい command は `bantou-center mcp`」と書く。消す時期は決めない。

移行（M4 の center の起動時、1 回だけ。R-03・R-08 で直した）:

0. 順: 先に今の旧形式の移行（`sessions.json` / center の設定の `settings.memory` → `memory-settings.json`、`sessions.ts:211-245`）を走らせ、その後にこの移行を走らせる。同じ起動の中で両方が終わる。旧形式の移行の code は M4 の後も残す（古い `sessions.json` を持つ人のため）。
1. `memory-settings.json` がある時に行う。
2. `mcp-connections.json` に役割 `memory` の接続が既にある範囲（共通 / 各 session）は、**`mcp-connections.json` の方を残し**、`memory-settings.json` の同じ範囲の値は移さない。移さなかった範囲を log に出す（範囲の名前だけ）。M1〜M3 の間に `bantou-center mcp` で作った接続は M4 まで効かないので（8 章）、利用者が両方を書いた時は新しい方が意図だと見なす。
3. `common` → `common.memory`（直結の形）、鍵 → `mcp-secrets.json` の `memory`。
4. `sessions.<s>` → `sessions.<s>.memory`。今の規則は「session の値があれば共通を丸ごと使わない」なので、移した session の entry は全項目を持つ（項目ごとの上書きにしても同じ結果になる）。鍵が共通と違えば `memory.<s>`、同じなら `memory` を指す。
5. 読む時に形が合わず捨てられる entry（1 章、`memory-settings.ts:34-39`）は、移行では**生の JSON から数える**。捨てた件数と範囲の名前を log に出す（値は出さない）。
6. 書く順は `mcp-secrets.json` → `mcp-connections.json`。両方を書けたら `memory-settings.json` を **`memory-settings.json.migrated`（0600）へ rename** する（消さない。古い版の center に戻した時に、利用者が手で戻せるように。古い版はこの名前を読まないので、戻しただけでは外部記憶の設定は無い。README に戻し方を書く）。
7. 書けなければ、書けた方も含めて何も変えずに旧 file を残し、**その起動の間は外部記憶なし**で動く（M4 の後は旧 file を読む経路が無いため。旧版の「旧 file を読む今の経路で動く」は、読みと書きが別の設定を見る期間になるので採らない）。log に理由（error の種類だけ）と「`bantou-center mcp get memory` で確かめる」を出し、`mcp_connections_status` に `config-error` を出す。次の起動で再び移行を試す。
8. 移行の後、`memory-settings.json` を読む code（`memory-settings.ts` の `createMemoryFile` の読みの経路、`remote-control.ts` の `memoryOf`）は外す。`project-settings.ts` の `memorySchema` は `memory` command の入力検査として残す。

center が組み立てる物（対象外）:

- `bantou-messenger`（stdio）と `bantou`（center の session 向けの口）は、この設定の対象にしない。名前は予約名にして、同じ名前の接続を作れないようにする。`--mcp-config` の組み立ても今のまま（接続の entry を足すだけ）。

利用者の個人の設定（center の管理の外）:

- user / project の scope に利用者が足した MCP の server は、今どおり session に載る（`--strict-mcp-config` は付けない）。center は読まない・書かない・数えない。
- 同じ名前の entry が `--mcp-config` と個人の設定の両方にある時、claude がどちらを使うかは確かめていない。予約名と別に、center の command は「個人の設定と同じ名前を避ける」事を usage に書くだけにする（center は個人の設定を読まない方針のため検査しない）。
- 利用者が個人の設定で同じ中継を自分の鍵で足していると、同じ道具が 2 つの名前で見える。center は関与しない。README に「center の接続に寄せる」と書く。

## 6. LAN の外で動く場合

### 6.1 何がどこへつなぐか

推奨の形（center の口を通す）では、master-cap の session は center が同じ host で起動する子なので、session の位置 = center の位置になる。session が直接つなぐ先は center の口（同じ host）だけ。口の URL は、center の bind が wildcard か loopback なら `127.0.0.1`、特定の address に bind した時はその address になり（`daemon.ts:65-69`）、その時は LAN からも届く口になる（守りは session の token だけ。今の `/mcp/session` と同じ。R-21）。

```
[画面: desktop / web]
      │  center への経路だけ（今のまま。center の URL と接続の鍵（pair））
      ▼
[center]  ── 同じ host ──  [master-cap の session]
   │   ▲                        │
   │   └── /mcp/conn/<名前>  ◄──┘  session の使い捨て token だけ
   │
   │  接続の設定と鍵（center の中だけ）
   ├──► [MCP の中継]（TLS。LAN の外から届く場所）
   │        ├──► [外部記憶の service]（LAN の中。中継だけが届く）
   │        └──► [他の MCP の server]
   │
   └──► [外部記憶の service]（直結の形。center と同じ網にある時だけ）
```

場合ごと:

| 場合 | session → | center → | 要る物 |
|---|---|---|---|
| center も session も LAN の中 | center の口 | 外部記憶へ直結、または中継 | 今と同じ。直結のままでよい |
| center が LAN の外（session も同じ host） | center の口 | 中継（LAN の外から届く URL） | 中継に外部記憶が登録されている事。center の接続を中継の形に変える（`mcp set memory --url <中継> ...`） |
| 画面だけが LAN の外 | — | — | 画面は center への経路だけ持つ。接続の設定には関係しない |
| remote-cap（server 上の session） | 対象外 | 対象外 | server は外部記憶に書かない・つながない（`docs/design/external-memory.md` の「server は書かない」）。今回も変えない |

分かれ目 1 で a（直結）を採った場合は、session も中継へ直接つなぐ。session と center は同じ host なので、届く先は同じだが、鍵が session の env に入る（7 章）。

### 6.2 運用の側に頼む事（環境に依らない言い方）

1. 外部記憶の service を中継の先の server として登録する。外部記憶の service 自体は中継からだけ届く網に置いたままにする（LAN の外へ直接出さない）。
2. 中継が外部記憶へ送る request の `Authorization` を、中継の側に置いた外部記憶の鍵（`Bearer <外部記憶の鍵>`）にする。client から来た鍵の header を外部記憶へ流さない。
3. 中継が client から来た識別の header（既定 `X-Agent-Id`）を、request ごとに変えずに外部記憶へ渡す。先への接続を使い回す場合も、request ごとに付ける。できない場合はそう伝えてもらう（できなければ中継経由の外部記憶は使えない。3.3）。
4. center 用の鍵を 1 本発行し、届く先を要る server（外部記憶と、使わせたい道具の server）だけに絞る。可能なら、外部記憶の `event` は center の鍵だけに許し、他の client には許さない。
5. center に伝える物: 中継の URL（LAN の外から届く物と中の物の両方があれば両方）、鍵を載せる header の名前と値の形、server の選び方（path / header / 道具名の前置き）と前置きの規則、TLS の証明書が公に信頼される物かどうか。
6. 鍵の入れ替えの時、新旧の鍵が両方通る期間を作る（4.5）。
7. 中継が request の header と本文を記録するか、記録するなら残す期間と見られる人。外部記憶へ送る本文は会話の全文なので、記録の扱いを確かめる。
8. （任意。3.3）鍵ごとに名乗れる agent を固定する設定が中継にあれば、使えるかどうか。

## 7. 危険と手当て

### 7.1 鍵の漏れる経路

| 経路 | 今（fix branch の後） | この設計の後 |
|---|---|---|
| process の引数（`ps` で見える） | `--mcp-config` に外部記憶の URL・header の名前・agent の ID（鍵は `${…}` で載らない） | `--mcp-config` は center の口の URL と entry 名だけ。鍵も中継の URL も載らない |
| session の env | `BANTOU_MEMORY_TOKEN` に外部記憶の鍵 | 中継・外部記憶の鍵は入らない（`BANTOU_SESSION_TOKEN` だけ） |
| session の会話 | session の Bash の道具は env を継承すると考えられ（確かめていない）、`BANTOU_MEMORY_TOKEN` を読める | env に無い。ただし同じ user なので `mcp-secrets.json` を読む事はできる（下） |
| 状態 dir の file | `memory-settings.json`（0600）に鍵 | `mcp-secrets.json`（0600）だけ。接続の file には鍵が無い |
| center の log・status の `args` | `--mcp-config` の JSON が載る（鍵は無い） | entry 名だけに伏せる。log は分類と status の数字だけ |
| error の文 | — | 分類して返す。SDK の例外の message を使わない |
| 画面への応答 | memory を返さない（fix branch） | `mcp_connections_status` の項目だけ |
| command の履歴（shell の history） | `--token` を断る | 同じ（値を引数に書かせない） |
| 記録の file（外部記憶の event） | 会話の本文を送る | 同じ。利用者が会話に鍵を貼れば外部記憶に残る（この設計の範囲外。README に注意を書く） |
| claude の側の記録 | `--mcp-config` を claude がどこかに書き残すかは確かめていない | 残っても center の口の URL だけ |

同じ user の process から鍵の file を読める事: center と session は同じ OS の user で動くため、session（とくに確認なしの permission の mode）が `mcp-secrets.json` を読めば鍵が見える。0600 では防げない。この設計で減らせるのは「意図せず見える」経路（env・引数・log・画面）までで、読もうとする session を止める境界ではない。強くするには分かれ目 2 の b（OS の鍵の保管庫）か、center を別の OS の user で動かす事が要る（後者は設置の形を変えるので範囲外）。system-instructions に「center の状態 dir の file を読まない」と書く事は手当てにならない（守らせる仕組みでないため）ので足さない。

### 7.2 中継の鍵 1 本で届く範囲が広い

- 直結の形で鍵を session に渡すと、session は中継の先の全 server の全道具に届く（`curl` で直接呼べる）。center の口の形なら、session が使えるのは `tools.allow` / `tools.deny` を通った道具だけ。
- 推奨: 中継の側でも鍵の届く範囲を絞ってもらう（6.2 の 4）。center の側では、`relay` のような汎用の接続は `tools.allow` を必須にする（allow が無い接続を `set` する時、役割 `memory` 以外なら「全部の道具が見える」と警告し、`--allow '*'` を明示した時だけ通す）。

### 7.3 道具の名前の衝突

- center の接続どうし: entry 名（接続名）が違えば `mcp__<接続名>__` で分かれる。同じ名前は作れない。
- 中継の中の server どうし: 前置きを剥がした後の重なりは 2.4 の規則（前置き付きを優先、log）。
- center の組み立てる物: 予約名で防ぐ。
- 個人の設定: 5.4 のとおり確かめていない。usage で避けるよう書く。

### 7.4 中継が落ちた時

- session の起動: 止めない。`--mcp-config` に載るのは center の口なので、中継が落ちていても claude は口に接続できる。口は `tools/list` に `mcp-status.json` の最後の写し（前回取れた一覧に絞り込みを当てた物）を返す（分かれ目 5）。写しが無ければ空の一覧を返す。道具を呼ぶと `unreachable` の error が返る。中継が戻れば次の呼び出しから通る（claude の側で session の再起動は要らない）。
  - 先の一覧が写しと変わった時に、口から `notifications/tools/list_changed` を送る。claude がこれを受けて一覧を取り直すかは確かめていない。取り直さない場合は、次の起動まで古い一覧のまま（呼ぶと先の error が返る）。
- 外部記憶の書き込み: 今のキューのまま（再試行、上限を超えたら古い分から捨てて log）。中継が落ちている間の event は lane に溜まり、上限を超えた分は失われる。捨てた件数は `mcp_connections_status` に出さない（画面に内部の数を出さない方針）。log だけ。
- `memory@1` の指示は「起動時に context / recall を呼ぶ」。呼んで error になった時、session は外部記憶なしで進む（指示を変えない。error の文は分類だけで、先の詳細は出ない）。
- 中継の応答が遅い時: 1 回の呼び出しは `timeoutMs`（既定 60 秒）で切る。口の `tools/list` は 5 秒で切って写しを返す（起動を待たせない）。

### 7.5 center の口を通す事で失う物と増える危険（R-06）

| | 今（session が外部記憶へ直接） | この設計（center の口を通す） |
|---|---|---|
| center が止まった時 | session も止まる（`daemon.ts:189`）。止まらずに残った場合も外部記憶は読める | session も止まる。外部記憶は口と一緒に使えない。center の crash の後に session が残る形は今も無いので、差は小さい |
| center が遅い・詰まった時 | 外部記憶の読みに影響しない | 外部記憶の読みが center の event loop を通る。口は先への呼び出しを await で待つだけで、center の他の処理を止めない形にする（同期の file 読みは mtime の cache の時だけ） |
| 同時の呼び出し | 外部記憶の側の並行 | 口は session ごと・接続ごとに並行。上限は 1 つの (session, 接続) あたり同時 8（越えたら待たせず `refused`） |
| 大きな応答 | claude が直接受ける | 口が 1 回 4 MB で切る（`protocol` の error）。今の request の本文の上限と同じ値 |
| stream | claude と外部記憶の間の SSE | 口は先の応答を JSON でも SSE でも受け、session へは 1 つの応答として返す（progress だけ途中で送る）。先との SSE の GET（server からの通知の stream）は開かず、一覧の変化は 10 分ごとの確かめと呼び出しの時に取り直して知る |
| 鍵 | session の env と、Bash の道具 | center の file だけ（同じ user からは読める。7.1） |
| 絞り込み | permissions だけ | 口で一覧から外し、呼んでも断る |
| 鍵の入れ替え | session の起動し直し | 次の呼び出しから |
| 失う物 | — | 先の server が出す resources / prompts / sampling などを session が使えない（道具だけ。4.3）。先が一覧の変化を通知しても、口が気づくまで最大 10 分遅れる |

### 7.6 その他

- session からの header の持ち込み: 口は session から来た `Authorization`・`X-Bantou-Session` を自分の認証にだけ使い、先へは渡さない。識別の header と同じ名前の header が session から来ても捨てる。
- 中継の応答の大きさ: 1 回の結果を 4 MB で切る（越えたら `protocol` の error）。center の memory 使用量を守るため。
- 外部記憶の `event` を session から隠す（2.5）。
- center が http で待ち受けていない時は接続を付けない（4.3）。

## 8. 実装のまとまり

review（R-03・R-04・R-19・R-20）で順と中身を直した。旧版の表は 12 章の R-03 に要点を残す。

| 順 | # | 名前 | 依存 | 変える package | protocol の版 | 中身 |
|---|---|---|---|---|---|---|
| 1 | M0 | 今の漏れを塞ぐ（status / log の `--mcp-config` を伏せる・`assertCenterOnly`） | fix branch の merge | center、center-client | 変えない | `redactAppendSystemPrompt` を `redactSessionArgs` に広げ、`--mcp-config` の値を `<mcp: 名前, …>` にする（status の `args` と log）。`assertNoMemory` を `assertCenterOnly`（`memory`・`mcp`・`mcpConnections`・`mcpSecrets`）に、web の `tool-policy.ts` も同じ。接続の設定はまだ無い |
| 2 | M1 | 接続の設定・鍵・command（list/get/set/unset/secret/test） | M0 | center | 変えない | `mcp-connections.ts`（形・検査・合成・保存・`resolveMemoryConnection` の形だけ）、`mcp-secrets.ts`、`mcp-status.ts`、`cli.ts` に `mcp` を足す、README。**session と書き込みの動きは変えない**。役割 `memory` の接続を `set` した時は「M4 の版の center まで外部記憶には使われない。今の外部記憶は `bantou-center memory` の設定」と表示する |
| 3 | M2 | 書き込みのキューを「送る時に解決する」形に（中身の入れ替えだけ） | M1 | center | 変えない | `memory.ts` の item を `{ 接続名, 識別の値 }` に、sink が送る時に URL・header・道具名・鍵を解決する（3.2）。**解決の元はまだ `memory-settings.json`**（直結の形として読む）。動きは今と同じ（test は今の物が通る + 鍵の入れ替えが溜まった分にも効く） |
| 4 | M3 | center の中継の口 `/mcp/conn/<名前>` と定期の確かめ | M1 | center | 変えない | `mcp-proxy.ts`（口の認可・先への client の key・redirect を追わない・鍵の rev での開き直し・絞り込み・前置き・識別の header・写しと設定の hash・error の分類・扱う MCP の機能（4.3））、`http.ts` に path と窓口ごとの上限（4.3）、daemon の起動時と 10 分ごとの確かめ。**session の `--mcp-config` にはまだ載せない**（口は test からだけ使われる） |
| 5 | M4 | 切り替え: 読みと書きを同時に接続へ・旧 memory の移行 | M2、M3 | center | 変えない | `resolveMemoryConnection` の元を `mcp-connections.json` に切り替え、session の起動（`wrapper.ts` の entry を口へ、`BANTOU_MEMORY_TOKEN` を外す、`bantouAllowRules`、`ctx.memory`）と書き込み（M2 の解決）を同じ版で切り替える。移行（5.4）、`bantou-center memory` の読み替え、改名・削除の付け替え |
| 6 | M5 | 画面の表示（読むだけ） | M1（M3 があれば reachable が埋まる） | center、center-client、ui | 変えない | `/mcp` に `mcp_connections_status`、center-client の許可の一覧と引数の検査に足す、設定ダイアログの「全 session 共通」に一覧（名前・役割・設定済み・つながるか・確かめた時刻）と定型の案内。古い center に当たった時は欄を出さない。desktop の Rust は変えない（1 章、`center_call` は素通し） |
| — | M6 | 名乗れる agent を鍵に結び付ける（任意） | なし | memory | 変えない | `MEMORY_TOKENS`、または中継が付ける識別の header の扱い。運用の答え（6.2 の 3・8）を見て決める |
| — | M7 | stdio の接続（後回し） | M3 | center | 変えない | 2.6 |

- protocol（`packages/protocol`、`MESSENGER_PROTOCOL 1.8.1`）は center と server の間の約束で、どのまとまりも触らない。server（remote-cap）も変えない（どちらも grep で `--mcp-config` と memory を扱っていない事を確かめた）。
- desktop の同梱の center: M0〜M4 は center だけの変更で、desktop の版を上げれば同梱の center も上がる。画面は M5 だけが変わる。古い desktop（古い画面）が新しい center に当たっても、新しい道具を呼ばないだけで壊れない。新しい画面が古い center に当たった時は `mcp_connections_status` が無いので欄を出さない。
- center の `/mcp` の道具が 1 つ増える（M5）。web の許可の一覧に足さないと web からは見えない。
- M2 と M3 は互いに依存しないので並べて作れる。M4 は 2 つが揃ってから。

**最初に出す物: M0**（旧版は M1。R-04）。理由: 今すでに外部記憶の URL と agent の ID が画面・web への応答に載っており（1 章）、要件「画面が知るのは center への経路だけ」に反している。直す範囲は小さく（引数の伏せ方と断る項目の一覧）、接続の設計のどの選択にも依らない。続く **M1** で「center が中継への接続を設定として持ち、つながるかを試せる」状態を作り、運用の側の準備（中継への外部記憶の登録・識別の header の受け渡し。6.2）と 13 章の実測を M1 の `test` で進める。LAN の外の center から外部記憶へ届くのは M4 から（旧版の「M2 で書き込みだけ中継経由」は、読みと書きが別の設定を見る期間を作るので採らない。R-03）。

M0 の task に書く注意:

- 基点は `fix/memory-setting-center-only` が develop に入った後。入っていなければ待つ（`assertNoMemory` と `memory-settings.ts` がその branch にある）。
- 伏せるのは status の `args` と center の log の両方（`remote-control.ts:522` の `shownArgs` は両方に使われる。1 か所で直す）。`--append-system-prompt` を伏せる今の動きを壊さない。
- `--mcp-config` の値は JSON。読めない時も値を出さず `<mcp: ?>` にする（例外で値を log に出さない）。
- 伏せた後に status の `args` から外部記憶の URL・agent の ID・`${…}` の参照が消えた事を、`rc_list` の応答を通した test で確かめる（`remote-control-wrapper.test.ts` の期待値を直す）。
- `assertCenterOnly` は null（削除）の指定も断る（今の `memory` と同じ。黙って捨てない）。web の `tool-policy.ts` と center の両方。断る文は「center を動かす host の command を使う」案内にし、項目の値を含めない。
- 変異の確かめ: 伏せる処理を外すと test が落ちる事。
- protocol・server・desktop の Rust・ui は触らない。

M1 の task に書く注意:

- 動いている session と書き込みの動きを変えない（`wrapper.ts`・`remote-control.ts`・`memory-events.ts` を触らない）。
- 鍵の文字列が command の標準出力・標準エラー・3 つの file（鍵の file を除く）のどこにも出ない事を、全出力を集めて検索する test で固定する。
- 状態 dir・file の mode、一時 file → rename、mtime の cache は今の `memory-settings.ts` に揃える。
- `test` の識別の値の既定 `bantou-center-test` で外部記憶に何も書かない事（`event` を呼ばない）を、偽の中継の記録で確かめる。

### 確かめ方

偽の中継を test で立てる（`packages/center/test/helpers/fake-relay.ts`）:

- node の http server + MCP の SDK の server（Streamable HTTP）。設定で鍵の header 名と形（`Authorization: Bearer <鍵>`、独自の header 名に `Bearer <鍵>`、値そのまま）を切り替えられる。server の選び方（path / header / 前置き）も切り替えられる。
- 道具: `memory-event`・`memory-recall`・`memory-context`・`search-find`・`admin-drop`（絞り込みの確認用）。前置きの無い `recall` と `memory-recall` の組も持つ（`toolPrefix` がある時に前置きの無い方が外れる事の確認。2.4）。
- 受けた request の header を記録する（識別の header の値、session から来た header が届いていない事の確認）。
- 「落ちている」「401 を返す」「遅い」「MCP として壊れた応答」を切り替えられる。

M0: status の `args` と log に `--mcp-config` の中身（URL・header の値・agent の ID・`${…}`）が出ない、`--append-system-prompt` は今どおり伏せる、`mcp` などの項目を画面・web から送ると断る。

M1:

- `set` / `get` / `list` / `unset` / `secret` の往復。検査（予約名・`{secret}` の数・`${`・鍵らしい固定の header・役割 `memory` が 2 つ）。
- `test` が偽の中継の 3 つの鍵の形で一覧を取れる。401・落ちている・遅い・壊れた応答で分類が正しい。
- 鍵の文字列が、command の標準出力・標準エラー・`mcp-connections.json`・`mcp-status.json` のどこにも出ない（全出力を集めて鍵の文字列で検索する test）。`--value` などを断る。
- file の mode が 0600。

M2: 今の test が変わらず通る。鍵の入れ替えの後、溜まっていた event も新しい鍵で送られる。順が崩れない（入れ替えの前後で同じ lane）。送る時に設定が無くなった item は捨てて log。log に鍵（独自の header 名の時も）が出ない。

M4（書き込み）: 偽の中継経由で event が `memory-event` に届き、識別の header が agent の ID になる。落ちている間は溜まり、戻ると送られる。読みと書きが同じ接続を使う（`--mcp-config` に載った接続と event の宛先が同じ）。

M3: 他の session にだけある接続・`null` にした接続に入れない（404）、別の (session, 接続) の `mcp-session-id` を使えない、窓口ごとの上限（`/mcp/conn` が混んでも `/mcp` の画面は入れる）、同じ (session, 接続) の initialize が古い MCP の session を閉じる、先の 3xx を追わない、sampling / elicitation を session へ送らない、cancel が先へ届く、写しの hash が違えば写しを返さない、一覧の絞り込みと前置きの剥がし、絞り込みで外した道具を呼ぶと断る、`event` が session から見えない、session から来た識別の header と鍵の header が先へ届かない、別の session の token では口に入れない、鍵の入れ替えが動いている口に次の呼び出しから効く、落ちている時に写しを返す、error の文に URL も鍵も出ない。

M4: `--mcp-config` に中継の URL・鍵・`${BANTOU_MEMORY_TOKEN}` が無い、役割 `memory` が 2 つの時に外部記憶なしで起動し書き込みも止まる、移行（旧形式 → `memory-settings.json` → 接続の順、既に接続がある範囲は残す、壊れた entry の件数の log、`.migrated` への rename、書けない時は何も変えず外部記憶なし）、`sessions.json` に `mcp` を手で入れても `--mcp-config` に出ない、env に `BANTOU_MEMORY_TOKEN` が無い（継承分も）、status の `args` と log の `--mcp-config` が伏せられている、`memory-settings.json` の移行（共通・session・鍵が違う session）、`bantou-center memory` の読み替え、改名で付け替わる。既存の `remote-control-wrapper.test.ts`・`memory-settings.test.ts`・`sessions.test.ts` を直す。

M5: center-client の test（許可の一覧と引数の検査）、desktop の e2e（設定ダイアログに一覧が出る、URL と鍵が画面に無い。e2e の mock の center に道具を足す）。

変異の確かめ（fix branch の report と同じやり方）: 鍵を伏せる処理・識別の header を捨てる処理・絞り込みを無効にすると、上の test が落ちる事。

## 9. 利用者から見た結果が変わる分かれ目

### 分かれ目 1: session への鍵の渡し方

- a. 直結（今の外部記憶と同じ）: session が中継へ直接つなぎ、鍵は session の env。
  - 見える物: session は中継の先の全道具に届く（絞り込みは permissions だけ）。鍵の入れ替えは session を起動し直すまで効かない。session の Bash から鍵が読める。center の作りは小さい。
- b. center の口を通す（**推奨**）: session は center の口につなぎ、鍵と agent の ID は center が付ける。
  - 見える物: session に見える道具は絞った物だけ。中継経由でも道具名は `mcp__memory__recall` のまま。鍵の入れ替えは動いている session にも次の呼び出しから効く。中継が落ちていても session は起動し、道具は前回の一覧で見える（呼ぶと error）。center の作りは大きくなる（M3）。
- 推奨の理由: 「秘密の値は center の側だけで扱う」という要件に合うのは b だけ。中継の鍵は外部記憶の鍵より届く範囲が広く、a で session の env に置く危険が今より大きい。

### 分かれ目 2: 鍵の置き場

- a. 状態 dir の 0600 の file（**推奨**）: 見える物: 今の `memory-settings.json` と同じ扱い。どの OS でも同じ。同じ user の process（session を含む）は読める。
- b. OS の鍵の保管庫: 見える物: macOS では session が読もうとすると確認の dialog が出る形にできる（確かめていない）。Linux では保管庫が無い・headless で使えない環境がある。設置の手順が増える。
- c. center の process の env: 見える物: 設置のたびに起動の仕組み（launchd / systemd）に鍵を書く。session に継承されないよう center が消す必要がある。
- 推奨の理由: center は desktop に同梱される場合と headless の場合があり、a はどちらでも同じ手順で動く。b は後から `auth.secret` の参照先を増やす形で足せる（形を変えずに済む）。同じ user から読める事は 7.1 に明記する。

### 分かれ目 3: `bantou-center memory` の扱い

- a. 残して内部で接続 `memory` に読み替える（**推奨**）: 見える物: 今の手順書・README の command がそのまま使える。中継経由に変える時だけ `bantou-center mcp` を使う。
- b. 置き換える（`mcp` だけにする）: 見える物: command が 1 系統になるが、fix branch で決めた手順が使えなくなる。
- 推奨の理由: fix branch が develop に入った直後で、手順を 2 回変えさせない。読み替えは小さい。

### 分かれ目 4: 中継経由の道具名

- a. 先の名前のまま（`mcp__memory__memory-recall`）: 見える物: 中継の前置きが道具名に残る。直結と中継で名前が変わり、`memory@1` の文面を接続ごとに作る必要がある。
- b. center の口で前置きを剥がす（**推奨**）: 見える物: どちらでも `mcp__memory__recall`。文面を変えない。
- 推奨の理由: 接続先を変えても session の振る舞い（指示・許可）が変わらない。分かれ目 1 で b を採れば追加の費用は小さい。

### 分かれ目 5: 中継が落ちている時の session の道具

- a. 前回の一覧の写しを見せる（**推奨**）: 見える物: 道具は見え、呼ぶと「つながらない」error。中継が戻れば同じ session のまま使える。
- b. 空にする / 口が error を返す: 見える物: その session ではずっと道具が無い（claude が一覧を取り直さない場合。確かめていない）。中継が戻っても session の起動し直しが要る。
- 推奨の理由: 一時的な停止で session を起動し直させない。

### 分かれ目 6: 画面に見せる範囲

- a. 名前・役割・設定済みか・つながるか・確かめた時刻・道具の数（**推奨**）。
- b. a + URL の host。見える物: どこへつないでいるかが画面で分かるが、内側の構成が画面の側に出る。
- 推奨の理由: 要件「画面が知るべきなのは center への経路だけ」。直すのは center の host の command なので、画面で host を知っても直せない。

### 分かれ目 7: 汎用の接続の絞り込み

- a. allow が無い接続は警告し、`--allow '*'` を明示した時だけ通す（**推奨**）。見える物: 中継の全道具を session に見せるには明示が要る。
- b. 何も言わずに全部見せる。見える物: 設定は短いが、中継に server が足されると session の道具が黙って増える。
- 推奨の理由: 7.2。

### 分かれ目 8: session の改名と agent の ID（review で足した）

- a. 今のまま（**推奨**）: `identity.value` を書いていない session は、改名すると新しい名前が agent の ID になる。見える物: 改名の前の記憶は新しい名前の session から読めない（今と同じ）。
- b. 改名の時に `identity.value` が無ければ旧名を書き込む: 見える物: 改名しても同じ記憶を読む。何度も改名すると最初の名前が残り、名前と ID がずれる。
- 推奨の理由: 今の動きを変えない。必要になれば `bantou-center mcp set memory --session <新> --identity <旧>` で同じ事ができる。

## 10. 確かめていない事

- claude が `--mcp-config` の entry と個人の設定の同名の entry のどちらを使うか。
- claude の Bash の道具が claude の process の env（`BANTOU_SESSION_TOKEN`・今の `BANTOU_MEMORY_TOKEN`）を継承するか（継承すると考えて設計した）。
- claude が `notifications/tools/list_changed` を受けて一覧を取り直すか。`tools/list` が失敗した MCP の server を session の途中で取り直すか。
- claude の道具名の上限（文字数・使える文字）。
- claude が `--mcp-config` の内容をどこかに書き残すか。
- 特定の中継が (A) 鍵の置き換え (B) 識別の header の受け渡し (C) 接続の使い回し時の header を満たすか（3.3）。中継ごとに運用の側に確かめてもらう。
- 中継が道具名に付ける前置きの形（中継ごとに違う。`toolPrefix` で表せない形（前置きでなく後置き、区切りの変換など）がありうる。その時は形を足す）。
- （review で確かめた）desktop の Rust の `center_call` は道具の名前を素通しする（1 章）。
- （review で確かめた）status の `args` は `rc_list`・`rc_start`・`rc_status` の応答に載り、web の許可の一覧にも入っている（1 章）。`packages/ui` が `.args` を表示しない事と、応答に載る事は別。M0 で伏せる。
- claude が閉じられた MCP の session（404）の後に initialize し直すか。起動時の initialize が 503 の server を、後で取り直すか（4.3）。
- 他の session の process の env が同じ user から読めるか（macOS）。
- fetch / MCP の SDK の client が、別の origin への redirect で独自の header を落とすか（4.3。追わない設計なので結果に依らない）。
- 中継の側の client ごとの MCP の session の上限。
- node の spawn の error の message が引数を含むか（4.4）。
- この設計の test・build はこの Mac で回していない（設計のみ）。

実装の前に実測が要る物は 13 章にまとめた。

## 11. review（2026-11-21）

対象: この文書の 507814760995797e96f99bb3269e4ca4cc0c8cb5 の版。突き合わせた code は origin/develop の 2009f18 と `fix/memory-setting-center-only` の 9f57726（packages/center・center-client・memory・protocol・server・desktop の `center_mcp.rs`）。この Mac では build・test を回していない。

### verdict

**条件付きで進めてよい**。方向（center が接続を設定として持つ・鍵は center の file・session は center の口を通す・外部記憶は役割つきの接続）は要件 3 つに合う。1 章の事実（file:行）は、ずれ 1 か所（`remote-control.ts:555` → 559）を除いて code と合っていた。ただし次の high 4 件は設計を直さないと実装で穴になるので、本文に反映した上で M0 から入る。

### 指摘

| ID | 重大度 | 指摘（事実は file:行、推測はそう書く） | 直し方 |
|---|---|---|---|
| R-01 | high | 口 `/mcp/conn/<名前>` の認可が token と session 名だけで、**その session に有効な接続か**を見る事が書かれていない。他の session にだけある接続や、session で `null` にした接続に、自分の token で届く | 合成後に有効な接続だけ通す。呼び出しのたびに判定。MCP の session を (session, 接続) に束縛（4.3） |
| R-02 | high | center の MCP の session の上限 32 は `/mcp` と `/mcp/session` で共有（`http.ts:36`、`499-501`）、放置 30 分で閉じる（`http.ts:34`）。口を足すと session × (1 + 接続数) で上限に当たり、initialize が 503 → その session は道具なし。外部記憶は 30 分以上呼ばれない事が普通で、閉じた後に claude が取り直すかは確かめていない | 窓口ごとの上限、同じ (session, 接続) の古い MCP の session を閉じる、放置の扱いを実測 E2 で決める（4.3） |
| R-03 | high | M2 を単独で出すと、書き込み（役割 `memory` の接続）と session の読み（`memory-settings.json`）が別の設定を見る期間ができる。移行は「`mcp-connections.json` に `memory` が無い時」だけなので、M1〜M3 の間に `mcp set memory` を使うと `memory-settings.json` の session ごとの値が黙って移されない。移行の失敗時に「旧 file を読む今の経路で動く」は、M4 で旧経路を外す事と矛盾 | 読みと書きを 1 つの解決の関数にし、元の切り替えは M4 で同時に（3.1、8 章）。移行の規則を書き直す（5.4） |
| R-04 | high | status の `args` は `rc_list` / `rc_start` / `rc_status` で画面・web へ返る（`tools.ts:268-298`、`remote-control.ts:425`、`tool-policy.ts:6-7`）。**今、外部記憶の URL（query 込み）と agent の ID が画面に出ている**。設計はこれを「確かめていない」とし、伏せる処理を M4 に置いていた | 事実として 1 章に書き、伏せる処理と `assertCenterOnly` を最初のまとまり M0 に前倒し（4.4、8 章） |
| R-05 | medium | 3.3「同じ center の session どうしは互いの agent を名乗れない」と 5.3「session から書き換えられない」は言い過ぎ。同じ OS の user の session は鍵の file・他の process の env（Linux の `/proc/<pid>/environ`。macOS は未確認）を読め、`bantou-center mcp` も動かせる | 守るのは「口からの操作と取り違え」までと書き直す（2.1、3.3） |
| R-06 | medium | center の口が単一の通り道になる事の比較（失う物・増える危険）が無い。同時の呼び出し・stream・大きな応答の扱いが散らばっている | 7.5 に比較の表 |
| R-07 | medium | 先への client の key が無い。SDK の transport は header を接続時に固定する使い方（`memory.ts:332-334`）なので、識別の header を session ごとに変えるには client を分ける必要。先への MCP の session 数が session × 接続数に増える | (接続, 識別の値, 鍵の rev) ごとの client、閉じ方、中継の上限の実測 E7（4.3） |
| R-08 | medium | 移行の失敗の扱い: 旧形式の移行（`sessions.ts:211-245`）との順が無い、読む時に黙って捨てる entry（`memory-settings.ts:34-39`）が移行で失われる、旧 file を消すと古い版の center へ戻せない、移行と改名で daemon が接続の file を書くのに 2.1 は「command だけ」 | 順・件数の log・`.migrated` への rename・2.1 の表を直す（2.1、5.4） |
| R-09 | medium | 一覧の写し（7.4）を返すには `inputSchema` などが要るが、5.2 で残すのは名前だけ。設定（前置き・絞り込み）を変えた後の古い写しを区別しない | 先の一覧そのものを設定の hash と一緒に残す（5.2） |
| R-10 | medium | 書き込みの鍵の入れ替え（4.5）: item は enqueue の時の token を持ち（`memory.ts:150-153`）、rev を lane の key に入れると新旧の lane が並んで走り順が崩れる。`redactReason` は `Bearer` と token の値しか伏せない（`memory.ts:132-137`）ので独自の header の鍵を伏せない | item は接続名と識別の値だけ持ち、送る時に解決（3.2、4.5） |
| R-11 | medium | 口が扱う MCP の機能（cancel・progress・先からの sampling / elicitation / roots・resources / prompts）が未定 | 道具だけ。cancel は先へ、progress は session へ、先からの request は断る（4.3） |
| R-12 | medium | 役割 `memory` が 2 つ以上の検査が `set` だけ。手で直した file や共通の `set` と session の接続の重なりの実行時の扱いが無い | 実行時は外部記憶なし + `config-error`。`set` は全 session の合成後も検査（3.1） |
| R-13 | medium | `tools.deny` を明示すると既定の `event` の deny が消える（2.5）。`--deny <別の道具>` で書き込みの道具が session に出る | 役割 `memory` では常に外し、出すには専用の指定（2.5） |
| R-14 | medium | 先の redirect を追うと、独自の header 名の鍵が別の host へ届く（推測）。`http:` の URL で鍵を平文で LAN の外へ送れる | redirect を追わない。`http:` で公の address なら明示の指定を要する（2.2、4.3） |
| R-15 | low | 鍵の名前の形が無い。`memory.<s>` は接続名の形に合わず、session 名は大文字・64 文字 | `[A-Za-z0-9._-]{1,100}`（2.2） |
| R-16 | low | `auth.format`・`headers` の値の CR / LF・制御文字の検査が無い（header の差し込み） | 断る（2.2） |
| R-17 | low | 2.4 の衝突の規則（前置き付きを優先）は、`toolPrefix` で前置きの付いた道具だけに絞る 2.3 と食い違う | 前置きがある時は前置き付きだけ（2.4） |
| R-18 | low | 書き込みの上限は今 15 秒（`memory.ts:315`）。接続の `timeoutMs` の既定 60 秒を書き込みに使うと変わる | `min(timeoutMs, 15 秒)`（3.2） |
| R-19 | low | daemon の 10 分ごとの確かめがどのまとまりにも無い | M3 に入れる（5.2、8 章） |
| R-20 | low | 更新の入力は `.passthrough()`（`project-settings.ts:115-123`）なので、断る項目の一覧は保証にならない | 保証は「`mcp-connections.json` だけを読む」事と書き、test で固定（5.3） |
| R-21 | low | 6.1「同じ host の loopback」は、bind が特定の address の時は LAN の address になる（`daemon.ts:65-69`、`http.ts:76-86`） | 書き直す（6.1） |
| R-22 | low | 1 章の行のずれ: `remote-control.ts:555` は spawn 失敗の log で、引数の log は 559。章の番号の誤り（4.1 の「8 章の危険」→ 7 章、5.2 の「8.4」→ 7.4、6.1 の「8 章」→ 7 章、3.3 の「7 章のまとまり」→ 8 章） | 直した |
| R-23 | info | 内部の情報（IP・port の実値・host 名・domain・user 名・mail address・token・特定の中継の製品名）は本文に無い。中継は `<中継>` と header 名の置き場所で書かれ、特定の製品に決め打ちしていない | 変更なし |

要件ごと:

- 外部記憶の操作を MCP の道具で行い、center がその接続の仕方を設定として持つ: 満たす（2 章、3 章）。
- 画面が知るのは center への経路だけ、秘密は center の側だけ: 設計の後は満たす。ただし今の版は R-04 で破れているので M0 を先に出す。
- 中継を通して LAN の外から外部記憶に届く、鍵を入れ替えられる: 満たす（6 章、4.5）。中継の側の (A)〜(C)（3.3）が前提で、M1 の `test` と 13 章の E8 で確かめる。

## 12. review の反映

| ID | 採否 | 直した節 |
|---|---|---|
| R-01 | 採った | 4.3（口の認可）、8 章の M3 の test |
| R-02 | 採った（放置の扱いは E2 の結果で決める。口を stateless の MCP にする案は、session へ `tools/list_changed` を送れなくなるので採らない） | 1 章、4.3（口の MCP の session の数）、13 章 E2・E3 |
| R-03 | 採った | 3.1、5.4（移行）、8 章（M2 は中身の入れ替えだけ、切り替えは M4 で同時に。旧版の M2「center の書き込みを接続経由に（無ければ `memory-settings.json`）」は外した） |
| R-04 | 採った | 1 章、4.4、5.3、8 章（M0 を新設し最初に出す） |
| R-05 | 採った | 2.1、3.3 |
| R-06 | 採った | 7.5（新設。旧 7.5 は 7.6 へ） |
| R-07 | 採った | 4.3（先への client） |
| R-08 | 採った（旧 file は消さず rename。古い版へ自動で戻す仕組みは作らない。古い版の center は新しい file を読まないので、戻す時の手順を README に書くだけにする） | 2.1、5.4 |
| R-09 | 採った | 5.2 |
| R-10 | 採った | 1 章、3.2、4.5、8 章の M2 |
| R-11 | 採った | 4.3（口が中継として扱う物）、7.5 |
| R-12 | 採った | 3.1、5.3 の `reachable` |
| R-13 | 採った | 2.5 |
| R-14 | 一部採った（`http:` は断らず、公の address で `auth` がある時に明示の指定を要する形にした。LAN の中の外部記憶への直結は今 `http:` で動いているため） | 2.2、4.3 |
| R-15 | 採った | 2.2 |
| R-16 | 採った | 2.2 |
| R-17 | 採った | 2.4、8 章の偽の中継 |
| R-18 | 採った | 3.2 |
| R-19 | 採った | 5.2、8 章の M3 |
| R-20 | 採った | 5.3、8 章の M4 の test |
| R-21 | 採った | 6.1 |
| R-22 | 採った | 1 章、3.3、4.1、5.2、6.1 |
| R-23 | 変更なし | — |
| （分かれ目 8） | 足した | 3.1、9 章 |

## 13. 実装の前に実測が要る物

どれも center の外（claude・OS・中継）の挙動で、code を読んでも分からない。この Mac の動いている app・center・session では測らない。使い捨ての test 用の host か、偽の MCP の server（8 章の `fake-relay.ts` と同じ物を単独で起動）で測る。

| # | 何を | なぜ（決まる物） | 確かめ方 | いつまで |
|---|---|---|---|---|
| E1 | `--mcp-config` の entry と、user / project の scope の同名の entry のどちらを claude が使うか | 予約名・usage の書き方（5.4） | 偽の server を 2 つ（応答で区別できる道具名）立て、同じ名前で両方に登録して起動し、`/mcp` の一覧と呼んだ先の記録を見る | M4 の前 |
| E2 | 口が MCP の session を閉じた（次の request が 404）後に、claude が initialize し直すか | 口の放置の扱い（4.3）。`/mcp/session` にも効く | 偽の server の放置の上限を 1 分にし、1 分あけて道具を呼ぶ。偽の server の記録で 2 回目の initialize があるか、claude の側に error が出るかを見る | M3 の前 |
| E3 | 起動時の initialize が 503 / 接続できなかった server を、claude が後で取り直すか。`notifications/tools/list_changed` で一覧を取り直すか | 上限の決め方（4.3）、分かれ目 5、7.4 | 偽の server を最初の initialize だけ 503 にする / 起動の後に一覧を変えて通知を出す。`/mcp` の表示と記録を見る | M3 の前 |
| E4 | claude の道具名の上限（`mcp__<接続名>__<道具名>` の文字数・使える文字）と、越えた時の動き | 2.4 の見せる規則 | 公式の docs を読み、偽の server で 64 文字前後の道具名を出して呼べるかを見る | M3 の前 |
| E5 | 同じ user の別の process の env が読めるか（macOS の `ps eww` 相当、Linux の `/proc/<pid>/environ`）。claude の Bash の道具が claude の env を継承するか | 3.3 と 7.1 の書き方。分かれ目 2 の判断の材料 | test 用の host で、目印の env を持つ process を起動し、別の shell から読めるかを見る。claude の Bash で `env` に目印が見えるかを見る | M4 の前（設計の結論は変わらない見込み。書き方を直すため） |
| E6 | claude が `--mcp-config` の中身をどこかに書き残すか | 7.1 の表 | test 用の host で目印の文字列を含む `--mcp-config` で起動し、利用者の claude の dir を目印で grep する | M4 の前 |
| E7 | 使う中継の、client（鍵）ごとの MCP の session の上限と、放置で閉じるまでの時間 | 先への client の数と閉じ方（4.3） | 運用の側に聞く（6.2）。M1 の `test` を並べて動かし、上限の error が出る数を見る | M3 の前 |
| E8 | 使う中継が 3.3 の (A) 鍵の置き換え (B) 識別の header の受け渡し (C) 接続を使い回す時も request ごとに header が付くか | 中継経由の外部記憶が使えるか | M1 の `bantou-center mcp test` を、識別の値を 2 つ変えて同じ鍵で動かし、外部記憶の `status`（読むだけ）の応答が agent ごとに違う事を見る。外部記憶の側の log で `X-Agent-Id` を見る | M4 の前（M1 の後すぐ） |
| E9 | 中継の道具名の前置きの形（`toolPrefix` で表せるか） | 2.3、2.4 | M1 の `test` で一覧を取って見る | M4 の前 |
| E10 | fetch（MCP の SDK の client の transport）が redirect をどう扱うか、`redirect: "manual"` を transport に渡せるか | 4.3 の「追わない」の作り方 | 偽の server で 307 を返し、先の記録に独自の header が届くかを見る（unit test で足りる） | M3 の実装の中 |
