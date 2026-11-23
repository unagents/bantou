#!/usr/bin/env bash
# bantou-center.app（packages/center-app）を build し、desktop の dmg に足す（mac 専用。hdiutil を使う）。
# Usage: packages/desktop/scripts/bundle-center-app.sh <dmg>
#   dmg : desktop の `tauri build` が作った dmg（例 .../bundle/dmg/bantou_0.1.66_aarch64.dmg）。その場で書き換える
# 前提: desktop の `tauri build`（beforeBuildCommand の build:sidecar）が済み、packages/desktop/src-tauri/binaries/ に
#       center・pty-wrapper が在る（center-app の externalBin がそこを指す）。署名は APPLE_SIGNING_IDENTITY（無ければ ad-hoc）。
# tauri の dmg 設定には追加の file を入れる口が無いので、できた dmg を読み書き可で開いて app を足し、圧縮し直す。
# updater の成果物（bantou.app.tar.gz）は bantou.app だけ。bantou-center.app は updater の対象外。
set -euo pipefail

[[ $# -eq 1 ]] || { echo "Usage: $0 <dmg>" >&2; exit 1; }
DMG="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
[[ -s "$DMG" ]] || { echo "error: dmg not found: $DMG" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CENTER_APP_DIR="$SCRIPT_DIR/../../center-app"
APP="$CENTER_APP_DIR/src-tauri/target/release/bundle/macos/bantou-center.app"

echo "build bantou-center.app"
(cd "$CENTER_APP_DIR" && bun run tauri build --bundles app)
[[ -d "$APP" ]] || { echo "error: build output missing: $APP" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/bantou-dmg.XXXXXX")"
MNT="$WORK/mnt"
RW="$WORK/rw.dmg"
ATTACHED=0
cleanup() {
  if [[ "$ATTACHED" == 1 ]]; then hdiutil detach "$MNT" -force >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$MNT"
hdiutil convert "$DMG" -format UDRW -o "$RW" >/dev/null
# 足す app の分（KB）に余裕を足して広げる
NEED_KB="$(du -sk "$APP" | cut -f1)"
CUR_SECTORS="$(hdiutil imageinfo "$RW" | awk '/^[[:space:]]*Total Bytes:/ { print $3 / 512; exit }')"
NEW_SECTORS=$(( ${CUR_SECTORS%.*} + (NEED_KB + 20480) * 2 ))
hdiutil resize -sectors "$NEW_SECTORS" "$RW" >/dev/null
hdiutil attach "$RW" -mountpoint "$MNT" -nobrowse -noverify -noautoopen >/dev/null
ATTACHED=1
ditto "$APP" "$MNT/bantou-center.app"
[[ -d "$MNT/bantou.app" && -d "$MNT/bantou-center.app" ]] || { echo "error: the dmg does not hold both apps" >&2; exit 1; }
hdiutil detach "$MNT" >/dev/null
ATTACHED=0

hdiutil convert "$RW" -format UDZO -imagekey zlib-level=9 -ov -o "$DMG" >/dev/null
echo "added bantou-center.app to $DMG"
