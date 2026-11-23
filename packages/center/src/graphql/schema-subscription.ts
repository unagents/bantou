/** GraphQL schema: Subscription（設計書 2.3 / 3.3 節。SSE で配る #1 案 A）。resolver は resolvers/subscription.ts（ga-sub が埋める）。 */
export const subscriptionTypeDefs = /* GraphQL */ `
  type Subscription {
    """ session 増減・状態変化（center /events の sessions）。 """
    sessionsChanged: SessionsChanged!
    """ turn の終わりの最後の応答（center /events の session-message）。 """
    sessionMessage: SessionMessage!
    """ 端末の出力。切れたら after で続きから。 """
    terminalOutput(session: String!, after: Int): TerminalEvent!
    """ remote の取り直しの契機（remote の running 件数が変わった時。worker の ws の書き込みで running になった時と、60 秒無音で止まっている（done）になった時を含む）。name は session。 """
    remotesChanged: SessionsChanged!
    """ center 自身の状態。 """
    centerStatus: CenterStatus!
  }
`;
