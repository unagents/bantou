import type { Config } from "../config.js";
import type { Core } from "../core.js";
import type { EventHub } from "../events.js";
import type { LoginFlow } from "../login.js";
import type { Logger } from "../log.js";
import type { Resessioner } from "../resession.js";
import type { RemoteControlSupervisor } from "../remote-control.js";
import type { RemoteManager } from "../remotes.js";
import type { ServerLink } from "../server-link.js";
import type { SessionManager } from "../sessions.js";

/**
 * resolver が center の service に入る口。`createCenterServer`（server.ts、MCP の道具）に渡す物と同じ service を
 * 同じ形で持つ（MCP の道具と GraphQL が同じ関数を呼ぶ）。daemon.ts が 1 度だけ作って渡す。
 * resolver は `tools.ts` の関数でなく、ここの service（SessionManager など）を呼ぶ（設計書 5.2）。
 */
export interface GraphqlServices {
  config: Config;
  supervisor: RemoteControlSupervisor;
  link: ServerLink;
  sessions: SessionManager;
  /** session を眠らせる入口（引継ぎを書かせてから眠らせる。MCP の session_sleep と同じ resession.requestSleep。sessions.sleep は直接呼ばない）。 */
  resession: Pick<Resessioner, "requestSleep">;
  remotes: RemoteManager;
  login: LoginFlow;
  /** pty 出力の queue と入力・サイズ変更の受け口（terminal 系）。 */
  core: Core;
  /** session 増減・最後の応答の通知（subscription の元）。 */
  events: EventHub;
  /** 添付の置き場の親（config の workspace。無ければ添付は断る）。 */
  workspace?: string;
  log: Logger;
}

/** resolver の第 3 引数。リクエストごとに作る。認証は http.ts が済ませてから渡す。 */
export interface GraphqlContext {
  services: GraphqlServices;
  /** 呼び出し元が center を起動した所か（launcher.ts の鍵が header と合う）。画面の出し分けにだけ使う。 */
  launcher: boolean;
}
