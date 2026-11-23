/**
 * 外部記憶への書き込み（center 側）。設計は docs/design/external-memory.md の「書き込み」。
 * center が記録するのは master-cap の記憶（agent = session の agentId か session 名）: 利用者の発言・master-cap の応答・
 * remote の往復（task / result / report / reply）。cap 側の記憶（agent = cap_id）は書かない。eventId の名前空間は "c1"。
 * 送信は非同期のキュー（./memory.ts）。ここの関数は同期で戻り、投げない。
 */
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  buildEvent,
  createMcpEventSink,
  createMemoryQueue,
  eventAt,
  formatCapResultBody,
  formatReportBody,
  formatTaskBody,
  formatTaskResultBody,
  makeEventId as makeEventIdWith,
  digest8 as digest8With,
  type MemoryEvent,
  type MemoryQueue,
  type MemorySink,
  type McpSdkLike,
  type MemoryTarget,
} from "./memory.js";
import type { CapResultReply, TaskResultReply } from "@agent-hand/bantou-protocol";
import type { CapWorkerReportNotice } from "./remotes.js";
import { HOOK_TS_FIELD } from "./session-activity.js";
import { expandEnvRefs, headerOf, memoryDefOf, type McpServerDef } from "./mcp-server-def.js";
import type { Logger } from "./log.js";

export const CENTER_EVENT_NS = "c1";

/** sha256 hex（protocol の共有モジュールは node:crypto を持たないので、ここで注入する）。 */
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const makeEventId = (ns: string, ...parts: Array<string | number>): string => makeEventIdWith(sha256, ns, ...parts);
const digest8 = (s: string): string => digest8With(sha256, s);

/** 実 MCP client（Streamable HTTP）の sink。 */
export function createCenterMemorySink(): MemorySink {
  return createMcpEventSink({ Client, StreamableHTTPClientTransport } as unknown as McpSdkLike, { clientName: "bantou-center" });
}

export interface CenterMemoryEvents {
  /** hook の payload（UserPromptSubmit の prompt / Stop の last_assistant_message）を event にして積む。 */
  onHook(session: string, payload: unknown): void;
  /** remote_send の送信（kind: task）。 */
  task(session: string, t: { capId: string; taskId: string; goal: string; repo?: string; branch?: string; constraints?: string[]; parentRequirementId?: string; at?: number }): void;
  /** cap_result / task_result の受信（kind: result）。error 返信は記録しない。 */
  result(session: string, reply: CapResultReply | TaskResultReply, at?: number): void;
  /** worker_report の受信（kind: report）。 */
  report(session: string, n: CapWorkerReportNotice): void;
  /** worker_reply の送信（kind: reply）。 */
  reply(session: string, r: { capId: string; workerId: string; text: string; taskId?: string; at?: number }): void;
  /**
   * リセッションの引継ぎ（kind: handoff）を memory に書き、受理（recorded / duplicate）を待つ（キューを通さない。再起動の前に受理を確かめるため）。
   * memory の設定が無い（書き込み先が無い）時は "none"。届かない・拒否された時は投げる。
   */
  handoff(session: string, h: { id: string; body: string; at?: number }, timeoutMs?: number): Promise<"memory" | "none">;
  /**
   * リセッションの引継ぎ（kind: handoff）の本文を memory から id で読む（`handoff` の隣。設計 10.7 の W1）。
   * 戻り: memory の設定が無い／読む口が無い → "none"、memory が「無い」と答えた → "missing"、本文があれば `{ body }`。
   * 届かない・拒否された・待ちが過ぎた時は投げる。
   */
  readHandoff(session: string, id: string, timeoutMs?: number): Promise<"none" | "missing" | { body: string }>;
  /** 積んだ分が空になるまで待つ（テスト・終了用）。 */
  drain(timeoutMs?: number): Promise<boolean>;
  close(): void;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

export function createCenterMemoryEvents(opts: {
  /** その session の外部記憶（共通 + session の合成後）。無ければ何もしない。 */
  memoryOf: (session: string) => McpServerDef | undefined;
  log: Logger;
  sink?: MemorySink;
  queue?: MemoryQueue;
  now?: () => number;
}): CenterMemoryEvents {
  const now = opts.now ?? Date.now;
  const sink = opts.sink ?? createCenterMemorySink();
  const queue =
    opts.queue ??
    createMemoryQueue({
      sink,
      log: opts.log,
      label: "memory",
    });

  /** http 以外の外部記憶（stdio・sse など）を書けないと log に出した session（1 度だけ出す）。 */
  const notHttp = new Set<string>();
  const targetOf = (session: string): MemoryTarget | undefined => {
    let m: McpServerDef | undefined;
    try {
      // 旧形式 { url, token, agentId } も読み替える
      m = memoryDefOf(opts.memoryOf(session));
    } catch {
      return undefined;
    }
    if (!m) return undefined;
    // center が書けるのは MCP Streamable HTTP（type: "http"）の外部記憶だけ。他は session の claude の道具としてだけ載る
    if (m.type !== "http" || typeof m.url !== "string") {
      if (!notHttp.has(session)) {
        notHttp.add(session);
        opts.log(`memory: 外部記憶の type が http でないので、center からの書き込みはしない（session の道具としては載る）: session=${session}`);
      }
      return undefined;
    }
    notHttp.delete(session);
    // ${VAR} は claude と同じく環境変数で展開する（center の環境）
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((m.headers as Record<string, unknown> | undefined) ?? {})) {
      if (typeof v === "string" && k.toLowerCase() !== "x-agent-id") headers[k] = expandEnvRefs(v);
    }
    const agent = headerOf(m.headers, "X-Agent-Id");
    return { url: expandEnvRefs(m.url), headers, agentId: agent !== undefined ? expandEnvRefs(agent) : session };
  };

