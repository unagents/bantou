/** center のセッション増減の通知（GET /events の SSE に流す）。 */
export interface SessionsEvent {
  reason: "created" | "deleted" | "restored";
  name: string;
}

export interface EventHub {
  publish(ev: SessionsEvent): void;
  /** 購読する。戻り値は解除。 */
  subscribe(listener: (ev: SessionsEvent) => void): () => void;
}

export function createEventHub(): EventHub {
  const listeners = new Set<(ev: SessionsEvent) => void>();
  return {
    publish(ev) {
      for (const l of [...listeners]) l(ev);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
