import { expect, test } from "@playwright/test";

import { serverBoardLine, serverBoardOf } from "../../ui/composables/serverBoard";
import type { CenterRemoteRecord, CenterServerBoard } from "../../ui/types";

// Pure logic of the server board line / once-per-server placement in RemoteActivity (no browser).

const GIB = 1024 ** 3;
const board = (over: Partial<CenterServerBoard> = {}): CenterServerBoard => ({
  at: "2026-11-21T00:00:00.000Z",
  caps: 2,
  workers: 3,
  reserved: 1,
  max_parallel_tasks: null,
  resources: { at: "2026-11-21T00:00:00.000Z", load1: 1.5, load5: 1, load15: 0.5, cpus: 8, mem_total: 16 * GIB, mem_free: 8 * GIB, disk_total: 100 * GIB, disk_free: 50 * GIB, workers: 3 },
  ...over,
});
const rec = (server: string, server_board?: CenterServerBoard): CenterRemoteRecord => ({ server, ...(server_board ? { server_board } : {}) }) as unknown as CenterRemoteRecord;

test("board line shows caps, workers, reservations, limit, load, memory and disk", () => {
  expect(serverBoardLine(board())).toBe("cap 2 | worker 3 | 予約 1 | 並行の上限 なし | 負荷 1.50/8cpu | メモリ空き 8.0/16.0GiB | ディスク空き 50.0/100.0GiB");
});

test("board line: user-set limit as a number, unmeasured resources, unmeasurable disk", () => {
  expect(serverBoardLine(board({ max_parallel_tasks: 4 }))).toContain("並行の上限 4");
  expect(serverBoardLine(board({ resources: null }))).toMatch(/資源 未測定$/);
  const line = serverBoardLine(board({ resources: { ...board().resources!, disk_total: null, disk_free: null } }));
  expect(line).not.toContain("ディスク");
  expect(line).toContain("メモリ空き");
});

test("board is shown once per server, on the first remote that has one", () => {
  const b1 = board();
  const b2 = board({ workers: 9 });
  const list = [rec("a", b1), rec("a", b1), rec("b", b2), rec("c")];
  expect(serverBoardOf(list, 0)).toBe(b1);
  expect(serverBoardOf(list, 1)).toBeUndefined();
  expect(serverBoardOf(list, 2)).toBe(b2);
  expect(serverBoardOf(list, 3)).toBeUndefined();
  expect(serverBoardOf(list, 9)).toBeUndefined();
  const late = [rec("a"), rec("a", b1)];
  expect(serverBoardOf(late, 0)).toBeUndefined();
  expect(serverBoardOf(late, 1)).toBe(b1);
});
