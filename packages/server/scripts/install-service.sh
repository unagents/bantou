#!/usr/bin/env bash
# bantou server を「専用ユーザーの HOME = server root」の service として設置する（設置者が sudo で 1 回だけ実行）。
#   sudo ./install-service.sh [--user bantou] [--home <dir>] [--version <npm 版|latest>] [--broker <url>]... [--broker-port N] [--mcp-port N] [--discovery on|off] [--no-start] [--dry-run]
# 冪等: 何度実行しても既存の config.json / gitconfig / 認証は上書きしない。unit は内容が変わった時だけ置き換えて再起動する。
# --no-start: unit の配置と enable まで行い、起動しない（caps を移送してから起動する移行用。起動は systemctl start / launchctl kickstart）。
set -euo pipefail

USER_NAME=bantou
HOME_DIR=""
VERSION=latest
DRY=0
NO_START=0
BROKERS=()
BROKER_PORT=""
MCP_PORT=""
DISCOVERY=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TPL_DIR="$SCRIPT_DIR/service"
UNIT_NAME=bantou-server
PLIST_LABEL=com.unagents.bantou

usage() { sed -n '2,4p' "$0" | sed 's/^# \{0,1\}//'; }
die() { echo "error: $*" >&2; exit 1; }
say() { echo "[install] $*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --user) USER_NAME="${2:?}"; shift 2 ;;
    --home) HOME_DIR="${2:?}"; shift 2 ;;
    --version) VERSION="${2:?}"; shift 2 ;;
    --broker) BROKERS+=("${2:?}"); shift 2 ;;
    --broker-port) BROKER_PORT="${2:?}"; shift 2 ;;
    --mcp-port) MCP_PORT="${2:?}"; shift 2 ;;
    --discovery) DISCOVERY="${2:?}"; shift 2 ;;
    --no-start) NO_START=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done

