/**
 * Browser-side entry of the E2E mock (careery e2e/mock/install.ts pattern):
 * bundled to an IIFE and injected with `addInitScript`, so
 * `@tauri-apps/api`'s `invoke` hits the mock via `window.__TAURI_INTERNALS__`.
 */
import { MockBantou, type Seed } from "./bantou";

declare global {
  interface Window {
    __BANTOU_E2E_SEED__?: Seed;
    __BANTOU_MOCK__?: MockBantou;
    __TAURI_INTERNALS__?: Record<string, unknown>;
  }
}

const mock = new MockBantou(window.__BANTOU_E2E_SEED__ ?? { dir: null, tasks: [], threads: [] });
window.__BANTOU_MOCK__ = mock;

const callbacks = new Map<number, (payload: unknown) => void>();
let nextCallbackId = 1;

mock.emitter = (event, payload) => {
  for (const id of mock.listenerIds(event)) {
    callbacks.get(id)?.({ event, id, payload });
  }
};

window.__TAURI_INTERNALS__ = {
  metadata: {
    currentWindow: { label: "main" },
    currentWebview: { windowLabel: "main", label: "main" },
  },
  invoke(cmd: string, args: unknown) {
    try {
      return Promise.resolve(mock.invoke(cmd, args));
    } catch (e) {
      return Promise.reject(e instanceof Error ? e.message : String(e));
    }
  },
  transformCallback(callback: (payload: unknown) => void, once = false) {
    const id = nextCallbackId++;
    callbacks.set(id, (payload) => {
      if (once) callbacks.delete(id);
      callback(payload);
    });
    return id;
  },
  unregisterCallback(id: number) {
    callbacks.delete(id);
  },
  runCallback(id: number, payload: unknown) {
    callbacks.get(id)?.(payload);
  },
  convertFileSrc(p: string) {
    return p;
  },
};
