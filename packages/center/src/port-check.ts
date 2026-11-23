import { createServer } from "node:net";

/** 待受 port が使用中で、起動を止める時の error。cli.ts が見分ける。 */
export class PortInUseError extends Error {}

/** その port で動いている相手が center か。center の /graphql は鍵の無い呼び出しに 401 と www-authenticate: Bearer を返す。 */
async function looksLikeCenter(port: number, timeoutMs: number): Promise<"center" | "other" | "silent"> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ __typename }" }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status === 401 && (res.headers.get("www-authenticate") ?? "").startsWith("Bearer") ? "center" : "other";
  } catch (e) {
    const name = (e as Error).name;
    return name === "TimeoutError" || name === "AbortError" ? "silent" : "other";
  }
}

/** 使用中の理由の文（どの port か・相手が何か・次にする事。docs/design/center-graphql-server.md 2.8.3）。 */
export function portInUseMessage(port: number, who: "center" | "other" | "silent"): string {
  const head = `port ${port} は使用中で起動できない`;
  if (who === "center") return `${head}: 既に center が動いている。その center につなぐ（別の port で動かすなら設定の port を変える）`;
  if (who === "silent") return `${head}: 他の program が使っている（応答が無い）。その program を止めるか、設定の port を変える`;
  return `${head}: 他の program が使っている（center ではない応答）。その program を止めるか、設定の port を変える`;
}

/**
 * 待ち受ける前に port が空いているか確かめる。使用中なら PortInUseError（理由つき）。
 * state・session・孤児 process に触れる前に呼ぶ（2 つ目の center が何にも触らず終わる）。port 0 は OS 任せなので確かめない。
 * 確認と listen の間に別の process が取る場合は、startHttpServer の listen の失敗が最後の守りになる。
 */
export async function assertPortFree(port: number, bind: string, probeTimeoutMs = 1000): Promise<void> {
  if (port === 0) return;
  const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
    const s = createServer();
    s.once("error", (e) => resolve(e as NodeJS.ErrnoException));
    s.listen(port, bind, () => s.close(() => resolve(null)));
  });
  if (err === null) return;
  if (err.code !== "EADDRINUSE") throw err;
  throw new PortInUseError(portInUseMessage(port, await looksLikeCenter(port, probeTimeoutMs)));
}
