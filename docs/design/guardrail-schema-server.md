# guardrail の設定（openspec 向け schema 定義の追加）と、center が内蔵する schema の MCP server の設計

- 作成: 2026-11-23
- 基点: `develop` 4d98817（0.1.62）
- 範囲: 設計だけ。code・test・設定は変えていない。
- 書き方: 【事実】は repo の code / docs を開いて確かめた事（`file:行`。repo root からの path）。【推測】は確かめていない解釈。【未確認】は実測・他 project の決定が要る事。決まっていない点は「未決 #N」（6 節）。
- 関係する設計: `docs/design/center-graphql-server.md`（`origin/docs/center-graphql-server`。進行中の center の設計。設定は全部 client から変えて center の host に保存する。この設計はそれに合わせる）、`docs/design/project-settings.md`、`docs/design/center-tools.md`。

## 0. 利用者の指示（原文）と、この設計の範囲

> openspec-mcp自体をhttp streamで単独起動出来るようにする。openspec-mcpに対して、schema-discoveryをヘッダー情報として設定を受け入れるようにする。schema-discoveryはmcp-serverの設定を入れられる形でプロトコルを設計。schema-discoveryのプロトコルとして、/schemas/[schema-name]で、schemaの中身を問い合わせ出来る形にする。
> bantouは、schema-discoverプロトコルに則ったmcp−serverを新規に内蔵する。bantou-centerはopenspec-mcpのschema-discoveryに自分のschema−mcp−serverの情報をセットしてつなげる。
> bantou側は新たにgardrail設定機能で、openspec向けのschema定義を任意に追加する機能を入れる

### 持ち分

- **openspec-mcp の側**（http stream での単独起動、schema-discovery を header で受ける事、schema-discovery のプロトコルの設計）は、openspec-mcp の project が設計する。**この設計書では設計しない**。プロトコルは未確定。header 名・header の値の形・応答の形・`/schemas/[schema-name]` の応答の中身は、この設計書で決めない。それに依る所は「openspec-mcp のプロトコルが出てから決める」と書く（以下 `【プロトコル待ち】`）。
- **bantou の側**（この設計書で書く）: (1) center が内蔵する schema の MCP server、(2) center が openspec-mcp の schema-discovery に自分の schema の MCP server の情報を入れてつなぐ流れ、(3) guardrail の設定（openspec 向けの schema 定義を任意に足す機能）。

### 背景（前提。この設計の対象ではない）

- bantou の server は、worker を起こすだけの仕組みに寄せる方向。server は openspec-mcp を機械的に実行し、門（gate）が開いたら次の worker を起こす。remote-cap の判断の層は無くす方向。**この設計は remote-cap の廃止をしない**。関係だけ: この設計の schema の定義（3 節）は、openspec-mcp が機械的に進める流れの「何を終了条件にするか」を、bantou の利用者が足せるようにする物。
- review は、openspec の schema の tasks の終了条件に「review の指摘 0 件」を置く。worker は openspec の instruction に従い、その条件を終了にする前に、サブエージェントの reviewer を起こす。0 件の数え方は、機械的に判定できる基準に当たる指摘が 0 件（仕様・決定と食い違う／test が落ちる・足した test が変異で落ちない／指示した範囲の外を変えている）。**この終了条件は schema の中身**で、guardrail の設定が運ぶ物の例。bantou 側の code は終了条件の中身を解釈しない（3.3 の「中身を解釈しない」）。
- 用語の注意: 【事実】bantou には過去に「guardrail」があった（plugin の hooks `guard.mjs` と `docs/guardrail.md`）。2026-10-31 に廃止済み（`docs/history/20261031-1700-retire-guardrail/report.md`）。この設計の「guardrail 設定」は、それとは別の新しい機能（利用者の指示の「gardrail設定機能」）で、hook の仕組みは戻さない。

## 1. 今の形

### 1.1 openspec との今の関係

- 【事実】bantou の code（`packages/` 配下の `.ts` `.vue` `.md`）は、openspec を呼ばない・知らない。`openspec` を含むのは `packages/desktop/e2e/seed.ts:22` の画面確認用の task の題（"openspec change 一覧画面"）と `packages/desktop/fixtures/demo-ws/openspec change 一覧画面.md` だけ（grep で確かめた）。`schema-discovery` を含む file は無い。
- 【事実】worker に渡る指示の置き場は `packages/server/instructions/worker.md`・`remote-cap.md`、center 側は `packages/center/instructions/common.md`・`master-cap.md`。いずれにも schema の語は無い。
- したがって「今 bantou が openspec-mcp とつながる口」は無い。この設計が足す。

