#!/usr/bin/env bash
# desktop の release を mac200（claude-cli）で一通り行う。
# Usage: packages/desktop/scripts/release.sh [--dry-run] <version>
#   version   : 例 0.1.30（先頭の v は付けない）。develop の今の版と違うこと
#   --dry-run : 検査・版上げ・署名ビルド・push 可否の確認まで。push・release・cask・入れ替えはしない
# 流れ: develop を新規 clone → e2e・cargo test → 版上げ commit → 署名ビルド → latest.json
#       → server が npm に無い版なら server の test と npm publish
#       → develop を push・main を早送り → gh release → cask → cask の commit を push → 後始末 → npm に tarball が出るのを待つ → mac200 の入れ替え
# 前提（mac200 claude-cli）: gh が GitHub に認証済み、~/.tauri/bantou-updater.key、bun・cargo・jq・/opt/homebrew/bin/brew。
#   server の publish が要る時は npm にもログイン済み（desktop は packages/server/package.json の版を対の版として埋め込むため、先に公開する）。
# 署名 identity は ~/.config/bantou/signing-identity（1 行）があれば APPLE_SIGNING_IDENTITY として渡す（無ければ ad-hoc）。
# commit の末尾に足す行があれば ~/.config/bantou/release-trailer に置く（無ければ足さない）。
set -euo pipefail

usage() {
  echo "Usage: $0 [--dry-run] <version>" >&2
  exit 1
}

DRY_RUN=0
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    *) usage ;;
  esac
  shift
done

VERSION="${1:-}"
[[ -z "$VERSION" ]] && usage
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "error: version must look like 0.1.30: $VERSION" >&2; exit 1; }

export PATH="/opt/homebrew/bin:$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
KEY="$HOME/.tauri/bantou-updater.key"
TRAILER_FILE="$HOME/.config/bantou/release-trailer"
# 署名 identity（codesign の証明書名。docs/ops/desktop-signing.md）。無ければ tauri.conf.json の ad-hoc（"-"）のまま
IDENTITY_FILE="$HOME/.config/bantou/signing-identity"
REPO_URL="https://github.com/unagents/bantou.git"
WORK="/tmp/bantou-rel-$VERSION"
OUT="/tmp/bantou-rel-$VERSION-out"

step() { echo "== $(date '+%H:%M:%S') $*"; }

# push 前に失敗したら clone を消す（再実行できるように）。push 後の失敗では残し、続きを手で行う
PUSHED=0
on_exit() {
  local rc=$?
  if [[ $rc -ne 0 && "$PUSHED" == 0 ]]; then
    cd /tmp
    rm -rf "$WORK" "$OUT"
  elif [[ $rc -ne 0 ]]; then
    echo "error: failed after push; the clone is kept at $WORK (artifacts in $OUT)" >&2
  fi
}

[[ -f "$KEY" ]] || { echo "error: signing key not found: $KEY" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "error: gh is not logged in to github.com" >&2; exit 1; }
[[ -e "$WORK" || -e "$OUT" ]] && { echo "error: $WORK or $OUT already exists (left by an earlier run?)" >&2; exit 1; }
if gh release view "v$VERSION" -R unagents/bantou >/dev/null 2>&1; then
  echo "error: release v$VERSION already exists" >&2
  exit 1
fi

commit() {
  local msg="$1"; shift
  if [[ -s "$TRAILER_FILE" ]]; then
    git commit -q -m "$msg" -m "$(cat "$TRAILER_FILE")" "$@"
  else
    git commit -q -m "$msg" "$@"
  fi
}

trap on_exit EXIT
step "clone develop"
git clone -q --branch develop "$REPO_URL" "$WORK"
mkdir -p "$OUT"
cd "$WORK"
git config user.name claude.cli
git config user.email claude.cli@local.host
OLD="$(jq -r .version packages/desktop/package.json)"
[[ "$OLD" != "$VERSION" ]] || { echo "error: develop is already $VERSION" >&2; exit 1; }
echo "develop $(git rev-parse --short HEAD), version $OLD -> $VERSION"
SERVER_VERSION="$(jq -r .version packages/server/package.json)"
if [[ "$(npm view "bantou@$SERVER_VERSION" version 2>/dev/null || true)" == "$SERVER_VERSION" ]]; then
  PUBLISH_SERVER=0
  echo "server $SERVER_VERSION is on npm"
