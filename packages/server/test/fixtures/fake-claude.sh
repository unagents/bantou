#!/bin/sh
# claude -p の代わり。FAKE_CLAUDE_GATE のファイルができるまで待つ（無ければ FAKE_CLAUDE_SLEEP 秒）。
# その後 stream-json の成功 result を 1 行出す。引数は無視する
if [ -n "$FAKE_CLAUDE_GATE" ]; then
  while [ ! -e "$FAKE_CLAUDE_GATE" ]; do sleep 0.1; done
else
  sleep "${FAKE_CLAUDE_SLEEP:-1}"
fi
echo '{"type":"result","subtype":"success","is_error":false,"result":"DONE","session_id":"00000000-0000-4000-8000-000000000001"}'
