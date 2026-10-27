/**
 * remote session の起動を担う予定のモジュール。
 * 業務ロジックは未実装。
 */

export interface SessionSpec {}

export interface SessionHandle {}

export async function startSession(_spec: SessionSpec): Promise<SessionHandle> {
  throw new Error("未実装");
}
