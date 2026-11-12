import { homedir } from "node:os";
import { join } from "node:path";
import {
  createAttachments,
  createCenterSettings,
  createFileSettingsStore,
  createTerminals,
  type createAttachments as CreateAttachments,
  type Terminals,
} from "bantou-center-client";

// 4b: 端末に要る最小の組み立て（設定 → 接続先 → 端末）。3d が settings/mcp/sessions/events/terminal を
// 1 回だけ作って使い回す組み立てを置く時に、この file ごとそちらへ寄せる。

export interface TerminalService {
  readonly terminals: Terminals;
  readonly attachments: ReturnType<typeof CreateAttachments>;
}

let cached: TerminalService | undefined;

/** 設定 file（env WEB_SETTINGS_FILE）と env（CENTER_URL / CENTER_TOKEN）から 1 度だけ組む。接続先は呼び出しのたびに選ぶ。 */
export function terminalService(env: NodeJS.ProcessEnv = process.env): TerminalService {
  if (cached) return cached;
  const file = (env.WEB_SETTINGS_FILE ?? "").trim() || join(homedir(), ".local", "state", "bantou-web", "settings.json");
  const settings = createCenterSettings({ settingsStore: createFileSettingsStore(file), redactSecrets: true, env });
  const log = { info: () => {}, warn: (m: string) => console.warn(m) };
  const terminals = createTerminals({ getTarget: () => settings.selectTarget(), log });
  cached = { terminals, attachments: createAttachments(terminals, { log }) };
  return cached;
}
