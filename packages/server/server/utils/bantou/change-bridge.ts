import type { ReportKind } from "./reports";

/**
 * /mcp の report（change の step の worker）の受け口との橋渡し。remote-cap の report（reports.ts の setReportHandler）とは別に持つ。
 * daemon が起動後に設定する。未設定の間の /mcp は change の report を拒否する。
 */
export type ChangeReportHandler = (changeId: string, workerId: string, kind: ReportKind, text: string) => Promise<void>;

let handler: ChangeReportHandler | undefined;

export function setChangeReportHandler(h: ChangeReportHandler | undefined): void {
  handler = h;
}

export function getChangeReportHandler(): ChangeReportHandler | undefined {
  return handler;
}
