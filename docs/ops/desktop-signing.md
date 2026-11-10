# desktop の署名 identity（ローカルネットワーク許可を更新で失わないために）

- 更新: 2026-11-10
- 対象: mac200 の koube で行う release（`packages/desktop/scripts/release.sh`）。
- この手順は **Linux host では検証できていない**（mac で未実施）。「未確認」と書いた点は、最初の release で実機確認する。

## 1. 症状と切り分け

- 症状: app 更新の直後から、bantou.app 配下のプロセス（center・messenger MCP の node など）の **LAN（192.168.x.x）宛て TCP だけ** `EHOSTUNREACH`（No route to host）。internet と 127.0.0.1 は通る。`curl` / `ping` など Terminal 配下は通る。
- 切り分け: Terminal から同じ宛先へ `curl` が通り、app 配下からだけ落ちるなら、macOS の Local Network privilege（ローカルネットワーク許可）の外れを疑う。
- 直し方: System 設定 > プライバシーとセキュリティ > ローカルネットワーク で bantou を OFF→ON し、bantou.app を再起動する。
- header の messenger 表示にカーソルを載せると、broker への接続が EHOSTUNREACH で失敗した時に「ローカルネットワークの許可を確認」と出る（この変更を含む版以降）。

## 2. 原因（根拠つき）

- Apple TN3179「Local network privacy tracks the identity of your program using its code signature. This presents a challenge on macOS, which allows for unsigned code and ad hoc signed code … To ensure that local network privacy reliably tracks the identity of your macOS program, sign it with an Apple-issued code-signing identity.」
  https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy
- Apple TN3127「Ad hoc signed code … has a DR but it's tied to that specific version of the code. … macOS can't reliably track the identity of the code.」DR（designated requirement）は更新をまたいで同じ app と見なす基準。
  https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements
- bantou は `signingIdentity: "-"`（ad-hoc）なので、版ごとに code identity が変わり、前の版への許可が引き継がれない（上の 2 文からの帰結。0.1.44 の実機症状と一致）。

## 3. 方針

- **自己署名の code signing 証明書を 1 回作り、release の署名に使う**（Developer ID が無い前提）。証明書は版をまたいで同じなので、DR が版をまたいで一定になる。
- 未確認: 自己署名 identity で、Local Network の許可が更新をまたいで**実際に保たれるか**。Apple の文書は「Apple-issued」を勧めており、自己署名の場合の保証は書いていない。最初の更新（例 0.1.45→0.1.46）で実機確認する。保たれなければ Apple Developer Program の Developer ID が必要。
- 未確認（署名以外の要因）: TN3179 は「Local network privacy uses your main executable UUID as part of its implementation. If your main executable has no UUID, or shares a UUID with other programs, local network privacy may behave weirdly.」とも、「People might see unexpected behavior in System Settings > Privacy & Security if they have multiple versions of the same app installed (FB15568200).」とも書く。許可の外れに、署名以外（実行ファイルの UUID、複数版の同居）が効く可能性は未確認で、**自己署名にすれば直る保証は無い**。実機で外れた時は、署名の確認（§6-4）に加えて `dwarfdump --uuid /Applications/bantou.app/Contents/MacOS/bantou` が版ごとに変わるか、古い bantou.app が他の場所に残っていないかも見る（見る場所は TN3179 の記述からの想定で、これで原因が分かるかは未確認）。
- 参考: TN3179 は macOS 15.5 以降の `AllowedWiFiLocalNetworkAddresses` / `AllowedEthernetLocalNetworkAddresses`（`com.apple.network.local-network`、`sudo defaults write`、再起動要）で、特定の LAN を「許可制の対象外」にできると書く。app の署名によらない別の手段。これは host 全体の設定変更なので、この手順では使わない。

## 4. 証明書を作る（mac200 の koube、1 回）

Apple「Code Signing Guide: Procedures」の手順（Certificate Assistant）:
https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html

1. koube で GUI にログインし、アプリケーション > ユーティリティ > キーチェーンアクセスを開く。
2. メニュー キーチェーンアクセス > 証明書アシスタント > 証明書を作成。
3. 名前: `bantou dev signing`。
4. 固有名のタイプ（Identity Type）: 自己署名ルート（Self Signed Root）。証明書のタイプ: コード署名（Code Signing）。
5. 「デフォルトを無効にする」を ON にして続ける。シリアルは任意（同名で重複しない値）。**有効期間は長く（例 3650 日）** に変える（短いと期限切れで DR が変わる）。残りは既定。
6. 保存先は「ログイン」キーチェーン。
7. 確認: `security find-identity -p codesigning`（`-v` 無しで全件）に `bantou dev signing` が出る。
   - `-v`（有効のみ）に出ない場合の扱いは**未確認**。キーチェーンアクセスで証明書を開き「信頼」>「コード署名」を「常に信頼」にして `-v` に出るか試す。

