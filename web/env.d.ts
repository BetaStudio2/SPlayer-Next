/// <reference types="vite/client" />

import type { WebApi } from "./api";

declare global {
  interface Window {
    api: WebApi;
    electron: {
      process: { platform: string; versions: Record<string, unknown> };
      ipcRenderer: {
        send: (...args: unknown[]) => void;
        invoke: (...args: unknown[]) => Promise<unknown>;
        on: (channel: string, listener: (...args: unknown[]) => void) => () => void;
      };
    };
  }
}
