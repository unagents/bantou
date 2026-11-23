/** GraphQL schema: Mutation（設計書 2.3 / 3 節）。resolver は resolvers/mutation.ts（ga-mutation が埋める）。 */
export const mutationTypeDefs = /* GraphQL */ `
  type Mutation {
    createSession(name: String!, path: String, settings: ProjectSettingsInput): Session!
    updateSession(name: String!, newName: String, path: String, move: Boolean): Session!
    """ session をスリープさせる（MCP の session_sleep と同じ入口。起動しないリセッション）。その session の agent に引継ぎを書かせ、turn が終わった後に止める。受理して即返す: { accepted: true, sleeping: false, pending: true }（眠るのは引継ぎが渡って turn が終わった後。眠った事は sessionsChanged の reason sleep と Session.sleeping で分かる）。作業中・利用者の入力待ち・未完了の remote の指示・未返答の worker_reply がある時・動いていない session は、眠らせず理由つきの error（OPERATION_FAILED）で断る。すでに眠っていれば何もしない（sleeping: true・pending: false）。 """
    sleepSession(name: String!): SleepSessionResult!
    """ スリープ中の session を起こす（MCP の session_wake と同じ）。引継ぎが在れば新しい会話で起動し、最初の入力で引継ぎが渡る。引継ぎの無い眠り（この仕組みの前）は --continue で元の会話。眠っていなければ何もしない。 """
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
