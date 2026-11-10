/** center のセッション増減・状態変化の通知（GET /events の SSE に流す）。changed = 認証状態（auth / loginUrl / loginError）が変わった。 */
export interface SessionsEvent {
  /** updated = 名前か path を変えた（name は新しい名前）。context = コンテキスト使用状況が変わった（受け手は session_list を取り直す）。activity = 作業状態（working / needs-input / idle）が変わった（同じく取り直す）。remote = その session の remote 集計（session_list の remote）が変わった（同じく取り直す）。changed = 認証状態（auth / loginUrl / loginError）が変わった（同じく取り直す）。 */
  reason: "created" | "deleted" | "restored" | "updated" | "context" | "activity" | "remote" | "changed";
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
