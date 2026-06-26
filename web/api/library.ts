/**
 * window.api.library mock：本地曲库转发到 server /api/music
 */
import type { LibraryApi } from "@shared/types/library";
import type { ScanProgress } from "@shared/types/library";
import type { IpcResponse, Track } from "@shared/types/player";
import type { AlbumSummary, ArtistSummary } from "@shared/types/library";
import { subscribeServerEvent } from "./ws";

const ok = <T>(data?: T): IpcResponse<T> => ({ success: true, data });
const fail = (error: string): IpcResponse<never> => ({ success: false, error });

const get = async <T>(path: string): Promise<T> => {
  const res = await fetch(`/api/music${path}`);
  const body = (await res.json()) as { success: boolean; data: T; error?: string };
  if (!body.success) throw new Error(body.error ?? "unknown");
  return body.data;
};

const post = async <T>(path: string, body?: unknown): Promise<T> => {
  const res = await fetch(`/api/music${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : "{}",
  });
  const json = (await res.json()) as { success: boolean; data: T; error?: string };
  if (!json.success) throw new Error(json.error ?? "unknown");
  return json.data;
};

export const libraryApi: LibraryApi = {
  async scan(incremental = true): Promise<IpcResponse> {
    try {
      await post("/scan", { incremental });
      return ok();
    } catch (err) {
      return fail(err instanceof Error ? err.message : "scan failed");
    }
  },

  async cancelScan(): Promise<IpcResponse> {
    await post("/scan/cancel");
    return ok();
  },

  async getTracks(): Promise<IpcResponse<Track[]>> {
    try {
      return ok(await get<Track[]>("/tracks"));
    } catch (err) {
      return fail(err instanceof Error ? err.message : "failed");
    }
  },

  async getAlbums(): Promise<IpcResponse<AlbumSummary[]>> {
    try {
      return ok(await get<AlbumSummary[]>("/albums"));
    } catch (err) {
      return fail(err instanceof Error ? err.message : "failed");
    }
  },

  async getArtists(): Promise<IpcResponse<ArtistSummary[]>> {
    try {
      return ok(await get<ArtistSummary[]>("/artists"));
    } catch (err) {
      return fail(err instanceof Error ? err.message : "failed");
    }
  },

  async getAlbumTracks(albumName: string): Promise<IpcResponse<Track[]>> {
    try {
      return ok(await get<Track[]>(`/albums/tracks?name=${encodeURIComponent(albumName)}`));
    } catch (err) {
      return fail(err instanceof Error ? err.message : "failed");
    }
  },

  async getArtistTracks(artistName: string): Promise<IpcResponse<Track[]>> {
    try {
      return ok(await get<Track[]>(`/artists/tracks?name=${encodeURIComponent(artistName)}`));
    } catch (err) {
      return fail(err instanceof Error ? err.message : "failed");
    }
  },

  async getTracksByIds(ids: string[]): Promise<IpcResponse<Track[]>> {
    try {
      return ok(await get<Track[]>(`/tracks/by-ids?ids=${ids.join(",")}`));
    } catch (err) {
      return fail(err instanceof Error ? err.message : "failed");
    }
  },

  async searchTracks(query: string): Promise<IpcResponse<Track[]>> {
    try {
      return ok(await get<Track[]>(`/tracks/search?q=${encodeURIComponent(query)}`));
    } catch (err) {
      return fail(err instanceof Error ? err.message : "failed");
    }
  },

  async getTrackCount(): Promise<IpcResponse<number>> {
    try {
      return ok(await get<number>("/tracks/count"));
    } catch (err) {
      return fail(err instanceof Error ? err.message : "failed");
    }
  },

  async getRandomTrack(): Promise<IpcResponse<Track | null>> {
    try {
      return ok(await get<Track | null>("/tracks/random"));
    } catch (err) {
      return fail(err instanceof Error ? err.message : "failed");
    }
  },

  async getRandomTracks(limit: number): Promise<IpcResponse<Track[]>> {
    try {
      return ok(await get<Track[]>(`/tracks/randoms?limit=${limit}`));
    } catch (err) {
      return fail(err instanceof Error ? err.message : "failed");
    }
  },

  async isScanning(): Promise<IpcResponse<boolean>> {
    try {
      const p = await get<{ scanning: boolean }>("/scan/progress");
      return ok(p.scanning);
    } catch (err) {
      return fail(err instanceof Error ? err.message : "failed");
    }
  },

  async addScanDir(dir?: string): Promise<IpcResponse<string>> {
    // Web 版：优先用传入 dir；未传则提示用户输入
    const path = dir ?? window.prompt("输入扫描目录绝对路径（服务端可访问）：");
    if (!path) return fail("canceled");
    try {
      await post<string>("/scan-dirs", { dir: path });
      return ok(path);
    } catch (err) {
      return fail(err instanceof Error ? err.message : "failed");
    }
  },

  async removeScanDir(dir: string): Promise<IpcResponse> {
    try {
      await post("/scan-dirs/remove", { dir });
      return ok();
    } catch (err) {
      return fail(err instanceof Error ? err.message : "failed");
    }
  },

  async getScanDirs(): Promise<IpcResponse<string[]>> {
    try {
      return ok(await get<string[]>("/scan-dirs"));
    } catch (err) {
      return fail(err instanceof Error ? err.message : "failed");
    }
  },

  async deleteTracks(): Promise<IpcResponse<{ deleted: number; failed: number }>> {
    // Web 版无文件删除权限
    return ok({ deleted: 0, failed: 0 });
  },

  async readTags(): Promise<IpcResponse<never>> {
    return fail("Web 版不支持读取本地标签");
  },

  async writeTags(): Promise<IpcResponse<never[]>> {
    return ok([]);
  },

  async pickCoverImage(): Promise<IpcResponse<never>> {
    return fail("Web 版不支持选择本地封面");
  },

  async fetchArtistAvatar(artistName: string): Promise<IpcResponse<string | null>> {
    try {
      return ok(await get<string | null>(`/artists/avatar?name=${encodeURIComponent(artistName)}`));
    } catch (err) {
      return fail(err instanceof Error ? err.message : "failed");
    }
  },

  async prefetchArtistAvatars(
    artistNames: string[],
  ): Promise<IpcResponse<Record<string, string>>> {
    try {
      return ok(
        await post<Record<string, string>>("/artists/avatars/prefetch", artistNames),
      );
    } catch (err) {
      return fail(err instanceof Error ? err.message : "failed");
    }
  },

  onScanProgress(callback: (progress: ScanProgress) => void): () => void {
    // 通过 WebSocket 接收扫描进度推送（server/utils/events.ts 广播）
    const unsub = subscribeServerEvent((event) => {
      if (event.type === "scan:progress" && event.data) {
        const p = event.data as {
          scanning: boolean;
          scanned: number;
          total: number;
          current: string;
        };
        callback({
          phase: p.scanning ? "scanning" : "done",
          total: p.total,
          scanned: p.scanned,
          current: p.current || undefined,
        });
      }
    });
    return unsub;
  },
};