else
  PUBLISH_SERVER=1
  echo "server $SERVER_VERSION is not on npm; it will be published"
  npm whoami >/dev/null 2>&1 || { echo "error: server $SERVER_VERSION needs npm publish, but npm is not logged in" >&2; exit 1; }
fi

step "install and test"
# protocol は file: 依存で、bun install の時点の中身が写される。dist を作ってから入れ直す
bun install
(cd packages/protocol && npm run build)
bun install
git checkout -- bun.lock # bun install が書き換えることがある
(cd packages/desktop && bun run build:sidecar && bun run e2e)
(cd packages/desktop/src-tauri && cargo test)
if [[ "$PUBLISH_SERVER" == 1 ]]; then
  (cd packages/server && npm test)
fi

step "bump $OLD -> $VERSION"
OLD_RE="${OLD//./\\.}"
sed -i '' "s/\"version\": \"$OLD_RE\"/\"version\": \"$VERSION\"/" packages/desktop/package.json
# bun.lock の packages/desktop の版は古いまま残っていることがあるので、今の値によらず packages/desktop の欄だけ書き換える
awk -v v="$VERSION" '/^ *"packages\/desktop": \{/ { d = 1 } d && /"version":/ { sub(/"version": "[^"]*"/, "\"version\": \"" v "\""); d = 0 } { print }' bun.lock >bun.lock.new
mv bun.lock.new bun.lock
sed -i '' "s/^version = \"$OLD_RE\"\$/version = \"$VERSION\"/" packages/desktop/src-tauri/Cargo.toml
# Cargo.lock には同じ版の別 crate があり得る（例: schannel 0.1.30）。name = "bantou" の直後の版だけ書き換える
awk -v v="$VERSION" '/^name = "bantou"$/ { b = 1; print; next } b && /^version = / { $0 = "version = \"" v "\""; b = 0 } { print }' packages/desktop/src-tauri/Cargo.lock >packages/desktop/src-tauri/Cargo.lock.new
mv packages/desktop/src-tauri/Cargo.lock.new packages/desktop/src-tauri/Cargo.lock
for f in bun.lock packages/desktop/package.json packages/desktop/src-tauri/Cargo.toml packages/desktop/src-tauri/Cargo.lock; do
  n="$(git diff -U0 "$f" | grep -c '^+[^+]' || true)"
  [[ "$n" == 1 ]] || { echo "error: $f changed $n lines (expected 1)" >&2; exit 1; }
done
commit "bantou $VERSION" -a
SHA="$(git rev-parse HEAD)"

step "signed build"
if [[ -s "$IDENTITY_FILE" ]]; then
  APPLE_SIGNING_IDENTITY="$(head -n 1 "$IDENTITY_FILE")"
  export APPLE_SIGNING_IDENTITY
  echo "signing identity: $APPLE_SIGNING_IDENTITY"
else
  echo "signing identity: ${APPLE_SIGNING_IDENTITY:-ad-hoc (no $IDENTITY_FILE)}"
fi
(cd packages/desktop && TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" CI=true bun run tauri build)
BUNDLE="packages/desktop/src-tauri/target/release/bundle"
DMG="$BUNDLE/dmg/bantou_${VERSION}_aarch64.dmg"
APP_DR="$(codesign -d -r- "$BUNDLE/macos/bantou.app" 2>&1 | grep '^designated' || true)"
echo "designated requirement: $APP_DR"
# identity を指定したのに DR が cdhash（ad-hoc）のままなら、許可が更新で外れる署名になっている
if [[ -n "${APPLE_SIGNING_IDENTITY:-}" && "$APP_DR" == *cdhash* ]]; then
  echo "error: APPLE_SIGNING_IDENTITY is set but the app is still ad-hoc signed (DR uses cdhash)" >&2
  exit 1
fi
for f in "$DMG" "$BUNDLE/macos/bantou.app.tar.gz" "$BUNDLE/macos/bantou.app.tar.gz.sig"; do
  [[ -s "$f" ]] || { echo "error: build output missing: $f" >&2; exit 1; }
  cp "$f" "$OUT/"
done
packages/desktop/scripts/make-latest-json.sh "$VERSION" "$OUT/bantou.app.tar.gz.sig" "$OUT/latest.json"
DMG_SHA="$(shasum -a 256 "$OUT/$(basename "$DMG")" | cut -d' ' -f1)"
git checkout -- bun.lock
# 追跡外（bun build の .bun-build など）は commit に入らないので見ない
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo "error: the build left changes in the clone:" >&2; git status --short --untracked-files=no >&2; exit 1; }