  const push = (session: string, make: () => MemoryEvent | undefined): void => {
    try {
      const target = targetOf(session);
      if (!target) return;
      const ev = make();
      if (ev) queue.enqueue(session, target, ev);
    } catch (e) {
      opts.log(`memory: event を作れない: session=${session} ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return {
    onHook(session, payload) {
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
      const p = payload as Record<string, unknown>;
      const name = str(p.hook_event_name);
      if (name !== "UserPromptSubmit" && name !== "Stop") return;
      push(session, () => {
        const text = name === "UserPromptSubmit" ? str(p.prompt) : str(p.last_assistant_message);
        if (text === undefined) return undefined;
        const rawTs = p[HOOK_TS_FIELD];
        const ts = typeof rawTs === "number" && Number.isFinite(rawTs) ? rawTs : now();
        const pid = str(p.prompt_id) ?? "-";
        // 同じ hook 呼び出しの再送は ts と本文が同じ = 同じ id。別の発言は ts か本文の digest が違う
        const id = makeEventId(CENTER_EVENT_NS, session, name === "UserPromptSubmit" ? "u" : "a", pid, ts, digest8(text));
        return buildEvent({
          eventId: id,
          sender: { session },
          recipient: { session },
          kind: name === "UserPromptSubmit" ? "user_prompt" : "assistant_message",
          body: text,
          at: eventAt(ts, now()),
        });
      });
    },

    task(session, t) {
      push(session, () => {
        return buildEvent({
          eventId: makeEventId(CENTER_EVENT_NS, session, "task", t.taskId),
          sender: { session },
          recipient: { capId: t.capId },
          remoteId: t.capId,
          taskId: t.taskId,
          ...(t.parentRequirementId ? { parentRequirementId: t.parentRequirementId } : {}),
          kind: "task",
          body: formatTaskBody(t),
          at: eventAt(t.at, now()),
        });
      });
    },

    result(session, reply, at) {
      push(session, () => {
        if (reply.type === "task_result") {
          const body = formatTaskResultBody(reply);
          // 同じ task_id の結果は何度も来うる（report 起因の task_result）。本文が同じなら同じ id、違えば別 id
          return buildEvent({
            eventId: makeEventId(CENTER_EVENT_NS, session, "result", reply.task_id, digest8(body)),
            sender: { capId: reply.cap_id },
            recipient: { session },
            remoteId: reply.cap_id,
            taskId: reply.task_id,
            kind: "result",
            body,
            at: eventAt(at, now()),
          });
        }
        const body = formatCapResultBody(reply);
        const t = at ?? now();
        return buildEvent({
          eventId: makeEventId(CENTER_EVENT_NS, session, "result", reply.cap_id, "cap", t, digest8(body)),
          sender: { capId: reply.cap_id },
          recipient: { session },
          remoteId: reply.cap_id,
          kind: "result",
          body,
          at: eventAt(t, now()),
        });
      });
    },

    report(session, n) {
      push(session, () =>
        buildEvent({
          eventId: makeEventId(CENTER_EVENT_NS, session, "report", n.cap_id, n.worker_id, Date.parse(n.at) || n.at, digest8(n.text)),
          sender: { workerId: n.worker_id },
          recipient: { session },
          remoteId: n.cap_id,
          ...(n.task_id ? { taskId: n.task_id } : {}),
          kind: "report",
          body: formatReportBody(n.kind, n.text),
          at: eventAt(n.at, now()),
        }),
      );
    },

    reply(session, r) {
      push(session, () => {
        const t = r.at ?? now();
        return buildEvent({
          eventId: makeEventId(CENTER_EVENT_NS, session, "reply", r.capId, r.workerId, t, digest8(r.text)),
          sender: { session },
          recipient: { workerId: r.workerId },
          remoteId: r.capId,
          ...(r.taskId ? { taskId: r.taskId } : {}),
          kind: "reply",
          body: r.text,
          at: eventAt(t, now()),
        });
      });
    },

    async handoff(session, h, timeoutMs = 20_000) {
      const target = targetOf(session);
      if (!target) return "none";
      const ev = buildEvent({
        eventId: h.id,
        sender: { session },
        recipient: { session },
        kind: "handoff",
        body: h.body,
        at: eventAt(h.at, now()),
      });
      if (!ev) throw new Error("引継ぎの本文が空");
      // 引き渡すのは省略していない本文だけ（切り詰めると続きが失われる）
      if (ev.body !== h.body) throw new Error("引継ぎの本文が長すぎる（65536 文字まで）");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          sink.send(target, ev),
          new Promise<never>((_, rej) => {
            timer = setTimeout(() => rej(new Error(`memory の受理を ${timeoutMs}ms 待ったが来ない`)), timeoutMs);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      return "memory";
    },

    async readHandoff(session, id, timeoutMs = 20_000) {
      const target = targetOf(session);
      if (!target || !sink.readHandoff) return "none";
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const r = await Promise.race([
          sink.readHandoff(target, id, timeoutMs),
          new Promise<never>((_, rej) => {
            timer = setTimeout(() => rej(new Error(`memory の応答を ${timeoutMs}ms 待ったが来ない`)), timeoutMs);
            timer.unref?.();
          }),
        ]);
        return r === null ? "missing" : { body: r.body };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },

    drain: (t) => queue.drain(t),
    close: () => queue.close(),
  };
}
