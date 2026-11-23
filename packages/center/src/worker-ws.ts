import { timingSafeEqual, createHash } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData } from "ws";
import type { Logger } from "./log.js";

/** worker の ws の口の path。server の worker の tracker が launch の `ws` の宛先（`ws://<host>:<port>/ws/worker?token=<token>`）に繋ぐ。 */
export const WORKER_WS_PATH = "/ws/worker";

/** 最後の書き込みからこれだけ無音なら「止まっている」。 */
export const SILENT_MS = 60_000;

/** worker の tracker が 1 行書く内容（出力が在った時だけ、5 秒間隔）。 */
export interface WorkerLine {
  "parent-id": string;
  /** ISO 8601 */
  at: string;
}

export type WorkerState = "running" | "stopped";

/** parent-id（cap の名前）ごとの最後の書き込みの時刻。 */
export interface WorkerTracker {
  /** 「止まっている」と見なす無音の長さ（ms）。 */
  readonly silentMs: number;
  /** 書き込みを記録する（時刻は center が受けた時刻。tracker の `at` は検証だけに使う）。 */
  note(parentId: string): void;
  /** launch を送った時刻の基準（まだ書き込みが無い間も、60 秒は running と見せる）。 */
  launched(parentId: string): void;
  /** 記録を消す（remote_stop）。 */
  forget(parentId: string): void;
  /** 最後の書き込み（無ければ launch）の時刻（ms）。無ければ undefined。 */
  lastAt(parentId: string): number | undefined;
  /** 最後の書き込みの時刻から SILENT_MS 以内なら running、それ以外は stopped。 */
  stateOf(parentId: string): WorkerState;
  /** 状態が変わりうる（書き込みを受けた・消えた）時に呼ぶ。 */
  onChange(fn: (parentId: string) => void): () => void;
}

export function createWorkerTracker(opts: { now?: () => number; silentMs?: number } = {}): WorkerTracker {
  const now = opts.now ?? Date.now;
  const silentMs = opts.silentMs ?? SILENT_MS;
  const last = new Map<string, number>();
  const listeners = new Set<(parentId: string) => void>();
  const emit = (id: string): void => {
    for (const l of [...listeners]) l(id);
  };
  return {
    silentMs,
    note(id) {
      last.set(id, now());
      emit(id);
    },
    launched(id) {
      last.set(id, now());
      emit(id);
    },
    forget(id) {
      last.delete(id);
      emit(id);
    },
    lastAt: (id) => last.get(id),
    stateOf(id) {
      const t = last.get(id);
      return t !== undefined && now() - t < silentMs ? "running" : "stopped";
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** text frame（1 行の JSON。改行区切りの連続も受ける）から WorkerLine を取り出す。不正な行は捨てる。 */
export function parseWorkerLines(text: string): WorkerLine[] {
  const out: WorkerLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (typeof v !== "object" || v === null || Array.isArray(v)) continue;
      const r = v as Record<string, unknown>;
      const id = r["parent-id"];
      const at = r.at;
      if (typeof id !== "string" || id.length === 0 || id.includes("\0")) continue;
      if (typeof at !== "string" || Number.isNaN(Date.parse(at))) continue;
      out.push({ "parent-id": id, at });
    } catch {
      // 行として不正: 捨てる
    }
  }
  return out;
}

const isLoopbackOrWildcard = (h: string): boolean => ["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0", "::", "[::]"].includes(h);

/**
 * launch の `ws`（center の ws の宛先）。`ws://<host>:<port>/ws/worker?token=<token>`。
 * host は publicHost（config）、無ければ bind（loopback・wildcard 以外の時だけ）。決まらなければ undefined。
 */
export function workerWsUrl(opts: { bind: string; port: number; token: string; publicHost?: string }): string | undefined {
  const h = workerHostOf(opts);
  if (h === undefined) return undefined;
  return `ws://${h}:${opts.port}${WORKER_WS_PATH}?token=${encodeURIComponent(opts.token)}`;
}

/** worker から見える center の host（URL に書ける形）。`ws` と同じ元: publicHost、無ければ bind（loopback・wildcard 以外の時だけ）。決まらなければ undefined。 */
export function workerHostOf(opts: { bind: string; publicHost?: string }): string | undefined {
  const host = opts.publicHost ?? (isLoopbackOrWildcard(opts.bind) ? undefined : opts.bind);
  if (host === undefined) return undefined;
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

/** query の token が center の token と一致するか（定時間比較）。 */
export function tokenMatches(given: string | null, token: string): boolean {
  if (given === null) return false;
  return timingSafeEqual(digest(given), digest(token));
}

const reject = (socket: Duplex, status: string): void => {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
};

/**
 * http server の upgrade に WORKER_WS_PATH の ws の口を付ける。認証は center の既存の token を query `?token=`（無ければ Authorization: Bearer）で受ける。
 * 受けた 1 行ごとに tracker.note(parent-id)。返事は書かない。戻り値は後始末。
 */
export function attachWorkerWs(http: Server, opts: { token: string; tracker: WorkerTracker; log: Logger }): { close: () => void } {
  const { token, tracker, log } = opts;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      return reject(socket, "400 Bad Request");
    }
    if (url.pathname !== WORKER_WS_PATH) return reject(socket, "404 Not Found"); // center に他の ws の口は無い
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? null;
    if (!tokenMatches(url.searchParams.get("token") ?? bearer, token)) {
      log("worker ws: 認証失敗");
      return reject(socket, "401 Unauthorized");
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      log("worker ws: 接続");
      ws.on("message", (data: RawData, isBinary: boolean) => {
        if (isBinary) return;
        for (const l of parseWorkerLines(data.toString("utf8"))) tracker.note(l["parent-id"]);
      });
      ws.on("close", () => log("worker ws: 切断"));
      ws.on("error", (e) => log(`worker ws: error ${e.message}`));
    });
  };
  http.on("upgrade", onUpgrade);
  return {
    close() {
      http.off("upgrade", onUpgrade);
      for (const c of wss.clients) c.terminate();
      wss.close();
    },
  };
}
