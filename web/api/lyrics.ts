/**
 * window.api.lyrics mock：歌词匹配转发到 server /api/lyric
 */
import type { LyricsApi } from "@shared/types/lyrics";
import type { LyricMatchResponse, LyricTTMLResponse } from "@shared/types/lyrics";
import type { Track } from "@shared/types/player";
import type { Platform } from "@shared/types/platform";

const post = async (path: string, body: unknown): Promise<Response> =>
  fetch(`/api/lyric/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const lyricsApi: LyricsApi = {
  async matchById(platform: Platform, id: string): Promise<LyricMatchResponse> {
    try {
      const res = await post("matchById", { platform, id });
      return (await res.json()) as LyricMatchResponse;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "network error" };
    }
  },

  async matchByQuery(platform: Platform, track: Track): Promise<LyricMatchResponse> {
    try {
      const res = await post("matchByQuery", { platform, track });
      return (await res.json()) as LyricMatchResponse;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "network error" };
    }
  },

  async fetchTTMLOverlay(
    track: Track,
    platform: "netease" | "qqmusic",
  ): Promise<LyricTTMLResponse> {
    try {
      const res = await post("ttml", { track, platform });
      return (await res.json()) as LyricTTMLResponse;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "network error" };
    }
  },

  async matchLocalTTML(): Promise<LyricTTMLResponse> {
    // Web 版无本地 TTML 歌词库访问能力
    return { ok: true, data: null };
  },

  async pickLyricRepoDir(): Promise<string | null> {
    // Web 版无目录选择
    return null;
  },
};