if [[ "$DRY_RUN" == 1 ]]; then
  step "dry-run: check push and tap access"
  git push --dry-run origin develop
  git push --dry-run origin "$SHA:refs/heads/main"
  packages/desktop/scripts/publish-cask.sh --dry-run "$VERSION" "$DMG_SHA"
  git checkout -- packages/desktop/Casks/bantou.rb
  if [[ "$PUBLISH_SERVER" == 1 ]]; then
    (cd packages/server && npm publish --dry-run)
  fi
  ls -l "$OUT"
  cd /tmp
  rm -rf "$WORK" "$OUT"
  echo "dry-run ok: $VERSION (sha $SHA, dmg sha256 $DMG_SHA); nothing was pushed or published"
  exit 0
fi

PUSHED=1
if [[ "$PUBLISH_SERVER" == 1 ]]; then
  step "npm publish server $SERVER_VERSION"
  (cd packages/server && npm publish)
fi

step "push develop and fast-forward main"
git push origin develop
git push origin "$SHA:refs/heads/main"

step "GitHub release v$VERSION"
gh release create "v$VERSION" "$OUT/$(basename "$DMG")" "$OUT/bantou.app.tar.gz" "$OUT/bantou.app.tar.gz.sig" "$OUT/latest.json" \
  -R unagents/bantou --target "$SHA" --title "v$VERSION" --notes ""

step "cask"
packages/desktop/scripts/publish-cask.sh "$VERSION" "$DMG_SHA"
commit "bantou $VERSION cask" packages/desktop/Casks/bantou.rb
git push origin develop

step "clean up"
cd /tmp
rm -rf "$WORK" "$OUT"

if [[ "$PUBLISH_SERVER" == 1 ]]; then
  # 新しい center は起動すると server に update_server を送る。npm に tarball が出る前だと server 側が取得に失敗するので、
  # packument と tarball が取れるようになるまで待ってから入れ替える（最長 20 分。待ち切れなければ center が 5 分おきに再指示する）
  step "wait for npm to serve bantou@$SERVER_VERSION"
  for i in $(seq 1 60); do
    TARBALL="$(curl -fsS "https://registry.npmjs.org/bantou/$SERVER_VERSION" 2>/dev/null | jq -r '.dist.tarball // empty' || true)"
    if [[ -n "$TARBALL" ]] && curl -fsSIL -o /dev/null "$TARBALL"; then
      echo "npm serves $TARBALL"
      break
    fi
    [[ "$i" == 60 ]] && echo "warn: bantou@$SERVER_VERSION is not served by npm yet; the center will retry the update later" >&2
    sleep 20
  done
fi

step "swap the app on mac200"
brew update
brew upgrade --cask unagents/tap/bantou
APP_UID="$(id -u koube)"
INSTALLED="$(defaults read /Applications/bantou.app/Contents/Info.plist CFBundleShortVersionString)"
[[ "$INSTALLED" == "$VERSION" ]] || { echo "error: mac200 has $INSTALLED installed, expected $VERSION" >&2; exit 1; }
for pid in $(pgrep -u koube -f '^/Applications/bantou.app/Contents/MacOS/bantou$' || true); do
  sudo -n -u koube kill "$pid"
done
# アプリを止めると center・wrapper も後を追って終わる。残ったら新しいアプリと port がぶつかるので止める
for _ in $(seq 1 30); do
  pgrep -u koube -f '/Applications/bantou.app/Contents/MacOS/' >/dev/null || break
  sleep 1
done
if pgrep -u koube -f '/Applications/bantou.app/Contents/MacOS/' >/dev/null; then
  echo "error: old bantou processes are still running on mac200:" >&2
  pgrep -u koube -fl '/Applications/bantou.app/Contents/MacOS/' >&2
  exit 1
fi
sudo -n launchctl asuser "$APP_UID" sudo -n -H -u koube open /Applications/bantou.app
NEW_PID=""
for _ in $(seq 1 30); do
  NEW_PID="$(pgrep -u koube -f '^/Applications/bantou.app/Contents/MacOS/bantou$' || true)"
  [[ -n "$NEW_PID" ]] && break
  sleep 1
done
[[ -n "$NEW_PID" ]] || { echo "error: bantou did not start on mac200" >&2; exit 1; }
echo "released $VERSION (sha $SHA, dmg sha256 $DMG_SHA); mac200 runs $INSTALLED (pid $NEW_PID)"
