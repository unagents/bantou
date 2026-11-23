import type { RemoteView } from "./remotes.js";

/** task_status の行数・1 行の文字数の上限。 */
export const TASK_STATUS_MAX_LINES = 40;
export const TASK_STATUS_LINE_MAX = 200;
/** servers に載せる server の数の上限。 */
export const TASK_STATUS_MAX_SERVERS = 10;

export interface TaskStatusLine {
  remote_id: string;
  server: string;
  line: string;
}

export interface TaskStatusResult {
  at: string;
  /** この session の cap（server ごとに 1 行）。 */
  caps: TaskStatusLine[];
  /** この session の cap のある server ごとの版の行（server-info の答えを控えたもの。未取得は「不明」）。 */
  servers: string[];
  /** 行数の上限で落とした行があれば true。 */
  truncated: boolean;
  /** 落とした行の数。 */
  omitted: number;
}

const minutes = (ms: number): number => Math.max(0, Math.floor(ms / 60_000));

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * 呼んだ session の cap（views は owner で絞り済みの物）を cap ごとに 1 行にする。
 * 状態は ws の最後の書き込みから（running / 止まっている）。本文は入れない。他の session の cap は出さない。
 * servers は server ごとの版（versionOf = server-info の答えの控え。この版を出すのはここだけ）。
 */
export function buildTaskStatus(
  views: RemoteView[],
  owner: string,
  now: number,
  filter?: { remote_id?: string },
  versionOf?: (server: string) => string | undefined,
): TaskStatusResult {
  const rows: TaskStatusLine[] = [];
  const servers: string[] = [];
  for (const v of views) {
    if (filter?.remote_id !== undefined && v.remote_id !== filter.remote_id) continue;
    if (v.session !== owner) continue;
    const stoppedAt = v.finishedAt !== undefined ? Date.parse(v.finishedAt) : NaN;
    // remote_id は `<parent-id>@<server>` なので server は別に出さない
    const parts = [
      v.remote_id,
      v.state === "running" ? "実行中" : "止まっている",
      v.state === "done" && !Number.isNaN(stoppedAt) ? `最後の書き込み ${minutes(now - stoppedAt)} 分前` : "",
    ].filter((p) => p !== "");
    rows.push({ remote_id: v.remote_id, server: v.server, line: clip(parts.join(" | "), TASK_STATUS_LINE_MAX) });
    const ver = `${v.server_label} | server ${versionOf?.(v.server) ?? "不明"}`;
    if (servers.length < TASK_STATUS_MAX_SERVERS && !servers.includes(ver)) servers.push(ver);
  }
  const caps = rows.slice(0, TASK_STATUS_MAX_LINES);
  const omitted = rows.length - caps.length;
  return { at: new Date(now).toISOString(), caps, servers, truncated: omitted > 0, omitted };
}