### 1.2 center の MCP

- 【事実】center の http server は `packages/center/src/http.ts`。path は定数 `MCP_PATH = "/mcp"`（外向け。Bearer token。`http.ts:15`、判定 `http.ts:400`）、`EVENTS_PATH = "/events"`（SSE。`http.ts:17`、`http.ts:418`）、`SESSION_MCP_PATH = "/mcp/session"`（master-cap 向け。session token。`http.ts:18`、`http.ts:407`）。ほかに `/sessions/<n>/…`（`http.ts:30-32`）。
- 【事実】MCP の tool は `packages/center/src/tools.ts` の `registerTool(`（center 共通の設定は `center_settings_get` / `center_settings_update`、`tools.ts:179-200`）。
- 【事実】center は他の MCP の server を session の claude に足す仕組みを既に持つ。center 共通の設定の `mcpServers` が全 session の `--mcp-config` に載る。形は Claude Code の mcp.json の 1 件と同じ（stdio は command・args・env、http は `type`・`url`・`headers`）で、書いた項目は手を加えずに渡す（`packages/center/src/mcp-server-def.ts` の `McpServerDef`、`serverDefIssues`）。画面の入力欄は `packages/ui/components/ProjectSettingsFields.vue:175-183`。
- 【事実】center 自身が「他の MCP client に向けて公開する MCP server」は上の `/mcp` と `/mcp/session` の 2 つで、schema を返す物は無い。

### 1.3 設定の持ち方・保存先

- 【事実】center 共通の設定は、center の状態 dir の `center-settings.json`（1 つの JSON object）。`createJsonObjectStore`（`packages/center/src/store.ts`。書込は tmp + rename、mode 0600）で読み書きする（`packages/center/src/daemon.ts:173`）。session ごとの設定は `sessions.json` の各 session の `settings`。
- 【事実】設定の更新は項目ごとのマージ。書いた項目だけ変わり、`null` で項目を消す。既知の項目は検証し、未知の項目は JSON のまま保持して中身を解釈しない（`docs/design/project-settings.md` の決定 2・4、`packages/center/src/project-settings.ts`）。共通の設定の更新は `center_settings_update`（`centerSettingsPatchSchema`、`project-settings.ts:219`、`passthrough`）。
- 【事実】`mcpServers`・`memory` は、center を起動した所（launcher）からだけ書ける（`tools.ts:189-200`）。center は `center-settings.json` を呼び出しの度に読み直す（`packages/center/src/mcp-source.ts` の `createMcpSource`。mtime / size / inode が変わった時だけ読む）。
- 【事実】今の設定の画面は `packages/ui/components/SettingsDialog.vue`（center 共通）と `ProjectSettingsDialog.vue` / `ProjectSettingsFields.vue`（session ごと）。

### 1.4 center の今後の形（進行中。この設計の前提）

`docs/design/center-graphql-server.md`（`origin/docs/center-graphql-server`）の決定による（この設計はそれに合わせるだけで、決めない）:

- center は GraphQL の endpoint（`/graphql`【案】）を持つ backend の server になる。client（desktop・web）はそれを叩く。
- 設定は全部 client の画面から変えられ、保存先は center の host（同設計 2.4 の「設定の保存先は center の host」）。
- center の起動の形は (a) desktop 専用と (b) server（bantou-center）の 2 つ。center の中身は同じ。

## 2. 変えた後の形（全体）

```
client（desktop / web）                      …… 設定の画面（guardrail の設定を足す・見る）
   │  GraphQL（center-graphql-server の設計）
   ▼
center（bantou-center。(a)(b) 共通）
   ├ guardrail の設定（openspec 向けの schema 定義の一覧）  … center の host に保存（3.2）
   ├ schema の MCP server（新規・内蔵）                    … /schemas/[schema-name] で定義の中身を返す（3.1）
   └ openspec-mcp への接続                                  … 起動の時に schema-discovery に自分の schema の MCP server の情報を入れる（4 節）【プロトコル待ち】

openspec-mcp（別 project。http stream で単独起動。schema-discovery を header で受ける）
   └ 受けた schema の MCP server に /schemas/[schema-name] を問い合わせて schema の中身を得る【プロトコル待ち】
```

