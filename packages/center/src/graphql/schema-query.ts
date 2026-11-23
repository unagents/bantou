/** GraphQL schema: Query（設計書 2.3 / 3 節）。resolver は resolvers/query.ts（ga-query が埋める）。 */
export const queryTypeDefs = /* GraphQL */ `
  type Query {
    """ session の一覧（MCP session_list、list_sessions / refresh_sessions）。 """
    sessions: SessionList!
    """ 1 session（同上）。無ければ null。 """
    session(name: String!): Session
    """ project 設定（session_settings_get）。 """
    sessionSettings(name: String!): ProjectSettings!
    """ center 共通の設定（center_settings_get）。launcher の有無は返さない（決定 6）。 """
    centerSettings: CenterSettings!
    """ workspace と system instructions の一覧（center_info。session_path_hints の素）。 """
    centerInfo: CenterInfo!
    """ center の版（#13。client が自分の版と比べる）。 """
    centerVersion: CenterVersion!
    """ remote-cap の記録（remote_list）。 """
    remotes: [RemoteRecord!]!
    """ remote の控えにある server の一覧と、server-info の答えの版。 """
    servers: [ServerInfo!]!
    """ rc の状態（rc_list）。 """
    rcStatus: [RcStatus!]!
    """ 端末の出力の取り直し（GET /sessions/<n>/output?after=）。通常は subscription terminalOutput を使う。 """
    terminalOutputSince(session: String!, after: Int): TerminalOutputSince!
  }
`;
