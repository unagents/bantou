/** GraphQL schema: Mutation（設計書 2.3 / 3 節）。resolver は resolvers/mutation.ts（ga-mutation が埋める）。 */
export const mutationTypeDefs = /* GraphQL */ `
  type Mutation {
    createSession(name: String!, path: String, settings: ProjectSettingsInput): Session!
    updateSession(name: String!, newName: String, path: String, move: Boolean): Session!
    """ 受理して即返す（眠りは sessionsChanged（reason sleep）で届く。拒否は error で返す）。 """
    sleepSession(name: String!): SleepSessionResult!
    wakeSession(name: String!): Session!
    """ settings の null = 項目を消す。 """
    updateSessionSettings(name: String!, settings: ProjectSettingsInput!): ProjectSettings!
    updateCenterSettings(settings: CenterSettingsInput!): CenterSettings!
    startSessionLogin(name: String!): LoginStart!
    submitSessionLoginCode(name: String!, code: String!): LoginCodeResult!
    """ 再起動（今は rc_stop → rc_start(resume) の 2 手）。 """
    restartSession(name: String!): Boolean!
    replyWorker(remoteId: String!, server: String!, workerId: String!, text: String!): Boolean!
    """ server の退役（取り返しがつかない）。 """
    retireServer(serverId: String!): RetireResult!
    """ dataB64 = 端末へ送る bytes の base64。 """
    terminalInput(session: String!, dataB64: String!): Boolean!
    terminalResize(session: String!, cols: Int!, rows: Int!): Boolean!
    """ 画像の添付（#7 の形が決まるまでの仮の入力。dataB64 + type）。 """
    attachToSession(session: String!, type: String!, dataB64: String!): AttachmentResult!
  }
`;
