# desktop 署名 identity 固定（fix/signing-identity）

## 結論

- 原因: ad-hoc 署名は版ごとに code identity が変わる。Local Network の許可は code signature で app を追跡するため、更新で許可が引き継がれない。
- 対策: 自己署名の code signing 証明書で署名（release は `~/.config/bantou/signing-identity` から `APPLE_SIGNING_IDENTITY` を渡す）。証明書が無ければ従来の ad-hoc。
- **未確認（最重要）**: 自己署名 identity で Local Network の許可が更新をまたいで実際に保たれるか。Apple の文書は Apple-issued identity を勧めるのみ。mac での実機確認が必要（手順は `docs/ops/desktop-signing.md` §6）。保たれなければ Developer ID が必要。

## 調査（根拠）

1. Apple TN3179（Understanding local network privacy）
   - 「Local network privacy tracks the identity of your program using its code signature. This presents a challenge on macOS, which allows for unsigned code and ad hoc signed code … To ensure that local network privacy reliably tracks the identity of your macOS program, sign it with an Apple-issued code-signing identity.」
   - macOS は responsible code（helper が LAN 接続しても親 app）に対して許可を記録・表示する → center・node が bantou.app 配下なら許可は bantou.app 単位。
   - 許可は macOS 15 で導入。user account ごと。macOS 15.5+ の `AllowedWiFiLocalNetworkAddresses` / `AllowedEthernetLocalNetworkAddresses`（`sudo defaults write com.apple.network.local-network`、再起動要）で特定 LAN を対象外にできる（host 全体設定。今回は採用せず）。
   - 「Making an outgoing TCP connection」は local network access が必要。チェックは networking stack の深部で行われ全 API に適用される（Terminal・ssh 配下の command-line tool と launchd daemon は自動許可 → curl が通る事と整合）。
   - https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy
2. Apple TN3127（Inside Code Signing: Requirements）
   - 「Ad hoc signed code … has a DR but it's tied to that specific version of the code. In both cases macOS can't reliably track the identity of the code.」
   - DR は「更新で 1.2→1.3 を同じ code と判定する」ための基準。`codesign --display -r -` で見える。
   - https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements
3. Apple Code Signing Requirement Language（archive）
   - ad-hoc: 「there are no certificates at all … An ad-hoc signature does not use or record a cryptographic identity, and thus identifies exactly and only the one program being signed.」
   - 自己署名: 「If the code was signed by a self-signed certificate, the leaf and root refer to the same single certificate.」
   - https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/RequirementLang/RequirementLang.html
   - 自己署名の既定 DR が何になるか（`certificate leaf = H"…"` 等）は、この文書には書かれていない＝**未確認**（codesign man 未取得）。
4. Apple Code Signing Guide: Procedures — 自己署名証明書の作成（Certificate Assistant: Self Signed Root / Code Signing / override defaults）。「Do not ship apps signed by self-signed certificates … the user can only verify that two versions of your application came from the same source」。
   - https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html
5. Tauri v2
   - 環境変数: 「APPLE_SIGNING_IDENTITY: The identity used to code sign. Overwrites `tauri.conf.json > bundle > macOS > signingIdentity`.」https://v2.tauri.app/reference/environment-variables/
   - コード（tauri-cli `interface/rust.rs`、dev branch を取得）: `match std::env::var_os("APPLE_SIGNING_IDENTITY") { Some(..) => Some(..), None => config.macos.signing_identity }`。env が優先。※ dev branch の読み取り。bantou が使う tauri-cli の版での一致は未確認。
   - signing ガイド: ad-hoc は `"signingIdentity": "-"`。「Ad-hoc code signing does not prevent MacOS from requiring users to whitelist the app」。「Notarization is required when using a Developer ID Application certificate」。自己署名への言及なし。https://v2.tauri.app/distribute/sign/macos/
   - config 内の環境変数展開（`${VAR}` 等）の記述は config reference・環境変数ページに見つからなかった。env での差し込みは上の上書きで足りるので `tauri.conf.json` は変更しない。
   - codesign 呼び出し（tauri-macos-sign `keychain.rs`）: `codesign --force -s <identity> [--options runtime]`。`hardenedRuntime` は既定 true で、ad-hoc でも identity 付きでも同じ経路。→ 署名 identity を変えても hardened runtime の扱いは変わらない（実機の動作は未確認）。
