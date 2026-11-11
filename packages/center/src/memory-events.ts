/**
 * 外部記憶への書き込み（center 側）。設計は docs/design/external-memory.md の「書き込み」。
 * center が記録するのは master-cap の記憶（agent = session の agentId か session 名）: 利用者の発言・master-cap の応答・
 * remote の往復（task / result / report / reply）。cap 側の記憶（agent = cap_id）は server が書く。eventId の名前空間は "c1"（server は "s1"）。
 * 送信は非同期のキュー（packages/protocol の memory.ts）。ここの関数は同期で戻り、投げない。
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
  type CapResultReply,
  type MemoryEvent,
  type MemoryQueue,
  type MemorySink,
  type McpSdkLike,
  type MemoryTarget,
  type TaskResultReply,
  type WorkerReportNotice,
} from "@agent-hand/bantou-protocol";
import { HOOK_TS_FIELD } from "./session-activity.js";
import type { MemorySetting } from "./project-settings.js";
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
  task(session: string, t: { capId: string; taskId: string; goal: string; repo?: string; branch?: string; constraints?: string[]; at?: number }): void;
  /** cap_result / task_result の受信（kind: result）。error 返信は記録しない。 */
  result(session: string, reply: CapResultReply | TaskResultReply, at?: number): void;
  /** worker_report の受信（kind: report）。 */
  report(session: string, n: WorkerReportNotice): void;
  /** worker_reply の送信（kind: reply）。 */
  reply(session: string, r: { capId: string; workerId: string; text: string; taskId?: string; at?: number }): void;
  /** 積んだ分が空になるまで待つ（テスト・終了用）。 */
  drain(timeoutMs?: number): Promise<boolean>;
  close(): void;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

export function createCenterMemoryEvents(opts: {
  /** その session の外部記憶（共通 + session の合成後）。無ければ何もしない。 */
  memoryOf: (session: string) => MemorySetting | undefined;
  log: Logger;
  sink?: MemorySink;
  queue?: MemoryQueue;
  now?: () => number;
}): CenterMemoryEvents {
  const now = opts.now ?? Date.now;
  const queue =
    opts.queue ??
    createMemoryQueue({
      sink: opts.sink ?? createCenterMemorySink(),
      log: opts.log,
      label: "memory",
    });

  const targetOf = (session: string): MemoryTarget | undefined => {
    let m: MemorySetting | undefined;
    try {
      m = opts.memoryOf(session);
    } catch {
      return undefined;
    }
    if (!m) return undefined;
    return { url: m.url, ...(m.token ? { token: m.token } : {}), agentId: m.agentId ?? session };
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

    drain: (t) => queue.drain(t),
    close: () => queue.close(),
  };
}
