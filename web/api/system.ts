/**
 * window.api.system mock：部分实现
 */
import type { IpcResponse } from "@shared/types/player";
import type { LocaleCode } from "@shared/types/settings";

const ok = <T>(data?: T): IpcResponse<T> => ({ success: true, data });

const openSettingsCallbacks = new Set<(p: { category?: string; highlight?: string }) => void>();
const protocolCallbacks = new Set<(url: string) => void>();

export const systemApi = {
  async toggleDevTools(): Promise<void> {
    /* no-op */
  },

  async showInExplorer(): Promise<void> {
    /* Web 版无文件管理器 */
  },

  async openLogsDir(): Promise<string> {
    return "/api/logs";
  },

  setLocale(_locale: LocaleCode): void {
    /* Web 版无需同步 locale 到主进程 */
  },

  async focusMainWindow(): Promise<void> {
    window.focus();
  },

  async openSettings(category?: string, highlight?: string): Promise<void> {
    openSettingsCallbacks.forEach((cb) => cb({ category, highlight }));
  },

  onOpenSettings(
    callback: (payload: { category?: string; highlight?: string }) => void,
  ): () => void {
    openSettingsCallbacks.add(callback);
    return () => openSettingsCallbacks.delete(callback);
  },

  async listFonts(): Promise<string[]> {
    // Web 版无法枚举系统字体，返回通用栈
    return [
      "-apple-system, BlinkMacSystemFont, sans-serif",
      "Segoe UI, sans-serif",
      "Roboto, sans-serif",
      "PingFang SC, sans-serif",
      "Microsoft YaHei, sans-serif",
      "Noto Sans SC, sans-serif",
      "monospace",
    ];
  },

  async fetchRemoteBytes(url: string): Promise<IpcResponse<ArrayBuffer | null>> {
    try {
      const res = await fetch(url);
      const buf = await res.arrayBuffer();
      return ok(buf);
    } catch {
      return ok(null);
    }
  },

  async saveFile(
    data: ArrayBuffer,
    fileName: string,
  ): Promise<{ success: boolean; path?: string; error?: string }> {
    try {
      const blob = new Blob([data]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      return { success: true, path: fileName };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "save failed" };
    }
  },

  async relaunch(): Promise<void> {
    location.reload();
  },

  onProtocolUrl(callback: (url: string) => void): () => void {
    protocolCallbacks.add(callback);
    return () => protocolCallbacks.delete(callback);
  },

  async consumePendingProtocolUrl(): Promise<string | null> {
    return null;
  },
};
