#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 [--dry-run] [--force] <version> <sha256>" >&2
  exit 1
}

DRY_RUN=0
# --force は正本の構造変更（行の追加・削除）を tap に反映する時だけ使う。差分は表示する
FORCE=0
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    *) usage ;;
  esac
  shift
done

VERSION="${1:-}"
SHA256="${2:-}"
[[ -z "$VERSION" || -z "$SHA256" ]] && usage

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR/.."

# cask の正本は desktop/Casks/bantou.rb。tap は別リポ unagents/homebrew-tap
# （brew tap unagents/tap）で、publish 時に正本の内容を GitHub API で更新する。
SOURCE="$REPO_ROOT/Casks/bantou.rb"

OWNER="unagents"
REPO="homebrew-tap"
CASK_PATH="Casks/bantou.rb"
BRANCH="main"
API_PATH="repos/${OWNER}/${REPO}/contents/${CASK_PATH}"

# tap リポに Casks/bantou.rb がまだ無い（404）場合は sha 無しで新規作成する。認証は gh に任せる
RESPONSE_FILE="$(mktemp)"
trap 'rm -f "$RESPONSE_FILE"' EXIT
if gh api "${API_PATH}?ref=${BRANCH}" >"$RESPONSE_FILE" 2>&1; then
  CURRENT_SHA="$(jq -r '.sha' <"$RESPONSE_FILE")"
  CURRENT_CONTENT="$(jq -r '.content' <"$RESPONSE_FILE" | base64 -d)"
elif grep -q 'HTTP 404' "$RESPONSE_FILE"; then
  CURRENT_SHA=""
  CURRENT_CONTENT=""
else
  echo "error: gh api ${API_PATH} failed:" >&2
  cat "$RESPONSE_FILE" >&2
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

  if [[ "$FORCE" -eq 0 && "${#OLD_LINES[@]}" -ne "${#NEW_LINES[@]}" ]]; then
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
  elif [[ "$FORCE" -eq 0 && "$CHANGED" -gt 2 ]]; then
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

# 正本へ書き戻す
printf '%s\n' "$NEW_CONTENT" >"$SOURCE"

if [[ "$CHANGED" -eq 0 ]]; then
  echo "nothing to publish"
  exit 0
fi

# macOS の base64 は -w を持たないため tr で改行を除去する
NEW_CONTENT_B64="$(printf '%s\n' "$NEW_CONTENT" | base64 | tr -d '\n')"

# 既存ファイルの更新は sha 必須、未作成なら sha 無しで新規作成する
if [[ -n "$CURRENT_SHA" ]]; then
  gh api -X PUT "$API_PATH" \
    -f message="bantou ${VERSION}" \
    -f content="$NEW_CONTENT_B64" \
    -f sha="$CURRENT_SHA" \
    -f branch="$BRANCH" >/dev/null
else
  gh api -X PUT "$API_PATH" \
    -f message="bantou ${VERSION}" \
    -f content="$NEW_CONTENT_B64" \
    -f branch="$BRANCH" >/dev/null
fi

echo "published ${CASK_PATH} -> version ${VERSION}"
