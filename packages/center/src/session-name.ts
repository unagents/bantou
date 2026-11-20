/**
 * Claude と messenger に渡す session の名前。
 *
 * center の内部の識別子（sessions.json の key、cap_id、作業 dir、log、memory の agent ID、desktop の操作名、
 * remote_send などの tool が受ける session 名）は project 名のまま変えない。
 * 外に見える名前（`claude --remote-control` の引数 = remote-control の一覧の名前、messenger の peer 名）だけ、
 * 必ずこの関数を通して `<project 名>-cap` にする。変換はここ 1 か所（呼び出し側で文字列を組み立てない）。
 */
export const CAP_SUFFIX = "-cap";

/** project 名 -> Claude / messenger に付ける名前。既に `-cap` で終わるなら足さない。 */
export function capSessionName(project: string): string {
  return project.endsWith(CAP_SUFFIX) ? project : `${project}${CAP_SUFFIX}`;
}