[[ "$USER_NAME" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "invalid --user: $USER_NAME"
[[ "$VERSION" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid --version: $VERSION"
valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && [ "${#1}" -le 5 ] && [ "$1" -le 65535 ]; }
[ -z "$BROKER_PORT" ] || valid_port "$BROKER_PORT" || die "invalid --broker-port（0..65535 の整数）: $BROKER_PORT"
[ -z "$MCP_PORT" ] || valid_port "$MCP_PORT" || die "invalid --mcp-port（0..65535 の整数）: $MCP_PORT"
[ -z "$DISCOVERY" ] || [ "$DISCOVERY" = on ] || [ "$DISCOVERY" = off ] || die "invalid --discovery（on か off）: $DISCOVERY"
for b in "${BROKERS[@]+"${BROKERS[@]}"}"; do
  [[ "$b" =~ ^https?://[A-Za-z0-9._:-]+(/[A-Za-z0-9._~%/-]*)?$ ]] || die "invalid --broker（http(s)://host[:port] 形式）: $b"
done
OS="$(uname -s)"
case "$OS" in
  Linux) DEFAULT_HOME="/home/$USER_NAME" ;;
  Darwin) DEFAULT_HOME="/Users/$USER_NAME" ;;
  *) die "unsupported OS: $OS" ;;
esac
HOME_DIR="${HOME_DIR:-$DEFAULT_HOME}"
[[ "$HOME_DIR" = /* ]] || die "--home must be absolute: $HOME_DIR"
[[ "$HOME_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "invalid --home（使える文字は英数字と . _ / - のみ。空白や | & 等は unit と sed 置換を壊す）: $HOME_DIR"

if [ "$DRY" = 0 ] && [ "$(id -u)" != 0 ]; then die "root で実行する（sudo $0 ...）。確認だけなら --dry-run"; fi

# 実行する（dry-run は表示のみ）
run() { if [ "$DRY" = 1 ]; then echo "  (dry-run) $*"; else "$@"; fi; }
# 対象 user として実行
as_user() { if [ "$DRY" = 1 ]; then echo "  (dry-run) as $USER_NAME: $*"; else sudo -u "$USER_NAME" -H "$@"; fi; }

NPX="$(command -v npx || true)"
[ -n "$NPX" ] || die "npx が見つからない。node 22 以上を system 全体に入れる（docs/ops/server-install.md）"
command -v node >/dev/null || die "node が見つからない"
NODE_BIN="$(dirname "$(command -v node)")"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "node 22 以上が必要（今: $(node -v)）"
command -v git >/dev/null || die "git が見つからない"

if [ "$VERSION" != latest ]; then
  say "警告: --version $VERSION で版を固定する。update_server で版を上げても、restart / host 再起動のたびにこの版に戻る（既定は latest。固定は非推奨）。"
fi
render() { # <template>
  sed -e "s|@USER@|$USER_NAME|g" -e "s|@HOME@|$HOME_DIR|g" -e "s|@VERSION@|$VERSION|g" \
      -e "s|@NPX@|$NPX|g" -e "s|@NODE_BIN@|$NODE_BIN|g" "$1"
}

# 実行前の警告: 既存 unit の内容が変わる（版固定の変更・解除など）と、server が restart され、update_server で上げた版は unit の版に戻る
if [ "$OS" = Linux ]; then EXISTING_UNIT="/etc/systemd/system/$UNIT_NAME.service"; UNIT_TPL=bantou-server.service.in
else EXISTING_UNIT="/Library/LaunchDaemons/$PLIST_LABEL.plist"; UNIT_TPL=com.unagents.bantou.plist.in; fi
if [ -f "$EXISTING_UNIT" ] && [ -f "$TPL_DIR/$UNIT_TPL" ] && [ "$(cat "$EXISTING_UNIT")" != "$(render "$TPL_DIR/$UNIT_TPL")" ]; then
  say "警告: 既存の $EXISTING_UNIT の内容が変わる（今回の版: $VERSION）。"
  [ "$VERSION" != latest ] || say "警告: --version を付けない再実行は版固定を解除して latest に戻す。"
  if [ "$NO_START" = 1 ]; then say "警告: --no-start なので今は再起動しない（動いている server には次の restart で反映される）。"
  else say "警告: 反映のため server を restart する。実行中の cap / worker は中断されるので cap が空の時に行う。"; fi
  say "警告: update_server で上げた版は、unit の版（今回: $VERSION）に戻る。"
fi
say "OS=$OS user=$USER_NAME home=$HOME_DIR version=$VERSION npx=$NPX dry-run=$DRY"

# 1. ユーザー
if id "$USER_NAME" >/dev/null 2>&1; then
  if [ "$OS" = Linux ]; then
    CUR_HOME="$(getent passwd "$USER_NAME" | cut -d: -f6)"
  else
    CUR_HOME="$(dscl . -read "/Users/$USER_NAME" NFSHomeDirectory | awk '{print $2}')"
  fi
  [ "$CUR_HOME" = "$HOME_DIR" ] || die "user $USER_NAME は既にあるが HOME が違う: $CUR_HOME（--home $CUR_HOME を指定するか別の --user を使う）"
  say "user $USER_NAME は既にある"
else
  say "user $USER_NAME を作成"
  if [ "$OS" = Linux ]; then
    run useradd --create-home --home-dir "$HOME_DIR" --shell /bin/bash --comment "bantou server" "$USER_NAME"
    run passwd -l "$USER_NAME"   # パスワードログイン不可（sudo -u で入る）
  else
    # macOS: パスワードは使い捨て（ログインには使わない）
    run sysadminctl -addUser "$USER_NAME" -fullName "bantou server" -home "$HOME_DIR" -shell /bin/bash -password "$(openssl rand -base64 24)"
    run mkdir -p "$HOME_DIR"
    run chown "$USER_NAME" "$HOME_DIR"
  fi
fi
# HOME が先に存在し所有が違う（useradd は既存 dir の所有を変えない）場合は bantou のものにする
if [ -d "$HOME_DIR" ]; then
  if [ "$OS" = Linux ]; then CUR_OWNER="$(stat -c %U "$HOME_DIR")"; else CUR_OWNER="$(stat -f %Su "$HOME_DIR")"; fi
  if [ "$CUR_OWNER" != "$USER_NAME" ]; then
    say "HOME の所有を $USER_NAME に直す（今: $CUR_OWNER）: $HOME_DIR"
    if [ "$OS" = Linux ]; then run chown "$USER_NAME:" "$HOME_DIR"; else run chown "$USER_NAME" "$HOME_DIR"; fi
  fi
fi
run chmod 750 "$HOME_DIR"   # 他ユーザーと HOME を共有しない

# bantou から node が実行できること（NVM など人の HOME 配下の node は不可）
if [ "$DRY" = 1 ]; then
  echo "  (dry-run) as $USER_NAME: test -x $NODE_BIN/node"
else
  sudo -u "$USER_NAME" -H test -x "$NODE_BIN/node" || die "$USER_NAME から $NODE_BIN/node を実行できない。NVM など人の HOME 配下の node は使えない。system 全体に入れる（docs/ops/server-install.md 2 章）"
  sudo -u "$USER_NAME" -H test -x "$NPX" || die "$USER_NAME から $NPX を実行できない（docs/ops/server-install.md 2 章）"
fi

# 2. HOME 配下の雛形
as_user mkdir -p "$HOME_DIR/.claude" "$HOME_DIR/.config/git" "$HOME_DIR/.agent-messenger" "$HOME_DIR/.local/bin"
run chmod 700 "$HOME_DIR/.claude" "$HOME_DIR/.config/git"

# server.log は unit の StandardOutput=append: を systemd が root で開く。先に bantou 所有で作っておけば root 所有にならない
SERVER_LOG="$HOME_DIR/server.log"
if [ ! -e "$SERVER_LOG" ]; then as_user touch "$SERVER_LOG"; fi
run chown "$USER_NAME" "$SERVER_LOG"   # 旧設置で root 所有になっていた場合も直す
run chmod 640 "$SERVER_LOG"

write_if_absent() { # <path> <content>
  local path="$1" content="$2"
  if [ -e "$path" ]; then say "既にある（上書きしない）: $path"; return; fi
  say "作成: $path"
  if [ "$DRY" = 1 ]; then printf '%s\n' "$content" | sed 's/^/    | /'; return; fi
  printf '%s\n' "$content" | sudo -u "$USER_NAME" -H tee "$path" >/dev/null
}

# workspace / CLAUDE_CONFIG_DIR は明示する（root 既定に未対応の公開版でも同じ config で動く）
# 同じ host に別の bantou server が居る場合は port を分ける（内蔵 broker 既定 7901 / mcp 既定 7902 / UDP 7902 discovery）
CFG_EXTRA=""
if [ -n "$BROKER_PORT$DISCOVERY" ]; then
  B=""
  [ -n "$BROKER_PORT" ] && B="\"port\": $BROKER_PORT"
  [ -n "$DISCOVERY" ] && B="${B:+$B, }\"discovery\": \"$DISCOVERY\""
  CFG_EXTRA="  \"broker\": { $B },"$'\n'
fi
if [ -n "$MCP_PORT" ]; then CFG_EXTRA="$CFG_EXTRA  \"mcp\": { \"port\": $MCP_PORT },"$'\n'; fi
write_if_absent "$HOME_DIR/config.json" "{
  \"workspace\": \"$HOME_DIR\",
${CFG_EXTRA}  \"session\": {
    \"env\": { \"CLAUDE_CONFIG_DIR\": \"$HOME_DIR/.claude\" },
    \"extraArgs\": [\"--model\", \"sonnet\"],
    \"timeoutMs\": 1200000
  }
}"
write_if_absent "$HOME_DIR/.config/git/gitconfig" "[user]
	name = claude.cli
	email = claude.cli@local.host
[credential]
	helper = store --file $HOME_DIR/.config/git/credentials
[safe]
	directory = *"
if [ ${#BROKERS[@]} -gt 0 ]; then
  JSON="$(printf '"%s",' "${BROKERS[@]}")"
  write_if_absent "$HOME_DIR/.agent-messenger/config.json" "{\"brokers\":[${JSON%,}]}"
fi

# 3. unit 登録と起動
if [ "$OS" = Linux ]; then
  command -v systemctl >/dev/null || die "systemd が必要"
  UNIT_PATH="/etc/systemd/system/$UNIT_NAME.service"
  NEW="$(render "$TPL_DIR/bantou-server.service.in")"
  CHANGED=1
  if [ -f "$UNIT_PATH" ] && [ "$(cat "$UNIT_PATH")" = "$NEW" ]; then CHANGED=0; fi
  if [ "$CHANGED" = 1 ]; then
    say "unit を配置: $UNIT_PATH"
    if [ "$DRY" = 1 ]; then printf '%s\n' "$NEW" | sed 's/^/    | /'; else printf '%s\n' "$NEW" > "$UNIT_PATH"; chmod 644 "$UNIT_PATH"; fi
    run systemctl daemon-reload
  else
    say "unit は変更なし: $UNIT_PATH"
  fi
  run systemctl enable "$UNIT_NAME.service"
  if [ "$NO_START" = 1 ]; then say "--no-start: 起動しない（起動: sudo systemctl start $UNIT_NAME）"
  elif [ "$CHANGED" = 1 ]; then run systemctl restart "$UNIT_NAME.service"; else run systemctl start "$UNIT_NAME.service"; fi
  RESTART_CMD="sudo systemctl restart $UNIT_NAME"
  STATUS_CMD="sudo systemctl status $UNIT_NAME"
  LOG_CMD="sudo journalctl -u $UNIT_NAME -e   /   sudo tail -f $HOME_DIR/server.log"
else
  PLIST_PATH="/Library/LaunchDaemons/$PLIST_LABEL.plist"
  NEW="$(render "$TPL_DIR/com.unagents.bantou.plist.in")"
  CHANGED=1
  if [ -f "$PLIST_PATH" ] && [ "$(cat "$PLIST_PATH")" = "$NEW" ]; then CHANGED=0; fi
  if [ "$CHANGED" = 1 ]; then
    say "plist を配置: $PLIST_PATH"
    if [ "$DRY" = 1 ]; then printf '%s\n' "$NEW" | sed 's/^/    | /'; else
      launchctl bootout "system/$PLIST_LABEL" 2>/dev/null || true
      printf '%s\n' "$NEW" > "$PLIST_PATH"; chown root:wheel "$PLIST_PATH"; chmod 644 "$PLIST_PATH"
    fi
    if [ "$NO_START" = 0 ]; then run launchctl bootstrap system "$PLIST_PATH"; fi   # RunAtLoad なので bootstrap で起動してしまう
  else
    say "plist は変更なし: $PLIST_PATH"
  fi
  if [ "$NO_START" = 1 ]; then say "--no-start: 起動しない（起動: sudo launchctl bootstrap system $PLIST_PATH && sudo launchctl enable system/$PLIST_LABEL）"
  else run launchctl enable "system/$PLIST_LABEL"; run launchctl kickstart "system/$PLIST_LABEL"; fi
  RESTART_CMD="sudo launchctl kickstart -k system/$PLIST_LABEL"
  STATUS_CMD="sudo launchctl print system/$PLIST_LABEL"
  LOG_CMD="sudo tail -f $HOME_DIR/server.log"
fi

cat <<MSG

[install] 完了。次に手でやること（設置者）:
  1. claude CLI を $USER_NAME に入れて（公式 native installer。$HOME_DIR/.local/bin/claude に入る）ログイン（対話が要る）:
       sudo -u $USER_NAME -H bash -c 'curl -fsSL https://claude.ai/install.sh | bash'
       sudo -u $USER_NAME -H env CLAUDE_CONFIG_DIR=$HOME_DIR/.claude $HOME_DIR/.local/bin/claude auth login
       sudo -u $USER_NAME -H env CLAUDE_CONFIG_DIR=$HOME_DIR/.claude $HOME_DIR/.local/bin/claude auth status
     login で browser が開けない host は、表示された URL を別端末の browser で開き、出た code を貼る。
  2. GitHub の鍵 / credential を $HOME_DIR 配下に置く（この host の他 user とは共有しない）:
       $HOME_DIR/.config/git/credentials      （git credential store 形式。chmod 600）
       または sudo -u $USER_NAME -H gh auth login
  3. 認証を置いたら restart して確認（設置後は ssh しない。見る時は設置者が sudo で）:
       $RESTART_CMD
       $STATUS_CMD
       $LOG_CMD
     server.log に「起動」と「peer 登録」が出れば center の discovery に現れる。
MSG
