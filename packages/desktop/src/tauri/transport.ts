import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";

// The only place that talks to Tauri's command / event IPC. Command names, event names and payload types are the
// contract shared with the Rust side (and with the e2e mock); a transport only carries them.

/** Stop listening. */
export type UnlistenFn = () => void;

export interface InvokeOptions {
  headers?: Record<string, string>;
  /** Raw request body (sent instead of `args`). */
  body?: Uint8Array;
}

export interface Transport {
  invoke<T>(cmd: string, args?: Record<string, unknown>, opts?: InvokeOptions): Promise<T>;
  listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn>;
}

const tauriTransport: Transport = {
  invoke: <T>(cmd: string, args?: Record<string, unknown>, opts?: InvokeOptions) =>
    opts?.headers
      ? tauriInvoke<T>(cmd, opts.body ?? args, { headers: opts.headers })
      : tauriInvoke<T>(cmd, opts?.body ?? args),
  listen: (event, handler) => tauriListen(event, (e) => handler(e.payload as never)),
};

export const getTransport = (): Transport => tauriTransport;
