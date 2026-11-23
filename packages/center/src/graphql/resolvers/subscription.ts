import { GraphQLError } from "graphql";
import type { CoreEvent } from "../../core.js";
import { packageVersion } from "../../version.js";
import type { GraphqlContext } from "../context.js";

/**
 * Subscription の resolver（schema-subscription.ts の field と 1 対 1）。
 * center の既存の仕組み（EventHub・core の subscribe）に購読するだけで、既存の経路（/events・/sessions/<n>/output）は変えない。
 * subscribe は AsyncIterable を返し、client の切断・購読解除で yoga が return() を呼ぶ → 元の購読を外す。
 */
interface SubscriptionField {
  subscribe: (parent: unknown, args: Record<string, unknown>, ctx: GraphqlContext) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
  resolve?: (payload: unknown, args: Record<string, unknown>, ctx: GraphqlContext) => unknown;
}

/**
 * push 型の購読（listener）を AsyncIterator にする。`attach` は元の購読を張り、解除関数を返す
 * （張れない時は null）。attach の途中（同期）で届いた物も取りこぼさず queue に積む。
 * return()（購読解除・切断）と、元が終わった（end）時に、必ず 1 度だけ解除する。
 */
function listen<T>(attach: (emit: (v: T) => void, end: () => void) => (() => void) | null): AsyncIterableIterator<T> {
  const buffer: T[] = [];
  const waiting: ((r: IteratorResult<T>) => void)[] = [];
  let done = false;
  let unsub: (() => void) | null = null;
  const release = () => {
    const u = unsub;
    unsub = null;
    u?.();
  };
  const finish = () => {
    if (done) return;
    done = true;
    release();
    for (const w of waiting.splice(0)) w({ value: undefined, done: true });
  };
  const emit = (v: T) => {
    if (done) return;
    const w = waiting.shift();
    if (w) w({ value: v, done: false });
    else buffer.push(v);
  };
  // attach 中に end が同期で来ても、解除関数を受け取った後に外せるようにする
  const u = attach(emit, finish);
  if (u === null) done = true;
  else if (done) u();
  else unsub = u;
  return {
    next() {
      if (buffer.length > 0) return Promise.resolve({ value: buffer.shift() as T, done: false });
      if (done) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => waiting.push(resolve));
    },
    return() {
      buffer.length = 0;
      finish();
      return Promise.resolve({ value: undefined, done: true });
    },
    throw(e) {
      finish();
      return Promise.reject(e);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}


/** Core の event を schema の TerminalEvent にする。end は status "end"（その後 stream は閉じる）。 */
function terminalEvent(ev: CoreEvent) {
  if (ev.type === "chunk") return { type: "output", id: ev.id, data: ev.data.toString("base64"), status: null };
  if (ev.type === "reset") return { type: "reset", id: null, data: null, status: null };
  return { type: "status", id: null, data: null, status: "end" };
}

/** payload（iterator が流した値）をそのまま field の値にする。無いと graphql-js は payload[field名] を探す。 */
const asValue = (payload: unknown) => payload;

const fields: Record<string, SubscriptionField> = {
  sessionsChanged: {
    subscribe: (_p, _a, { services }) => listen((emit) => services.events.subscribe(emit)),
  },
  sessionMessage: {
    subscribe: (_p, _a, { services }) => listen((emit) => services.events.subscribeMessage(emit)),
  },
  terminalOutput: {
    subscribe: (_p, args, { services }) => {
      const session = String(args.session);
      const after = typeof args.after === "number" ? args.after : undefined;
      // 未登録の session は /sessions/<n>/output の 404 と同じ扱い
      if (!services.core.has(session)) throw new GraphQLError(`未定義の session: ${session}`, { extensions: { code: "NOT_FOUND" } });
      return listen<ReturnType<typeof terminalEvent>>((emit, end) => {
        const unsub = services.core.subscribe(session, after, (ev) => {
          emit(terminalEvent(ev));
          if (ev.type === "end") end();
        });
        return unsub;
      });
    },
  },
  // 画面が remote_list を取り直す契機。今の画面は SessionsEvent の reason = remote と activity で取り直している（設計書 2.3）
  remotesChanged: {
    subscribe: (_p, _a, { services }) =>
      listen((emit) =>
        services.events.subscribe((ev) => {
          if (ev.reason === "remote" || ev.reason === "activity") emit(ev);
        }),
      ),
  },
  // center 自身の状態。購読した時点の状態を 1 つ返し、以降は client が切るまで開いておく（center が止まれば接続が切れる）。
  // authRequired は center 単位の認証状態を持たないので null（nullable）。
  centerStatus: {
    subscribe: () =>
      listen((emit) => {
        emit({ version: packageVersion(), running: true, authRequired: null });
        return () => {};
      }),
  },
};

export const subscriptionResolvers: Record<string, SubscriptionField> = Object.fromEntries(
  Object.entries(fields).map(([k, f]) => [k, { ...f, resolve: asValue }]),
);