6. updater
   - 「Tauri's updater needs a signature to verify that the update is from a trusted source. This cannot be disabled.」鍵は `TAURI_SIGNING_PRIVATE_KEY`、pubkey は `tauri.conf.json`。https://v2.tauri.app/plugin/updater/
   - docs は macOS code signing との独立性を明記していない（未確認）。bantou の build では identity（`APPLE_SIGNING_IDENTITY`）と updater 鍵（`TAURI_SIGNING_PRIVATE_KEY`）が別入力のため、identity を変えても updater の検証鍵は変わらない（構成上の事実）。

## 変更点

- `docs/ops/desktop-signing.md`（新規）: 症状・切り分け・直し方・原因・証明書作成（Keychain Access）・release での使い方・更新後確認・updater/Developer ID。
- `packages/desktop/scripts/release.sh`: `~/.config/bantou/signing-identity` があれば `APPLE_SIGNING_IDENTITY` で渡す。署名ビルド後に DR を表示し、identity 指定なのに DR が cdhash（ad-hoc）なら中断。`bash -n` のみ確認（mac で未実行）。
- `packages/desktop/src-tauri/tauri.conf.json`: **変更なし**（`"-"` のまま。env が無ければ従来どおり ad-hoc。docs とソースで env 優先を確認）。
- 4（検知と案内）:
  - 現状: desktop の broker 状態は Rust の poller（app プロセス内の reqwest）が持ち、`BrokerStatus.error` に `e.to_string()` を入れていた。reqwest の Display は "error sending request for url (…)" までで OS error を含まず、EHOSTUNREACH を判別できなかった。
  - center の messenger 状態 tool は経路が別（center→desktop の MCP）で、desktop の header は使っていない。center は変更不要・未変更。
  - `broker.rs`: `error_chain()` で source chain を連結。`healthy()`（broker 探索の health probe）が EHOSTUNREACH（"No route to host" / "os error 65"）だった時に static flag を立て、poller が 127.0.0.1 に fallback して "Connection refused" になっても error 末尾に `[EHOSTUNREACH]` を付ける（`status_error`）。unit test 2 件追加。
  - front: `src/utils/localNetwork.ts` と `AppHeader.vue`。error が EHOSTUNREACH 系なら messenger 表示の tooltip に「ローカルネットワークの許可を確認: System 設定 > … で bantou を OFF→ON し、app を再起動」を足す。`data-testid="messenger-status"` を追加。
  - e2e: `e2e/local-network.spec.ts`（2 件）、mock に seed `broker`（`e2e/mock/bantou.ts`）。
  - 限界: UDP broadcast 探索（`discover`）の失敗は握りつぶされるので検知に使っていない。LAN broker を `AGENT_MESSENGER_HOST` や config で指していない場合、探索が全て失敗して 127.0.0.1 に落ちても、health probe が EHOSTUNREACH を返さなければ検知しない。center→broker の失敗は desktop に届かない（desktop 自身の broker 接続の失敗のみ検知）。
- `packages/desktop/README.md`: 症状・切り分け・直し方・根本対策の節を追加。

## テスト結果

- `npm run typecheck`（`nuxt typecheck`）: pass（exit 0）。bun が host に無いため npm install（`--no-package-lock -w packages/protocol -w packages/desktop`）。`bun.lock` は変更なし。
- e2e: bun が無いので、mock bundle を esbuild で作り、`nuxt generate` の静的ビルドを簡易 node サーバーで配信、`~/.cache/ms-playwright/chromium-1243` を指定した一時 config（作業 dir 内）で実行。
  - 変更前に既存 168 件 pass。新規 2 件 pass（単独実行）。変更後の全件: **170 passed**（既存 168 + 新規 2、retries=1、2.6m）。
- cargo test: **未実施**（host に cargo が無い）。`broker.rs` の変更と unit test 2 件は未コンパイル。mac200 の release.sh（cargo test を実行する）で最初に確認される。
- tauri build の dry: Linux では mac bundle 不可。config は変更していないので、env 無し→`"-"`のまま。env あり→上書き（docs とソースで確認）。
- 署名・許可の実機確認: 未実施（Linux host）。

## 残課題

