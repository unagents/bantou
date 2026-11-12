import { createPublicKey, type KeyObject } from "node:crypto";

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export interface JwksCacheOptions {
  readonly url: string;
  readonly fetch?: FetchLike;
  /** 取得結果を使い回す時間 (ms) */
  readonly ttlMs?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

/**
 * 署名鍵の cache（設計 5.2）。kid で選ぶ。
 * kid が cache に無ければ 1 回だけ取り直す。取得に失敗したら鍵無しとして扱う（呼び出し側が 401 にする）。
 */
export class JwksCache {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = -Infinity;
  private inflight: Promise<void> | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: JwksCacheOptions) {
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.now = opts.now ?? Date.now;
  }

  /** kid の公開鍵。無ければ undefined */
  async get(kid: string): Promise<KeyObject | undefined> {
    let refreshed = false;
    if (this.now() - this.fetchedAt > this.ttlMs) {
      await this.refresh();
      refreshed = true;
    }
    const hit = this.keys.get(kid);
    if (hit) return hit;
    // 未知の kid: 取り直しは 1 回だけ（この呼び出しで既に取得済みなら重ねない）
    if (refreshed) return undefined;
    await this.refresh();
    return this.keys.get(kid);
  }

  private refresh(): Promise<void> {
    this.inflight ??= this.load().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async load(): Promise<void> {
    try {
      const res = await this.fetchImpl(this.opts.url, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) return;
      const body = (await res.json()) as { keys?: unknown };
      const next = new Map<string, KeyObject>();
      if (Array.isArray(body.keys)) {
        for (const jwk of body.keys as Array<Record<string, unknown>>) {
          if (jwk?.kty !== "RSA" || typeof jwk.kid !== "string") continue;
          try {
            next.set(jwk.kid, createPublicKey({ key: jwk as never, format: "jwk" }));
          } catch {
            // 壊れた鍵は捨てる
          }
        }
      }
      this.keys = next;
      this.fetchedAt = this.now();
    } catch {
      // 取得失敗: 旧 cache は残すが fetchedAt は進めない
    }
  }
}