注意:
- 秘密鍵はこの mac の login keychain にしか無い。バックアップ（.p12 の書き出し）をするなら鍵の扱いに注意する（この文書に鍵・パスワードは書かない）。**鍵を失う／証明書を作り直すと DR が変わり、許可は 1 回外れる**。
- ssh 経由の release では login keychain が locked だと codesign が失敗する場合がある。その場合は `security unlock-keychain ~/Library/Keychains/login.keychain-db` を実行してから release する（man security）。鍵に codesign のアクセスを許可する確認ダイアログが出る場合は、一度 GUI で「常に許可」にする。いずれも**未確認**。

## 5. release で使う

Tauri は環境変数 `APPLE_SIGNING_IDENTITY` を読み、`tauri.conf.json` の `bundle.macOS.signingIdentity` を**上書き**する。
- Tauri docs（環境変数）: 「APPLE_SIGNING_IDENTITY: The identity used to code sign. Overwrites `tauri.conf.json > bundle > macOS > signingIdentity`.」 https://v2.tauri.app/reference/environment-variables/
- 実装: tauri-cli `interface/rust.rs` が `std::env::var_os("APPLE_SIGNING_IDENTITY")` を先に見て、無ければ `config.macos.signing_identity` を使う。https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-cli/src/interface/rust.rs
- よって **`tauri.conf.json` は変えない**（`"-"` のまま＝証明書が無い環境は今までどおり ad-hoc で build できる）。
- `tauri.conf.json` 内で `${VAR}` のような環境変数の展開が使えるかは、Tauri v2 の docs（config reference・環境変数）に記述が見つからず未確認。使わず、上の環境変数による上書きで行う。
- 未確認: Tauri が identity 付きで codesign する時の timestamp（`--timestamp`）の有無と hardened runtime（`--options runtime`、`hardenedRuntime` 既定 true）の挙動。tauri-macos-sign のソースは `codesign --force -s <identity> [--options runtime]` を呼ぶが、自己署名 identity で実際に署名が通り app が起動するか（sidecar の bun 製 center を含む）は mac で未確認。

`release.sh` は、`~/.config/bantou/signing-identity`（証明書の名前。例 `bantou dev signing`）があれば、最初の「空でも `#` 始まりでもない行」（CRLF・前後の空白は除く）を `APPLE_SIGNING_IDENTITY` として `tauri build` に渡す。有効な行が無ければ中断する。ファイルが無ければ従来どおり ad-hoc（環境に `APPLE_SIGNING_IDENTITY` があればそれを使う）。

```
mkdir -p ~/.config/bantou
printf '%s\n' 'bantou dev signing' > ~/.config/bantou/signing-identity
```

release.sh は署名ビルドの後に `codesign -d -r-` で app の DR を表示する。identity を指定した（`-` 以外）のに DR が読めない、または `cdhash` のまま（＝ ad-hoc のまま）なら止まる。identity 無し・`-` は検査しない（従来どおり）。

## 6. 更新後の確認（初回は実機確認が必要）

1. 証明書で署名した版 A を入れ、ローカルネットワークを許可して、center が LAN の broker に繋がることを確認。
2. 次の版 B に更新する（B も同じ証明書）。
3. 許可を触らずに center が broker に繋がれば成功。外れたら 1. の「直し方」で復旧し、結果を docs/history に残して Developer ID を検討する。
4. 署名の確認: `codesign -dvv /Applications/bantou.app` の Authority が `bantou dev signing`、`codesign -dr - /Applications/bantou.app` の DR が `cdhash` ではなく証明書を指すこと。自己署名の DR の中身（`certificate leaf = H"…"` のような形になる、という**想定**）は Apple の文書で確認できていない＝未確認。実機で出た DR を docs/history に残す。

## 7. updater との関係

- アプリ更新の検証（tauri-plugin-updater）は minisign の鍵（`TAURI_SIGNING_PRIVATE_KEY` / `tauri.conf.json` の `plugins.updater.pubkey`）で行い、macOS の code signing identity とは別。Tauri docs「Tauri's updater needs a signature to verify that the update is from a trusted source. This cannot be disabled.」https://v2.tauri.app/plugin/updater/
- docs は両者が独立と明記してはいない（未確認）。ただし bantou の build は署名 identity と updater 鍵を別の入力（`APPLE_SIGNING_IDENTITY` / `TAURI_SIGNING_PRIVATE_KEY`）で渡しており、identity を変えても updater の鍵・pubkey は変わらない。
- 旧版（ad-hoc）から自己署名版への最初の更新は、updater の検証（minisign）は通る。許可は、ad-hoc 版には引き継がれる元が無いので、**最初の 1 回だけ**許可の操作（OFF→ON）が要る、と**推論**している（Apple の文書に自己署名への切り替え時の挙動は無く、未確認）。

## 8. notarization・Developer ID

- Tauri docs: 「Notarization is required when using a Developer ID Application certificate.」「A signing certificate is only valid if associated with your Apple ID.」自己署名は notarize できない。https://v2.tauri.app/distribute/sign/macos/
- Developer ID を取る場合は `APPLE_SIGNING_IDENTITY` を `Developer ID Application: …` にし、notarize 用の `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` を release の環境に足す。この文書の範囲外。
