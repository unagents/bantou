/**
 * remote cap（オーケストレーター）の起動を担う予定のモジュール。
 * 業務ロジックは未実装。
 */

export interface CapSpec {}

export interface CapHandle {}

export async function startCap(_spec: CapSpec): Promise<CapHandle> {
  throw new Error("未実装");
}
