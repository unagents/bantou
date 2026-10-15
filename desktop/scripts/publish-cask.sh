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

# cask の正本は desktop/Casks/bantou.rb。Homebrew tap はリポジトリ root の
# Casks/ しか読まないため、publish 時に正本から root/Casks/bantou.rb を生成する。
SOURCE="$REPO_ROOT/Casks/bantou.rb"
ROOT_CASK="$REPO_ROOT/../Casks/bantou.rb"

GITEA_HOST="192.168.1.202"
GITEA_API="http://${GITEA_HOST}/gitea/api/v1"
OWNER="agent-hand"
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

# Gitea 側に root Casks/bantou.rb がまだ無い（404）場合は sha 無しで新規作成する
RESPONSE_FILE="$(mktemp)"
trap 'rm -f "$RESPONSE_FILE"' EXIT
HTTP_CODE="$(curl -s -o "$RESPONSE_FILE" -w '%{http_code}' -u "${GITEA_USER}:${GITEA_PASS}" "${API_URL}?ref=${BRANCH}")"
if [[ "$HTTP_CODE" == "200" ]]; then
  CURRENT_SHA="$(jq -r '.sha' <"$RESPONSE_FILE")"
  CURRENT_CONTENT="$(jq -r '.content' <"$RESPONSE_FILE" | base64 -d)"
elif [[ "$HTTP_CODE" == "404" ]]; then
  CURRENT_SHA=""
  CURRENT_CONTENT=""
else
  echo "error: GET ${API_URL} returned HTTP ${HTTP_CODE}" >&2
  exit 1
fi

NEW_CONTENT="$(sed -E "s/^([[:space:]]*version )\"[^\"]*\"/\1\"${VERSION}\"/" "$SOURCE" \
  | sed -E "s/^([[:space:]]*sha256 )\"[^\"]*\"/\1\"${SHA256}\"/")"

# macOS 標準の bash 3.2 には mapfile が無いため while-read で配列化する
NEW_LINES=()
while IFS= read -r line; do NEW_LINES+=("$line"); done <<<"$NEW_CONTENT"

if [[ -n "$CURRENT_SHA" ]]; then
  OLD_LINES=()
  while IFS= read -r line; do OLD_LINES+=("$line"); done <<<"$CURRENT_CONTENT"

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
else
  # ファイルが無い時は行数ガードを適用せず全行を新規内容として扱う
  CHANGED="${#NEW_LINES[@]}"
  echo "--- new file (${CASK_PATH}) ---"
  printf '%s\n' "$NEW_CONTENT"
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "(dry-run) no PUT performed"
  exit 0
fi

# 正本と root の生成物の両方へ書き出す
mkdir -p "$(dirname "$ROOT_CASK")"
printf '%s\n' "$NEW_CONTENT" >"$SOURCE"
printf '%s\n' "$NEW_CONTENT" >"$ROOT_CASK"

if [[ "$CHANGED" -eq 0 ]]; then
  echo "nothing to publish"
  exit 0
fi

NEW_CONTENT_B64="$(printf '%s\n' "$NEW_CONTENT" | base64 -w0)"

# 既存ファイルの更新は PUT（sha 必須）、未作成なら POST（sha 無し）で新規作成する
if [[ -n "$CURRENT_SHA" ]]; then
  METHOD="PUT"
  PUT_BODY="$(jq -n \
    --arg message "bantou ${VERSION}" \
    --arg content "$NEW_CONTENT_B64" \
    --arg sha "$CURRENT_SHA" \
    --arg branch "$BRANCH" \
    '{message: $message, content: $content, sha: $sha, branch: $branch}')"
else
  METHOD="POST"
  PUT_BODY="$(jq -n \
    --arg message "bantou ${VERSION}" \
    --arg content "$NEW_CONTENT_B64" \
    --arg branch "$BRANCH" \
    '{message: $message, content: $content, branch: $branch}')"
fi

curl -sf -X "$METHOD" -u "${GITEA_USER}:${GITEA_PASS}" -H "Content-Type: application/json" \
  -d "$PUT_BODY" "$API_URL" >/dev/null

echo "published ${CASK_PATH} -> version ${VERSION}"
