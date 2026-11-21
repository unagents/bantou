/**
 * スリープ中の session の messenger の身代わり peer。
 *
 * session をスリープさせると claude が止まり、claude の messenger peer（名前 = capSessionName(session)）は登録から消える。
 * center が同じ名前の身代わりの peer を登録しておくと、その session 宛の message（他の session・remote の完了通知など）は身代わりに届く。
 * 届いたら (1) 身代わりを外す (2) session を元の会話のまま起こす (3) 起きた claude の peer が現れるまで待って、届いた message を渡す。
 * 眠っていない session には身代わりを置かない（同名の peer が並ばない）。broker に繋がらない間は定期的に登録をやり直す。
 */
import type { LinkClient, LinkInbound } from "./server-link.js";
import type { Logger } from "./log.js";

export interface SleepGate {
  /** session の眠りの状態が変わった（sleeping = 今眠っている）。眠った・眠ったまま復帰 = 身代わりを置く。起きた・消えた = 外す。 */
  sync(name: string, sleeping: boolean): void;
  /** 全部の身代わりを外す（center の終了）。 */
  close(): Promise<void>;
  /** 今身代わりを置いている（置こうとしている）session の名前。 */
  standingIn(): string[];
}

interface Slot {
  name: string;
  client: LinkClient | null;
  timer: NodeJS.Timeout | null;
  /** 外した（以後 connect が済んでも使わない）。 */
  gone: boolean;
  /** 起こしの最中（message を取りこぼさないよう、起きるまでの間に届いた分も束ねる）。 */
  waking: boolean;
  pending: LinkInbound[];
}

export function createSleepGate(opts: {
  /** 身代わりの client（名前 = peerName の別の messenger client）。 */
  clientFactory: (peerName: string) => LinkClient;
  /** session を起こす（SessionManager.wake。resume）。 */
  wake: (name: string) => Promise<unknown>;
  /** 起きた session の claude の peer へ text を push で渡す（link.notifyPeer）。 */
  deliver: (name: string, text: string, exclude?: ReadonlySet<string>) => Promise<{ ok: boolean; reason?: string }>;
  /**
   * 今 messenger にいるその session の peer の id（失敗は null）。起こす前に控え、起きた後の宛先から外す。
   * 眠らせた claude の登録は broker に最大約 60 秒残る。外さないと、起床直後の送りが新しい claude の登録前に古い peer へ届き（ok になり）消える。
   */
  peerIds?: (name: string) => Promise<string[] | null>;
  /** 起こせなかった後、まだ眠っているか（眠っているなら身代わりを置き直す）。省略時は置き直さない。 */
  isSleeping?: (name: string) => boolean;
  /** session 名 → messenger の peer 名（capSessionName）。 */
  peerName: (name: string) => string;
  log: Logger;
  /** broker に繋がらない時の登録のやり直し間隔（既定 30 秒）。 */
  retryMs?: number;
  /** 起きた claude の peer を待つ間隔（既定 2 秒）と上限（既定 180 秒）。 */
  deliverIntervalMs?: number;
  deliverTimeoutMs?: number;
}): SleepGate {
  const { log } = opts;
  const retryMs = opts.retryMs ?? 30_000;
  const deliverIntervalMs = opts.deliverIntervalMs ?? 2_000;
  const deliverTimeoutMs = opts.deliverTimeoutMs ?? 180_000;
  const slots = new Map<string, Slot>();
  let closed = false;
  const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  const textOf = (m: LinkInbound): string => `[スリープ中に届いた message。送り手: ${m.from_name}] ${m.text}`;

  const release = async (slot: Slot): Promise<void> => {
    slot.gone = true;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    const c = slot.client;
    slot.client = null;
    if (c) await c.close().catch(() => {});
  };

  const deliverAll = async (slot: Slot, messages: LinkInbound[], exclude?: ReadonlySet<string>): Promise<void> => {
    for (const m of messages) {
      const deadline = Date.now() + deliverTimeoutMs;
      let last = "";
      for (;;) {
        const r = await opts.deliver(slot.name, textOf(m), exclude);
        if (r.ok) break;
        last = r.reason ?? "";
        if (Date.now() >= deadline || closed) {
          log(`スリープ中に届いた message を渡せなかった: session=${slot.name} from=${m.from_name} ${last}`);
          break;
        }
        await sleepMs(deliverIntervalMs);
      }
    }
  };

  const onInbound = (slot: Slot, m: LinkInbound): void => {
    if (slot.waking) {
      slot.pending.push(m);
      return;
    }
    if (slot.gone) return;
    slot.waking = true;
    slot.pending.push(m);
    log(`スリープ中の session 宛の message を受けた。起こす: session=${slot.name} from=${m.from_name}`);
    void (async () => {
      try {
        // 身代わりを先に外す（外さないと、起きた claude の peer と同名が並ぶ）
        await release(slot);
        slots.delete(slot.name);
        const before = new Set((await opts.peerIds?.(slot.name)) ?? []);
        await opts.wake(slot.name);
        await deliverAll(slot, slot.pending.splice(0), before);
      } catch (e) {
        log(`スリープ中の session を起こせなかった: session=${slot.name} ${e instanceof Error ? e.message : String(e)}`);
        if (opts.isSleeping?.(slot.name)) {
          // 溜まった message は捨てず、置き直した身代わりへ引き継ぐ（次に起きた時に渡す）
          const kept = slot.pending.splice(0);
          gate.sync(slot.name, true);
          slots.get(slot.name)?.pending.unshift(...kept);
        }
      }
    })();
  };

  const connect = async (slot: Slot): Promise<void> => {
    if (slot.gone || closed) return;
    const client = opts.clientFactory(opts.peerName(slot.name));
    slot.client = client;
    client.onMessage((m) => onInbound(slot, m));
    try {
      await client.connect();
    } catch (e) {
      slot.client = null;
      await client.close().catch(() => {});
      if (slot.gone || closed) return;
      log(`身代わり peer を登録できない（${Math.round(retryMs / 1000)} 秒後に再試行）: session=${slot.name} ${e instanceof Error ? e.message : String(e)}`);
      slot.timer = setTimeout(() => void connect(slot), retryMs);
      slot.timer.unref();
      return;
    }
    if (slot.gone || closed) {
      await client.close().catch(() => {});
      return;
    }
    log(`身代わり peer を登録: session=${slot.name} peer=${client.peer?.id ?? "?"}`);
  };

  const gate: SleepGate = {
    sync(name, sleeping) {
      const cur = slots.get(name);
      if (!sleeping) {
        if (cur && !cur.waking) {
          slots.delete(name);
          // 他の経路（desktop で開く・wake）で起きる時、身代わりが預かっていた message があれば起きた claude へ渡す
          const kept = cur.pending.splice(0);
          const before = kept.length > 0 && opts.peerIds ? opts.peerIds(name) : Promise.resolve(null);
          void (async () => {
            const ex = new Set((await before) ?? []);
            await release(cur);
            if (kept.length > 0) await deliverAll(cur, kept, ex);
          })();
        }
        return;
      }
      if (cur || closed) return;
      const slot: Slot = { name, client: null, timer: null, gone: false, waking: false, pending: [] };
      slots.set(name, slot);
      void connect(slot);
    },
    async close() {
      closed = true;
      const all = [...slots.values()];
      slots.clear();
      await Promise.all(all.map(release));
    },
    standingIn: () => [...slots.keys()],
  };
  return gate;
}