- guardrail の設定が「何を持つか」= schema 定義の一覧。schema の MCP server が「何を返すか」= その一覧のうち問い合わせられた 1 つの中身。center が「どうつなぐか」= openspec-mcp の schema-discovery に schema の MCP server の情報（アドレス）を入れる。
- 利用者が決めていない事（認証の細部・版管理・他の機能）は足さない。

## 3. bantou の側（この設計で決める事）

### 3.1 schema の MCP server（center に内蔵）

- **置き場**: center の中（`packages/center/src/` の新しい module）。center の http server（1.2）に、schema-discovery のプロトコルに則る口を足す。利用者の指示の「`/schemas/[schema-name]` で schema の中身を問い合わせ出来る」が、その口の path。置き場の細部（既存の `/mcp` 等と同じ http server・同じ port に載せるか、別の port か）は未決 #1。
- **返す物**: guardrail の設定（3.2）にある schema 定義のうち、`[schema-name]` が一致する 1 件の中身。無い名前は「無い」と返す（応答の形は【プロトコル待ち】）。
- **返さない物**: center の他の設定・session・token など。schema の MCP server は guardrail の設定の中の schema 定義だけを返す。
- **MCP の「内蔵」の意味**: 利用者の指示は「schema-discovery のプロトコルに則った mcp-server」。MCP の tool として持つ形か、`/schemas/…` の HTTP の口だけの形かは、プロトコルが決める【プロトコル待ち】。bantou 側は、プロトコルが決めた形に合わせて実装する。
- 既存の `/mcp`・`/mcp/session` とは別の窓として扱う（同じ token で他の tool に届かない）。認証の中身はこの設計で決めない（利用者の指示に無い。#2 は「どこまで center の鍵に載せるか」を問うだけ）。

### 3.2 guardrail の設定（openspec 向けの schema 定義を任意に足す）

- **持つ物**: schema 定義の一覧。1 件は「名前（`[schema-name]` になる）」と「定義の中身」。
- **設定の持ち方**: center 共通の設定（1.3 の `center-settings.json`）の新しい項目として持つ。既知の項目として検証し、定義の中身は解釈しない（1.3 と同じ規則。`project-settings.md` の決定 2）。名前は英数字と `_` `-`（center の他の名前の規則と同じ。`packages/center/src/config.ts` の `NAME`、`mcp-server-def.ts` の `SERVER_ENTRY_NAME` と同形）。同じ名前は 1 つ。項目名・項目の形は未決 #3 の案で決める。
- **更新**: 今の設定と同じ規則（項目ごとのマージ、`null` で消す）。center 共通の設定の更新の口（`center_settings_update`。GraphQL では `updateCenterSettings`）に載せる。専用の口は足さない（`project-settings.md` の決定 4 の比較: 項目ごとの tool は増えるので採らない）。
- **保存先**: center の host の `center-settings.json`（1.3）。client に保存しない（center-graphql-server の設計に合わせる）。定義は center が呼び出しの度に読み直すので、足した定義は center の再起動なしで schema の MCP server から返る（`mcp-source.ts` と同じ読み方。【推測】同じ読み方を使えば足りる。実装で確かめる）。
- **画面での足し方**: 設定の画面（`SettingsDialog.vue`。今の center 共通の設定の画面）に「guardrail」の欄を足す。一覧（名前）・追加・編集・削除。定義の中身は text の入力（`ProjectSettingsFields.vue:175-183` の `mcpServers` の入力欄と同じ向き: 書いた物をそのまま保存する）。画面は client の設定の画面なので、desktop・web とも同じ画面（`packages/ui`）。center の設定は全部 client から変えられる、という center-graphql-server の決定に従い、launcher からだけ書ける形にはしない（その決定の #6 に従う）。
- **定義の中身**: openspec の schema の定義。bantou は中身を解釈せず、そのまま保存して返す（3.1）。形（1 つの text か、複数の file か）は openspec の schema の形に依る【未確認】。未決 #4。

### 3.3 「中身を解釈しない」の範囲