- 自己署名で許可が更新をまたいで保たれるかの実機確認（最重要）。
- 初回の自己署名版への更新では、許可の OFF→ON が 1 回要る。
- `broker.rs` のコンパイル・unit test（mac200 の cargo test）。
- 自己署名証明書が `security find-identity -v` に出るための信頼設定、ssh 経由での keychain unlock の要否（未確認）。
- 別 task（fix/relogin-local-browser）が触る `e2e/mock/bantou.ts` の Seed に 1 項目足したので、merge 時に衝突し得る（小さい）。

## review 第1回（HEAD d9ce8f3）への対応

1. [medium] broker.rs の検知漏れ — 修正。
   - `LAN_UNREACHABLE` を OR ラッチに変更（`latch()`: true にするだけ）。`resolve_broker` の頭で `reset_lan_unreachable()` し、周回内で health probe（`healthy()`、成功・refused では clear しない）か UDP discovery の `send_to` が EHOSTUNREACH なら true を保持する。(a) config に brokers が無く discover だけの経路、(b) 複数 broker の last-wins、(c) 周回をまたぐ持ち越し、の 3 点を解消。
   - `discover()` の送信を `send_probes()`（クロージャ注入）に切り出し、`send_to` のエラーが EHOSTUNREACH（`raw_os_error` が 65=macOS / 113=Linux）なら hit。`ErrorKind::HostUnreachable` は使っていない（toolchain 非固定で、新しい Rust が要るため。raw コードで足りる）。
   - unit test（ネットワーク不使用）: `status_error_marks_host_unreachable`、`latch_only_sets`、`send_probes_reports_host_unreachable_from_any_target`（hit の後に別エラーが来ても hit のまま・全 target に送る・hit 無しは false）、`resolve_round_clears_the_latch`（static に触る唯一の test）。
   - 残る限界: static はプロセス全体共有で、複数 workspace の poller が同時に resolve すると、互いの周回でクリアし合い得る（表示のヒントが一時的に出入りするだけ）。`AGENT_MESSENGER_HOST` 指定時は probe 無しで、接続エラー自体の chain（"No route to host"）で判定する。
   - cargo は host に無く**未コンパイル・未実行**。型・借用は読みで確認（`send_probes` のクロージャは `sock` を共有参照で借用、テストの `n` は FnMut で可変借用し呼び出し後に読む）。
2. [low] release.sh の identity 読み取り — 修正。先頭の非空・非 `#` 行を取り、`\r` と前後の空白を除去（bash 3.2 でも動くパラメータ展開）。有効行が無いファイルは中断。
3. [low] release.sh の DR 判定 — 修正。identity が空または `-` なら判定しない（ad-hoc 既定は従来と同一）。`-` 以外で DR が空なら中断、`cdhash` でも中断。
4. [low] docs の断定 — 修正（desktop-signing.md）。(a) TN3179 の UUID・複数版の記述を §3 に「未確認（署名以外の要因）」として追記、自己署名で直る保証は無いと明記。(b) §6-4 の DR を「想定、未確認」に。(c) §7 を「推論」と明記。(d) Tauri の timestamp / hardened runtime の挙動を未確認と明記（併せて `${VAR}` 展開の「使えない」を「記述が見つからず未確認」に和らげた）。
5. [low] e2e のマーカー依存 — 修正。マーカーだけを含む error（"No route to host" / "os error 65" 無し）で案内が出るケースを追加（local-network.spec 3 件目）。

### review 対応後の確認

- typecheck（nuxt typecheck）: pass。
- release.sh: `bash -n` pass。identity 読み取りと DR 判定のブロックを release.sh から抽出し、stub の入力で実行（HOME は変えず、tauri / cargo / codesign は実行していない）。CRLF+空白+コメント付き・末尾改行無し・コメントのみ（中断）・identity+cdhash（中断）・identity+DR 空（中断）・env `-`+cdhash（通る）・env `-`+DR 空（通る）・identity 無し+DR 空（通る）・env identity+cdhash（中断）が期待どおり。ファイル内容が `-` のケースだけ、ハーネスの printf の書き方の不具合で未実行（env `-` のケースで同じ分岐を通っている）。
- e2e / cargo の結果は下の「最終結果」。

### 最終結果（review 対応後）

- typecheck（nuxt typecheck）: pass。
- e2e: **171 passed**（前回 170 + マーカーのみのケース 1、前回と同じ方法、retries=1、2.5m）。
- cargo test: **未実施**（host に cargo が無い）。broker.rs の変更と unit test は未コンパイル。
- bun.lock 変更なし、version bump なし。fix/relogin-local-browser・feat/retire-server の対象は未接触。
