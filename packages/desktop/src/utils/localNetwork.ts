/** Marker `src-tauri/src/broker.rs` appends to a broker error when a LAN connection failed with EHOSTUNREACH. */
const MARK = /EHOSTUNREACH|No route to host|os error 65/;

export const LOCAL_NETWORK_HINT =
  "ローカルネットワークの許可を確認: System 設定 > プライバシーとセキュリティ > ローカルネットワーク で bantou を OFF→ON し、app を再起動";

/** True when the broker error looks like macOS denying LAN access (Local Network privilege). */
export function isLocalNetworkDenied(error: string | null | undefined): boolean {
  return !!error && MARK.test(error);
}
