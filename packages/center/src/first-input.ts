/**
 * session の最初の入力を渡す共通の手順（リセッションの引継ぎ・app 再起動後の状況確認）。設計は docs/design/app-restart-check.md の 2.4。
 * 本文は bracketed paste で 1 回の貼り付けとして入れ、Enter は少し置いて別に送る（改行で途中の確定をさせない）。
 * 入力を渡せなければ投げる（呼び出し側が log に出して終わる）。
 */
export async function submitFirstInput(core: { input: (name: string, data: Buffer) => boolean }, session: string, text: string, delayMs: number): Promise<void> {
  if (!core.input(session, Buffer.from(`\u001b[200~${text}\u001b[201~`))) throw new Error("session が実行中でない");
  await new Promise<void>((r) => setTimeout(r, delayMs));
  if (!core.input(session, Buffer.from("\r"))) throw new Error("session が実行中でない");
}