- bantou は schema の中身（終了条件・「review の指摘 0 件」の定義を含む）を検証も解釈もしない。openspec が schema をどう読むかは openspec-mcp の側。bantou が検査するのは名前の形と、保存・返却のために必要な最低限（空でない、など。細部は実装の task で決める。利用者が決めていない上限・数値は足さない）だけ。

## 4. center が openspec-mcp につなぐ流れ

利用者の指示: 「bantou-center は openspec-mcp の schema-discovery に自分の schema-mcp-server の情報をセットしてつなげる」。

1. center は、openspec-mcp へ接続する時に、schema-discovery（header で受ける設定）に、自分の schema の MCP server の情報（3.1 のアドレス）を入れる。
2. openspec-mcp は、その情報を使って schema の MCP server に `/schemas/[schema-name]` を問い合わせる【プロトコル待ち】。
3. 利用者が guardrail の設定に schema 定義を足すと、次の問い合わせから返る（3.2。center の再起動は要らない見込み）。

- **【プロトコル待ち】で決めない物**: header の名前、header に入れる「mcp-server の設定」の形、schema の MCP server の情報として何を入れるか（アドレスだけか、他も要るか）、`/schemas/[schema-name]` の応答の形、openspec-mcp が schema の MCP server に何を問い合わせるか。プロトコルが出てから、この設計書の 3.1・4 節を更新する。
- **center が openspec-mcp のアドレスをどこに持つか**・**誰が openspec-mcp につなぐか**は、利用者の指示にあるのは「bantou-center がつなげる」まで。細部は未決 #5。
- 【事実】center の設定の `mcpServers` は、http の MCP server の `url` と `headers` を持てる（1.2）。openspec-mcp の接続先を `mcpServers` の 1 件で持てるかは、schema-discovery が header の形に依るので【プロトコル待ち】。#5 の案 A の前提。

## 5. 実装の分け方

center-graphql-server の段階（A: GraphQL、B: client の差し替え、…）と独立に、足すだけで進められるようにする。順に:

| 段 | 内容 | 前提 |
|---|---|---|
| S1 | guardrail の設定の項目を center 共通の設定に足す（検証・保存・読み直し・マージ更新・消去）。`packages/center/src/project-settings.ts` と `center-settings.json` | #3 の決定 |
| S2 | schema の MCP server（center に内蔵）。`/schemas/[schema-name]` の口 | #1 の決定と、**openspec-mcp のプロトコル** |
| S3 | 画面（`SettingsDialog.vue` に guardrail の欄。一覧・追加・編集・削除） | S1。center-graphql-server の段階 B（GraphQL の client）の後なら GraphQL、前なら今の `center_settings_update` の経路（どちらも同じ設定の項目を使う） |
| S4 | center が openspec-mcp につなぐ時に schema-discovery を入れる | #5 の決定と、**openspec-mcp のプロトコル** |
| S5 | docs の改訂（`docs/architecture.md` の center の項に、schema の MCP server と guardrail の設定を足す） | S1〜S4 |

- S1 と S3 は、プロトコルが出なくても進められる（設定と画面は、プロトコルに依らない）。S2・S4 はプロトコルが出てから。
- 並行できる単位: S1 と S3 は file が別（center と ui）。S2 は S1 の読み出しの関数を使う。

## 6. 未決（番号つき。各案と推奨）

利用者の指示から出てくる点だけを載せる。

**#1 schema の MCP server を center のどの口に載せるか**
- 案 A: center の既存の http server に、新しい path（`/schemas/[schema-name]`）として足す（同じ port）。
- 案 B: schema の MCP server 専用の port を別に持つ。
- 推奨: A。理由: center は今も 1 つの http server で `/mcp`・`/events`・`/mcp/session` を出しており（`http.ts:15-18`）、path を足すだけで済む。利用者の指示も「`/schemas/[schema-name]` で」と path の形で書いている。port を増やすと center-graphql-server の「center の port は 1 つ・設定で決まる」（同設計 2.8）と合わない。ただし schema-discovery のプロトコルが別の形を求めたら、プロトコルに合わせる【プロトコル待ち】。

