/**
 * window.api.streaming mock：流媒体服务器凭据转发到 server /api/streaming
 *
 * 凭据在服务端 AES-256-GCM 加密存储（data/config/streaming.json），
 * 避免浏览器 localStorage 明文泄露密码。
 * 前端拿到的是解密后的明文，仅在内存中使用。
 */
import type { StreamingApi, StreamingServerConfig } from "@shared/types/streaming";

interface Stored {
  servers: StreamingServerConfig[];
  activeServerId: string | null;
}

export const streamingApi: StreamingApi = {
  async loadServers(): Promise<Stored> {
    try {
      const res = await fetch("/api/streaming");
      if (!res.ok) return { servers: [], activeServerId: null };
      return (await res.json()) as Stored;
    } catch {
      return { servers: [], activeServerId: null };
    }
  },

  async saveServers(payload: Stored): Promise<void> {
    try {
      await fetch("/api/streaming", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      /* 保存失败静默，前端 store 会重试 */
    }
  },
};
