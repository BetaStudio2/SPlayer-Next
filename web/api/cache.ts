/**
 * window.api.cache mock：Web 版无文件缓存能力
 * song.lookup 返回 null（不走本地缓存），其余降级
 */
import type { TrackSource } from "@shared/types/player";

export const cacheApi = {
  async getStats(): Promise<
    { id: string; kind: "file" | "db"; path: string; size: number }[]
  > {
    return [];
  },

  async clear(): Promise<void> {
    /* no-op */
  },

  async clearAllByKind(): Promise<void> {
    /* no-op */
  },

  async getDir(): Promise<string> {
    return "indexeddb://cache";
  },

  async pickDir(): Promise<{ ok: boolean; dir: string; reason?: "canceled" | "notEmpty" }> {
    return { ok: false, dir: "", reason: "canceled" };
  },

  async resetDir(): Promise<string> {
    return "indexeddb://cache";
  },

  song: {
    async lookup(): Promise<string | null> {
      // Web 版不使用本地音频缓存，强制走原始源
      return null;
    },

    async fetch(): Promise<string | null> {
      // 不缓存，直接返回 null（renderer 会用原始 url）
      return null;
    },

    async cancel(): Promise<void> {
      /* no-op */
    },
  },
};
