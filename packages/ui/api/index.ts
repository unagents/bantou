// Single entry point for every call to the center and the OS — components import from
// `~/api` and never call `invoke` or `fetch` directly. The center is reached by GraphQL (`graphql.ts`);
// `invoke` is left for the desktop's own OS-side commands and the calls GraphQL does not have yet (see `center.ts`).
export {
  centerCommonSettingsGet,
  centerCommonSettingsUpdate,
  centerLauncher,
  openExternalUrl,
  rcList,
  remoteList,
  serverList,
  sessionLogin,
  sessionLoginCode,
  sessionRestart,
  centerConnection,
  centerIpStatus,
  centerLocalIps,
  centerConnectSnippets,
  centerParseConnect,
  centerRegenerateToken,
  centerGetSettings,
  centerSetSettings,
  centerStatus,
} from "./center";
export { GraphqlError } from "./graphql";
export {
  createSession,
  sessionPathHints,
  getSessionSettings,
  listSessions,
  onSessionListChanged,
  onSessionMessage,
  onSessionsChanged,
  OS_NETWORK_EVENT,
  OS_WAKE_EVENT,
  CENTER_RUNNING_EVENT,
  refreshSessions,
  updateSession,
  sleepSession,
  wakeSession,
  updateSessionSettings,
  type SessionMessage,
  type SessionsChange,
  type SleepSessionResult,
} from "./sessions";
export {
  CHECK_FOR_UPDATES_EVENT,
  checkForUpdate,
  downloadAndInstall,
  relaunchApp,
  type DownloadProgress,
  type Update,
} from "./updater";
export {
  onFilesDropped,
  sessionAttachBytes,
  sessionAttachPaths,
  sessionAttachPick,
  type AttachOutcome,
} from "./attachment";
export { errorText, logWebview } from "./log";
export { getStatuses, listTasks } from "./tasks";
export {
  onSessionOutput,
  onSessionOutputStatus,
  sessionInput,
  sessionOutputStart,
  sessionOutputStop,
  sessionResize,
  type SessionOutput,
  type SessionOutputStatus,
} from "./terminal";
export {
  AGENT_EVENT,
  agentAnswer,
  agentClose,
  agentOpen,
  agentSay,
  brokerConnect,
  brokerStatus,
  getThread,
  listPings,
  listThreads,
  PINGS_CHANGED_EVENT,
  THREADS_CHANGED_EVENT,
} from "./threads";
export {
  getWorkspaceDirectory,
  listWorkspaceHistory,
  pickDirectory,
  setWorkspaceDirectory,
} from "./workspace";
