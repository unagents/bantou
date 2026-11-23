/**
 * worker の session ごとに付く tracker。worker の stdout を読む側（runClaude の onLine）から touch() を受け、
 * 間隔ごとに「その間に出力が在った時だけ」launch の ws へ 1 行書く: { "parent-id", "at" }。無音の間は書かない。
 * state の判定・要約はしない。
 */
import { redactIn, redactUrl } from "./log";

/** 書く間隔（ms）。 */
export const TRACKER_INTERVAL_MS = 5000;

/** 切れた ws に繋ぎ直す間隔（ms）。 */
const RECONNECT_MS = 5000;

/** ws に繋がる前に溜める行の上限（超えたら古い方を捨てる）。 */
const MAX_PENDING = 100;

/** tracker が使う ws の最小の形（global WebSocket と、テストの差し替えが満たす）。 */
export interface TrackerSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "error" | "close", listener: () => void): void;
}

const OPEN = 1;
const CONNECTING = 0;

export interface TrackerOptions {
  parentId: string;
  ws: string;
  intervalMs?: number;
  /** 切れた ws に繋ぎ直す間隔（ms）。既定は 5 秒。繋がるまで続け、上限は無い（tracker を閉じるまで）。 */
  reconnectMs?: number;
  /** ws を開く。既定は global WebSocket。 */
  connect?: (url: string) => TrackerSocket;
  now?: () => Date;
  log?: (msg: string) => void;
}

export interface Tracker {
  /** stdout に出力が在った。 */
  touch(): void;
  /** timer を止めて ws を閉じる。 */
  close(): void;
}

export function createTracker(o: TrackerOptions): Tracker {
  const log = o.log ?? (() => {});
  const now = o.now ?? (() => new Date());
  const connect = o.connect ?? ((url: string): TrackerSocket => new WebSocket(url) as unknown as TrackerSocket);
  let sock: TrackerSocket | undefined;
  /** 今の接続が切れた（または開けなかった）。繋ぎ直すまで書き込みは捨てる。 */
  let dead = false;
  let closed = false;
  let output = false;
  let pending: string[] = [];
  let retry: ReturnType<typeof setTimeout> | undefined;

  const flush = (s: TrackerSocket): void => {
    if (s !== sock || s.readyState !== OPEN) return;
    for (const line of pending) {
      try {
        s.send(line);
      } catch (e) {
        log(`tracker: ws へ書けない: ${redactIn(e instanceof Error ? e.message : String(e), o.ws)}`);
        lost(s);
        return;
      }
    }
    pending = [];
  };

  /** 接続が切れた。まだ閉じていなければ、間隔を置いて繋ぎ直す（切れた間の書き込みは捨てる）。 */
  const lost = (s: TrackerSocket | undefined): void => {
    if (s !== sock || dead) return;
    dead = true;
    pending = [];
    if (closed || retry !== undefined) return;
    retry = setTimeout(() => {
      retry = undefined;
      if (!closed) open();
    }, o.reconnectMs ?? RECONNECT_MS);
    retry.unref?.();
  };

  const open = (): void => {
    dead = false;
    let s: TrackerSocket;
    try {
      s = connect(o.ws);
    } catch (e) {
      log(`tracker: ws を開けない: ${redactUrl(o.ws)} ${redactIn(e instanceof Error ? e.message : String(e), o.ws)}`);
      sock = undefined;
      dead = true;
      if (!closed && retry === undefined) {
        retry = setTimeout(() => {
          retry = undefined;
          if (!closed) open();
        }, o.reconnectMs ?? RECONNECT_MS);
        retry.unref?.();
      }
      return;
    }
    sock = s;
    s.addEventListener("open", () => flush(s));
    s.addEventListener("error", () => {
      if (s === sock && !dead) log(`tracker: ws の接続エラー: ${redactUrl(o.ws)}`);
      lost(s);
    });
    s.addEventListener("close", () => lost(s));
  };
  open();

  const timer = setInterval(() => {
    if (!output) return;
    output = false;
    if (dead || closed) return;
    pending.push(JSON.stringify({ "parent-id": o.parentId, at: now().toISOString() }));
    if (pending.length > MAX_PENDING) pending = pending.slice(-MAX_PENDING);
    if (sock !== undefined) flush(sock);
  }, o.intervalMs ?? TRACKER_INTERVAL_MS);
  timer.unref?.();

  return {
    touch() {
      output = true;
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      if (retry !== undefined) clearTimeout(retry);
      try {
        if (sock !== undefined && (sock.readyState === OPEN || sock.readyState === CONNECTING)) sock.close();
      } catch {
        // 閉じる時の失敗は握る
      }
    },
  };
}
