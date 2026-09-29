#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 [--dry-run] <version> <sha256>" >&2
  exit 1
}

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
  shift
fi

VERSION="${1:-}"
SHA256="${2:-}"
[[ -z "$VERSION" || -z "$SHA256" ]] && usage

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR/.."

GITEA_HOST="192.168.1.202"
GITEA_API="http://${GITEA_HOST}/gitea/api/v1"
OWNER="grrowapp"
REPO="bantou"
CASK_PATH="Casks/bantou.rb"
BRANCH="main"
API_URL="${GITEA_API}/repos/${OWNER}/${REPO}/contents/${CASK_PATH}"

# 認証は basic 認証で行う。以前は credential の password を Gitea の API
# トークンとみなし `Authorization: token` を送っていたが、現在の credential
# store が返すのは API トークンではなくパスワードで、それでは 401 になる
# （2026-09-23 実測）。同じ値を basic 認証で送ると通る。
CRED="$(printf 'protocol=http\nhost=%s\n\n' "$GITEA_HOST" | git -C "$REPO_ROOT" credential fill)"
GITEA_USER="$(awk -F= '/^username=/{print $2; exit}' <<<"$CRED")"
GITEA_PASS="$(awk -F= '/^password=/{print $2; exit}' <<<"$CRED")"

if [[ -z "$GITEA_USER" || -z "$GITEA_PASS" ]]; then
  echo "error: could not obtain credentials via git credential fill (protocol=http host=${GITEA_HOST})" >&2
  exit 1
fi

RESPONSE="$(curl -sf -u "${GITEA_USER}:${GITEA_PASS}" "${API_URL}?ref=${BRANCH}")"
CURRENT_SHA="$(jq -r '.sha' <<<"$RESPONSE")"
CURRENT_CONTENT="$(jq -r '.content' <<<"$RESPONSE" | base64 -d)"

NEW_CONTENT="$(printf '%s\n' "$CURRENT_CONTENT" \
  | sed -E "s/^([[:space:]]*version )\"[^\"]*\"/\1\"${VERSION}\"/" \
  | sed -E "s/^([[:space:]]*sha256 )\"[^\"]*\"/\1\"${SHA256}\"/")"

mapfile -t OLD_LINES <<<"$CURRENT_CONTENT"
mapfile -t NEW_LINES <<<"$NEW_CONTENT"

if [[ "${#OLD_LINES[@]}" -ne "${#NEW_LINES[@]}" ]]; then
  echo "error: line count changed (${#OLD_LINES[@]} -> ${#NEW_LINES[@]}), aborting" >&2
  exit 1
fi

CHANGED=0
for i in "${!OLD_LINES[@]}"; do
  if [[ "${OLD_LINES[$i]}" != "${NEW_LINES[$i]}" ]]; then
    CHANGED=$((CHANGED + 1))
  fi
done

echo "--- diff (${CASK_PATH}) ---"
diff -u <(printf '%s\n' "$CURRENT_CONTENT") <(printf '%s\n' "$NEW_CONTENT") || true

if [[ "$CHANGED" -eq 0 ]]; then
  echo "no change (version/sha256 already match)"
elif [[ "$CHANGED" -gt 2 ]]; then
  echo "error: more than 2 lines differ (${CHANGED}), aborting without PUT" >&2
  exit 1
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "(dry-run) no PUT performed"
  exit 0
fi

if [[ "$CHANGED" -eq 0 ]]; then
  echo "nothing to publish"
  exit 0
fi

NEW_CONTENT_B64="$(printf '%s\n' "$NEW_CONTENT" | base64 -w0)"

PUT_BODY="$(jq -n \
  --arg message "bantou ${VERSION}" \
  --arg content "$NEW_CONTENT_B64" \
  --arg sha "$CURRENT_SHA" \
  --arg branch "$BRANCH" \
  '{message: $message, content: $content, sha: $sha, branch: $branch}')"

curl -sf -X PUT -u "${GITEA_USER}:${GITEA_PASS}" -H "Content-Type: application/json" \
  -d "$PUT_BODY" "$API_URL" >/dev/null

echo "published ${CASK_PATH} -> version ${VERSION}"
