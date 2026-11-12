/** First protocol version whose server understands `retire_server` (mirror of `RETIRE_MIN_PROTOCOL` in @agent-hand/bantou-protocol). */
export const RETIRE_MIN_PROTOCOL = "1.8.0";

const parts = (v: string): number[] | null => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/** Does a server that declares protocol `version` understand `retire_server`? Unknown / malformed = false (never guessed). */
export function supportsRetire(version: string | undefined | null): boolean {
  const v = version ? parts(version) : null;
  const min = parts(RETIRE_MIN_PROTOCOL)!;
  if (!v) return false;
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i]! > min[i]!;
  return true;
}

/**
 * Why the retire button of a server row is disabled, or null when it can be used.
 * `protocolVersion`: what the server declared (`server_peers[].protocol_version`); `serverId`: its stable id.
 */
export function retireBlockedReason(row: { protocolVersion?: string | null; serverId?: string | null; known: boolean }): string | null {
  if (!row.known) return "server が発見されていない（center から見えない）ため退役を送れない";
  if (!supportsRetire(row.protocolVersion)) {
    return `この server は退役に未対応（protocol ${row.protocolVersion || "不明"}。退役は ${RETIRE_MIN_PROTOCOL} 以降）。host で手動で止める`;
  }
  if (!row.serverId) return "server_id が分からない server は退役を送れない（誤爆を避けるため server_id が要る）";
  return null;
}