**#2 schema の MCP server を center の鍵（center-graphql-server 2.4）の対象にするか**
- 案 A: 対象にする（鍵が無い通信は受け付けない）。
- 案 B: 対象にしない（`/schemas/…` は鍵なしで返す）。
- 推奨: A の方向だが、openspec-mcp がどの形の認証を header で運べるか（schema-discovery の header の形）に依るので、プロトコルが出てから決める【プロトコル待ち】。利用者の指示に認証の話は無いので、この設計では細部を決めない。

**#3 guardrail の設定を center-settings.json のどこに持つか**
- 案 A: center 共通の設定（`center-settings.json`）の新しい項目として持つ（1.3 の仕組みにそのまま載る）。
- 案 B: 専用の file（例: 状態 dir の別の file）に持つ。
- 推奨: A。理由: 設定は全部 client から変えて center の host に保存する、という center の形（1.3・1.4）に既に載っており、更新の口・検証・読み直し（`mcp-source.ts`）が揃っている。案 B は専用の更新の口と読み直しを足す事になる。項目名・形の細部（名前をキーにした object か、`{ name, … }` の配列か）は、実装の task で決める（`mcpServers` が名前をキーにした object なので、それに揃えるのを推奨）。

**#4 schema 定義の「中身」の持ち方**
- 案 A: 1 つの text（openspec の schema の定義 1 つ分）。
- 案 B: 複数の file のまとまり（定義の file と、それが参照する file）。
- 推奨: openspec の schema の形が分かってから決める【未確認】。bantou は中身を解釈しないので（3.3）、どちらでも保存・返却はできる。画面は案 A の方が簡単。openspec の schema が複数 file を必要とするなら案 B。

**#5 center が openspec-mcp につなぐ形（接続先の持ち方と、誰がつなぐか）**
- 案 A: openspec-mcp の接続先を、center の設定の `mcpServers` の 1 件（http の `url` と、schema-discovery を載せる `headers`）として持つ。session の claude に渡す MCP の仕組み（1.2）をそのまま使う。
- 案 B: center が、guardrail の設定（3.2）の一部として openspec-mcp の接続先を持ち、center の中から openspec-mcp につなぐ。
- 推奨: openspec-mcp のプロトコル（schema-discovery を載せる header の形）が出てから決める【プロトコル待ち】。header で受けるのが決まっているので、`headers` を持てる A が使える見込みだが、header の値が「mcp-server の設定」の入る形（利用者の指示）なので、既存の `headers`（文字列の値）に載るかは未確認。

## 7. test の観点

code は書かないので、実装の task が足す test と、実測の一覧。

**test（実装が足す）**

- guardrail の設定: 足す・読む・マージ更新・`null` で消す・同じ名前の重複・名前の形の検査（`packages/center/test/project-settings.test.ts` と同じ流儀）。未知の項目が消えない（既存の性質を壊さない）。壊れた `center-settings.json` で fail closed（`mcp-source.ts` と同じ扱い。`packages/center/test/mcp-assign.test.ts` の流儀）。
- schema の MCP server: 足した定義が `/schemas/[schema-name]` で返る。無い名前は「無い」と返る。定義を足した直後・消した直後が、center の再起動なしで反映される。他の設定（token・session など）が応答に出ない。応答の形の test は【プロトコル待ち】。
- 画面: guardrail の欄の追加・編集・削除（`packages/ui/test/`）。desktop・web とも同じ画面で動く。
- つなぎ: center が openspec-mcp につなぐ時に、schema の MCP server の情報が入る【プロトコル待ち】。
- 既存の center の test（`packages/center/test/*.test.ts`）が全部通ったまま（足すだけの変更）。

**実測（実機。値は測って書く）**

- openspec-mcp（http stream で単独起動した物）が、center の schema の MCP server から schema を得て、その schema で動く事【プロトコル待ち】。
- guardrail の設定に足した schema が、次の問い合わせから返る事（再起動なし）。
- 「review の指摘 0 件」を終了条件に書いた schema を足し、openspec-mcp の流れで実際に使える事【プロトコル待ち】。

## 8. 次にやる事

1. 利用者が、未決 #1・#3・#4・#5 を決める（#2・#5 の一部はプロトコル待ち）。
2. openspec-mcp の project が schema-discovery のプロトコルを出す。出たら、この設計書の 3.1・4 節と #1・#2・#5 を更新する。
3. プロトコルを待たずに進められる S1（設定の項目）・S3（画面）を先に始められる。
