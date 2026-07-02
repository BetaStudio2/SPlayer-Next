/**
 * Subsonic 工具函数
 *
 * 响应封装、数据映射、封面/流媒体服务。
 */
import { createReadStream, existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import type { Context } from "hono";
import { albumIdOf, artistIdOf, isStarred, findAlbumNameById, findArtistNameById } from "@main/database/subsonic";
import { getAlbumTracks, getArtistTracks } from "@main/database";
import { getCoverCacheDir } from "@main/utils/config";
import { serveAudioStream } from "@main/utils/stream";
import { toXml } from "./xml";
import type { Track, Artist } from "@shared/types/player";
import type { AlbumSummary, ArtistSummary } from "@shared/types/library";

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

export const SUBSONIC_VERSION = "1.16.1";
export const SERVER_NAME = "splayer";
export const SERVER_VERSION = "1.0.0";

export const OPEN_SUBSONIC_EXTENSIONS = [
  { name: "formPost", versions: [1] },
  { name: "songLyrics", versions: [1, 2] },
] as const;

export interface SubError {
  code: number;
  message: string;
}

const audioMime: Record<string, string> = {
  mp3: "audio/mpeg", flac: "audio/flac", ogg: "audio/ogg", opus: "audio/ogg",
  oga: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav",
  ape: "audio/x-ape", wv: "audio/x-wavpack", dsf: "audio/x-dsf", mp4: "audio/mp4",
  aiff: "audio/aiff", aif: "audio/aiff",
};

/* ------------------------------------------------------------------ */
/* 响应封装                                                            */
/* ------------------------------------------------------------------ */

/** 构造 subsonic-response 主体 */
export const buildBody = (status: "ok" | "failed", payload: Record<string, unknown> = {}, error?: SubError) => {
  const body: Record<string, unknown> = {
    status,
    version: SUBSONIC_VERSION,
    type: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    openSubsonic: true,
    ...payload,
  };
  if (error) body.error = error;
  return { "subsonic-response": body };
};

/** 发送响应（按 f 参数选 JSON/XML） */
export const send = (c: Context, payload: Record<string, unknown>, error?: SubError) => {
  const format = c.req.query("f") ?? "xml";
  const body = buildBody(error ? "failed" : "ok", payload, error);
  if (format === "json") return c.json(body);
  return c.body(toXml(body), 200, { "Content-Type": "text/xml; charset=utf-8" });
};

/* ------------------------------------------------------------------ */
/* 数据映射                                                            */
/* ------------------------------------------------------------------ */

const suffixOf = (filePath: string): string => path.extname(filePath).slice(1).toLowerCase();
const mimeOf = (filePath: string): string => audioMime[suffixOf(filePath)] ?? "application/octet-stream";

export const parseIntOr = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const firstArtist = (artists: Artist[]): string => artists.map((a) => a.name).join(" / ");
const firstArtistId = (artists: Artist[]): string | undefined =>
  artists[0] ? artistIdOf(artists[0].name) : undefined;

export const trackToChild = (t: Track, userId: string, includeStarred = true) => {
  const albumName = t.album?.name ?? "";
  const filePath = t.path ?? "";
  const child: Record<string, unknown> = {
    id: t.id,
    parent: albumName ? albumIdOf(albumName) : undefined,
    isDir: false,
    title: t.title,
    album: albumName || undefined,
    artist: firstArtist(t.artists),
    track: t.track ?? undefined,
    coverArt: t.id,
    size: t.fileSize ?? 0,
    contentType: mimeOf(filePath),
    suffix: suffixOf(filePath),
    duration: Math.round(t.duration),
    bitRate: t.quality?.bitRate ?? 0,
    path: filePath ? path.basename(filePath) : t.id,
    discNumber: 1,
    type: "music",
    created: new Date(t.ctime ?? t.mtime ?? Date.now()).toISOString(),
    artistId: firstArtistId(t.artists),
    albumId: albumName ? albumIdOf(albumName) : undefined,
  };
  if (includeStarred && isStarred(userId, t.id, "track")) {
    child.starred = new Date().toISOString();
  }
  return child;
};

export const trackToSong = (t: Track, userId: string) => trackToChild(t, userId);

export const albumListRowToAlbum = (row: AlbumSummary) => {
  const tracks = getAlbumTracks(row.name);
  const duration = tracks.reduce((sum, t) => sum + Math.round(t.duration), 0);
  return {
    id: albumIdOf(row.name),
    name: row.name,
    artist: row.artist,
    artistId: row.artist ? artistIdOf(row.artist) : undefined,
    coverArt: tracks.find((t) => t.cover)?.id ?? albumIdOf(row.name),
    songCount: row.trackCount,
    duration,
    created: new Date(tracks[0]?.ctime ?? Date.now()).toISOString(),
  };
};

export const artistListRowToArtist = (row: ArtistSummary) => {
  const albums = new Set(
    getArtistTracks(row.name)
      .map((t) => t.album?.name)
      .filter(Boolean) as string[],
  );
  return {
    id: artistIdOf(row.name),
    name: row.name,
    coverArt: row.cover ? artistIdOf(row.name) : undefined,
    albumCount: albums.size,
  };
};

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

/** 收集可能多值的 query 参数 */
export const collectIds = (q: Record<string, string>, key: string): string[] => {
  const ids = q[key];
  if (!ids) return [];
  return ids.split(",").map((s) => s.trim()).filter(Boolean);
};

/* ------------------------------------------------------------------ */
/* 封面服务                                                            */
/* ------------------------------------------------------------------ */

export const serveCover = async (c: Context, id: string, _size: number): Promise<Response> => {
  let coverPath = path.join(getCoverCacheDir(), `${id}.img`);
  if (!existsSync(coverPath)) {
    let track: Track | undefined;
    const albumName = findAlbumNameById(id);
    if (albumName) {
      track = getAlbumTracks(albumName).find((t) => t.cover);
    } else {
      const artistName = findArtistNameById(id);
      if (artistName) track = getArtistTracks(artistName).find((t) => t.cover);
    }
    if (track) coverPath = path.join(getCoverCacheDir(), `${track.id}.img`);
  }
  if (!existsSync(coverPath)) {
    return c.body("cover not found", 404);
  }
  // 流式直出，无 sharp 重编码，零内存膨胀
  let fd: Awaited<ReturnType<typeof open>> | undefined;
  let mime = "image/jpeg";
  try {
    fd = await open(coverPath, "r");
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fd.read(buf, 0, 4, 0);
    if (bytesRead >= 4) {
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) mime = "image/png";
    }
  } catch { /* fallback to jpeg */ }
  finally { await fd?.close(); }
  const stream = Readable.toWeb(createReadStream(coverPath)) as ReadableStream;
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": mime, "Cache-Control": "public, max-age=86400" },
  });
};

/* ------------------------------------------------------------------ */
/* 音频流服务                                                          */
/* ------------------------------------------------------------------ */

export const serveStream = (c: Context, filePath: string, asDownload: boolean): Response => {
  return serveAudioStream(c, filePath, asDownload);
};
