import type { CenterRemoteRecord, CenterServerBoard } from "../types";

/** Show the server's board once per server (on the first remote of that server that has one). Pure; used by RemoteActivity. */
export function serverBoardOf(list: CenterRemoteRecord[], i: number): CenterServerBoard | undefined {
  const r = list[i];
  if (!r?.server_board) return undefined;
  return list.findIndex((x) => x.server === r.server && x.server_board) === i ? r.server_board : undefined;
}

const GIB = 1024 ** 3;
const gib = (n: number): string => (n / GIB).toFixed(1);

/** One line of the board: caps / workers / reservations / resources. The server only measures; it does not judge whether there is room. */
export function serverBoardLine(b: CenterServerBoard): string {
  const parts = [`cap ${b.caps}`, `worker ${b.workers}`, `予約 ${b.reserved}`];
  parts.push(b.max_parallel_tasks === null ? "並行の上限 なし" : `並行の上限 ${b.max_parallel_tasks}`);
  const x = b.resources;
  if (x) {
    parts.push(`負荷 ${x.load1.toFixed(2)}/${x.cpus}cpu`);
    parts.push(`メモリ空き ${gib(x.mem_free)}/${gib(x.mem_total)}GiB`);
    if (x.disk_free !== null && x.disk_total !== null) parts.push(`ディスク空き ${gib(x.disk_free)}/${gib(x.disk_total)}GiB`);
  } else {
    parts.push("資源 未測定");
  }
  return parts.join(" | ");
}
