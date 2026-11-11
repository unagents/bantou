/**
 * 外部記憶への書き込み（server 側）。設計は docs/design/external-memory.md の「書き込み」。
 * server が記録するのは cap の記憶（X-Agent-Id = task の memory.agent_id。center は cap_id を入れる）: cap が受けた task、
 * worker の report、cap が worker へ出した reply、cap の result。master-cap の記憶（agent = session）は center が書く。
 * eventId の名前空間は "s1"（center は "c1"）。memory の endpoint と token は task で center から受け取り、cap ごとに
 * メモリだけで持つ（ファイルに書かない・log に出さない）。task ごとに置き換わり、memory 無しの task は消す。
 * 送信は非同期のキュー（packages/protocol の memory.ts）。ここの関数は同期で戻り、投げない。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  buildEvent,
  createMcpEventSink,
  createMemoryQueue,
  digest8,
  eventAt,
  formatCapResultBody,
  formatReportBody,
  formatTaskBody,
  formatTaskResultBody,
  makeEventId,
  readTaskMemory,
  type CapResultReply,
  type McpSdkLike,
  type MemoryQueue,
  type MemorySink,
  type MemoryTarget,
  type TaskCommand,
  type TaskResultReply,
  type TaskMemory,
} from "@agent-hand/bantou-protocol";

export const SERVER_EVENT_NS = "s1";

export function createServerMemorySink(): MemorySink {
  return createMcpEventSink({ Client, StreamableHTTPClientTransport } as unknown as McpSdkLike, { clientName: "bantou-server" });
}

export interface ServerMemory {
  /** task を受け付けた時（updating で断る時は呼ばない）。memory を置き換え（無ければ消し）、task event を積む。 */
  onTask(cmd: TaskCommand): void;
  /** worker の report を受けた時（kind: report）。 */
  onReport(capId: string, workerId: string, kind: string, text: string, at: string, taskId?: string): void;
  /** worker_reply を worker に渡せた時（kind: reply）。 */
  onWorkerReply(capId: string, workerId: string, text: string, at?: number): void;
  /** cap_result / task_result を center へ返す時（kind: result）。error は記録しない。 */
  onResult(reply: { type: string; cap_id?: string }): void;
  drain(timeoutMs?: number): Promise<boolean>;
  close(): void;
}

interface CapMemory {
  target: MemoryTarget;
  session?: string;
}

export function createServerMemory(opts: {
  log: (line: string) => void;
  sink?: MemorySink;
  queue?: MemoryQueue;
  now?: () => number;
}): ServerMemory {
  const now = opts.now ?? Date.now;
  const queue = opts.queue ?? createMemoryQueue({ sink: opts.sink ?? createServerMemorySink(), log: opts.log, label: "memory" });
  const caps = new Map<string, CapMemory>();

  const set = (capId: string, m: TaskMemory | undefined): void => {
    if (!m) {
      caps.delete(capId);
      return;
    }
    caps.set(capId, { target: { url: m.url, ...(m.token ? { token: m.token } : {}), agentId: m.agent_id ?? capId }, ...(m.session ? { session: m.session } : {}) });
  };

  const push = (capId: string, make: (c: CapMemory) => ReturnType<typeof buildEvent>): void => {
    try {
      const c = caps.get(capId);
      if (!c) return;
      const ev = make(c);
      if (ev) queue.enqueue(capId, c.target, ev);
    } catch (e) {
      opts.log(`memory: event を作れない: cap_id=${capId} ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const counterpart = (c: CapMemory) => (c.session ? { session: c.session } : {});

  return {
    onTask(cmd) {
      try {
        set(cmd.cap_id, readTaskMemory((cmd as { memory?: unknown }).memory));
      } catch {
        caps.delete(cmd.cap_id);
      }
      push(cmd.cap_id, (c) =>
        buildEvent({
          eventId: makeEventId(SERVER_EVENT_NS, cmd.cap_id, "task", cmd.task_id),
          sender: counterpart(c),
          recipient: { capId: cmd.cap_id },
          remoteId: cmd.cap_id,
          taskId: cmd.task_id,
          kind: "task",
          body: formatTaskBody({ goal: cmd.goal, ...(cmd.repo ? { repo: cmd.repo } : {}), ...(cmd.branch ? { branch: cmd.branch } : {}), constraints: cmd.constraints }),
          at: eventAt(undefined, now()),
        }),
      );
    },

    onReport(capId, workerId, kind, text, at, taskId) {
      push(capId, () =>
        buildEvent({
          eventId: makeEventId(SERVER_EVENT_NS, capId, "report", workerId, Date.parse(at) || at, digest8(text)),
          sender: { workerId },
          recipient: { capId },
          remoteId: capId,
          ...(taskId ? { taskId } : {}),
          kind: "report",
          body: formatReportBody(kind, text),
          at: eventAt(at, now()),
        }),
      );
    },

    onWorkerReply(capId, workerId, text, at) {
      push(capId, (c) => {
        const t = at ?? now();
        return buildEvent({
          eventId: makeEventId(SERVER_EVENT_NS, capId, "reply", workerId, t, digest8(text)),
          sender: counterpart(c),
          recipient: { workerId },
          remoteId: capId,
          kind: "reply",
          body: text,
          at: eventAt(t, now()),
        });
      });
    },

    onResult(reply) {
      if (reply.type !== "task_result" && reply.type !== "cap_result") return;
      const capId = reply.cap_id;
      if (capId === undefined) return;
      push(capId, (c) => {
        if (reply.type === "task_result") {
          const r = reply as TaskResultReply;
          const body = formatTaskResultBody(r);
          return buildEvent({
            eventId: makeEventId(SERVER_EVENT_NS, capId, "result", r.task_id, digest8(body)),
            sender: { capId },
            recipient: counterpart(c),
            remoteId: capId,
            taskId: r.task_id,
            kind: "result",
            body,
            at: eventAt(undefined, now()),
          });
        }
        const r = reply as CapResultReply;
        const body = formatCapResultBody(r);
        const t = now();
        return buildEvent({
          eventId: makeEventId(SERVER_EVENT_NS, capId, "result", "cap", t, digest8(body)),
          sender: { capId },
          recipient: counterpart(c),
          remoteId: capId,
          kind: "result",
          body,
          at: eventAt(t, now()),
        });
      });
    },

    drain: (t) => queue.drain(t),
    close: () => queue.close(),
  };
}
