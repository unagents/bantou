#!/usr/bin/env bash
# tauri-plugin-updater 用の latest.json を生成する。
# Usage: scripts/make-latest-json.sh <version> <sig-file> [out-file]
#   version   : 例 0.1.16（先頭の v は付けない）
#   sig-file  : `tauri build` が出す bantou.app.tar.gz.sig（中身の minisign 署名をそのまま入れる）
#   out-file  : 省略時は latest.json（カレントdir）
# platform は darwin-aarch64 のみ。URL は GitHub release v<version> の bantou.app.tar.gz。
# release には bantou.app.tar.gz / bantou.app.tar.gz.sig / latest.json を添付する。
set -euo pipefail

usage() {
  echo "Usage: $0 <version> <sig-file> [out-file]" >&2
  exit 1
}

VERSION="${1:-}"
SIG_FILE="${2:-}"
OUT="${3:-latest.json}"
[[ -z "$VERSION" || -z "$SIG_FILE" ]] && usage
[[ "$VERSION" == v* ]] && { echo "error: version must not start with 'v': $VERSION" >&2; exit 1; }
[[ -f "$SIG_FILE" ]] || { echo "error: sig file not found: $SIG_FILE" >&2; exit 1; }

SIGNATURE="$(cat "$SIG_FILE")"
[[ -n "$SIGNATURE" ]] || { echo "error: sig file is empty: $SIG_FILE" >&2; exit 1; }

URL="https://github.com/unagents/bantou/releases/download/v${VERSION}/bantou.app.tar.gz"
PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

jq -n \
  --arg version "$VERSION" \
  --arg pub_date "$PUB_DATE" \
  --arg signature "$SIGNATURE" \
  --arg url "$URL" \
  '{
    version: $version,
    notes: "",
    pub_date: $pub_date,
    platforms: {
      "darwin-aarch64": { signature: $signature, url: $url }
    }
  }' >"$OUT"

echo "wrote $OUT (version ${VERSION}, darwin-aarch64)"
