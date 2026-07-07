import path from "node:path";
import type { Track, Artist, Album, AudioQuality } from "@shared/types/player";
import type { AlbumSummary, ArtistSummary, FormatStat } from "@shared/types/library";
import { getDb } from "./index";
import { getScraperDb } from "./scraper-db";

/** 数据库行类型 */
interface TrackRow {
  id: string;
  path: string;
  title: string;
  track?: number;
  artists: string;
  album: string | null;
  duration: number;
  cover: string | null;
  codec: string | null;
  sample_rate: number | null;
  bit_rate: number | null;
  channels: number | null;
  bits_per_sample: number | null;
  file_size: number;
  file_mtime: number | null;
  file_ctime: number | null;
  scanned_at: number;
}

/** 将数据库行解析为 Track */
const rowToTrack = (row: TrackRow): Track => {
  const quality: AudioQuality | undefined =
    row.codec != null
      ? {
          codec: row.codec,
          sampleRate: row.sample_rate ?? 0,
          bitRate: row.bit_rate ?? 0,
          channels: row.channels ?? 0,
          bitsPerSample: row.bits_per_sample ?? 0,
        }
      : undefined;

  return {
    id: row.id,
    source: "local",
    path: row.path,
    title: row.title,
    track: row.track ?? undefined,
    artists: JSON.parse(row.artists) as Artist[],
    album: row.album ? (JSON.parse(row.album) as Album) : undefined,
    duration: row.duration,
    cover: row.cover ?? undefined,
    fileSize: row.file_size ?? undefined,
    mtime: row.file_mtime ?? undefined,
    ctime: row.file_ctime ?? undefined,
    quality,
  };
};

// ---------------------------------------------------------------------------
// Track 全量缓存：避免每次请求都全表扫描 + JSON.parse 所有行
// 全表结果被前端 /tracks、Subsonic search3 等频繁调用，
// 反复分配数千个对象导致 V8 堆碎片化、RSS 持续膨胀不回落。
// 缓存持续有效直到任何写入操作（upsert / delete）发生后自动失效。
// ---------------------------------------------------------------------------
let tracksCache: Track[] | null = null;
let albumCache: AlbumSummary[] | null = null;
let artistCache: ArtistSummary[] | null = null;

/** 清除全量 track/album/artist 缓存（有写入时调用） */
export const invalidateTracksCache = (): void => {
  tracksCache = null;
  albumCache = null;
  artistCache = null;
};

/** 查询全部曲目（缓存优先） */
export const getAllTracks = (): Track[] => {
  if (tracksCache) return tracksCache;
  const rows = getDb().prepare("SELECT * FROM tracks").all() as TrackRow[];
  tracksCache = rows.map(rowToTrack);
  return tracksCache;
};

/** 获取曲目总数（从缓存派生） */
export const getTrackCount = (): number => {
  if (tracksCache) return tracksCache.length;
  return getAllTracks().length;
};

/** 随机取一首曲目，库为空时返回 null（从缓存派生） */
export const getRandomTrack = (): Track | null => {
  const all = getAllTracks();
  if (!all.length) return null;
  return all[Math.floor(Math.random() * all.length)];
};

/** 随机取多首曲目（从缓存派生，Fisher-Yates 部分洗牌） */
export const getRandomTracks = (limit: number): Track[] => {
  const all = getAllTracks();
  const result = all.slice();
  const n = Math.min(limit | 0, result.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (result.length - i));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result.slice(0, n);
};

/** 用于增量扫描比对的文件记录 */
export interface FileRecord {
  path: string;
  mtime: number;
  size: number;
}

/** 获取所有文件记录（path + mtime + size），用于增量扫描比对 */
export const getFileRecords = (): FileRecord[] => {
  return getDb()
    .prepare("SELECT path, COALESCE(file_mtime, 0) as mtime, file_size as size FROM tracks")
    .all() as FileRecord[];
};

/** 批量插入/更新的扫描结果 */
export interface UpsertTrack {
  id: string;
  path: string;
  title: string;
  track?: number;
  artists: Artist[];
  album?: Album;
  duration: number;
  cover?: string;
  codec?: string;
  sampleRate?: number;
  bitRate?: number;
  channels?: number;
  bitsPerSample?: number;
  fileSize: number;
  mtime: number;
  ctime: number;
}

/**
 * 批量插入/更新曲目（使用事务）
 *
 * 使用 INSERT ... ON CONFLICT(id) DO UPDATE 而非 INSERT OR REPLACE：
 * REPLACE 会先 DELETE 再 INSERT，导致刮削字段（mbid / isrc / lyrics /
 * cover_data / genre / composer / scraped_at 等）被清空，造成数据丢失。
 * UPDATE 子句只刷新扫描器负责的字段，刮削字段由刮削器独立维护。
 */
export const upsertTracks = (tracks: UpsertTrack[]): void => {
  if (tracks.length === 0) return;
  const d = getDb();
  const stmt = d.prepare(`
    INSERT INTO tracks
      (id, path, title, track, artists, album, duration, cover, codec, sample_rate, bit_rate, channels, bits_per_sample, file_size, file_mtime, file_ctime, scanned_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      path = excluded.path,
      title = excluded.title,
      track = excluded.track,
      artists = excluded.artists,
      album = excluded.album,
      duration = excluded.duration,
      cover = excluded.cover,
      codec = excluded.codec,
      sample_rate = excluded.sample_rate,
      bit_rate = excluded.bit_rate,
      channels = excluded.channels,
      bits_per_sample = excluded.bits_per_sample,
      file_size = excluded.file_size,
      file_mtime = excluded.file_mtime,
      file_ctime = excluded.file_ctime,
      scanned_at = excluded.scanned_at
  `);
  const now = Date.now();
  const tx = d.transaction(() => {
    for (const t of tracks) {
      stmt.run(
        t.id,
        t.path,
        t.title,
        t.track ?? null,
        JSON.stringify(t.artists),
        t.album ? JSON.stringify(t.album) : null,
        t.duration,
        t.cover ?? null,
        t.codec ?? null,
        t.sampleRate ?? null,
        t.bitRate ?? null,
        t.channels ?? null,
        t.bitsPerSample ?? null,
        t.fileSize,
        Math.round(t.mtime),
        Math.round(t.ctime),
        now,
      );
    }
  });
  tx();
  invalidateTracksCache();
};

/** 批量删除曲目（按路径），同时清理关联的 scrape_queue 孤儿项 */
export const deleteTracksByPaths = (paths: string[]): void => {
  if (paths.length === 0) return;
  const d = getDb();
  const getId = d.prepare("SELECT id FROM tracks WHERE path = ?");
  const delTrack = d.prepare("DELETE FROM tracks WHERE path = ?");
  const sdb = getScraperDb();
  const delQueue = sdb.prepare("DELETE FROM scrape_queue WHERE track_id = ?");
  const tx = d.transaction(() => {
    for (const p of paths) {
      const row = getId.get(p) as { id: string } | undefined;
      if (row) delQueue.run(row.id);
      delTrack.run(p);
    }
  });
  tx();
  invalidateTracksCache();
};

/** 按关键词模糊搜索曲目（从缓存派生，避免重复 DB + rowToTrack） */
export const searchTracks = (query: string): Track[] => {
  if (!query) return getAllTracks();
  const q = query.toLowerCase();
  return getAllTracks().filter(
    (t) =>
      t.title.toLowerCase().includes(q) ||
      t.artists.some((a) => a.name.toLowerCase().includes(q)) ||
      (t.album?.name ?? "").toLowerCase().includes(q),
  );
};

/** 删除指定目录下的所有曲目（同时清理 scrape_queue 孤儿） */
export const deleteTracksByDir = (dir: string): void => {
  const prefix = dir.endsWith("/") || dir.endsWith("\\") ? dir : dir + path.sep;
  const d = getDb();
  const ids = d
    .prepare("SELECT id FROM tracks WHERE path LIKE ?")
    .all(prefix + "%") as { id: string }[];
  const sdb = getScraperDb();
  const delQueue = sdb.prepare("DELETE FROM scrape_queue WHERE track_id = ?");
  const delTrack = d.prepare("DELETE FROM tracks WHERE path LIKE ?");
  const tx = d.transaction(() => {
    for (const row of ids) delQueue.run(row.id);
    delTrack.run(prefix + "%");
  });
  tx();
  invalidateTracksCache();
};

/** 媒体格式统计：按 codec 分组，返回各格式的曲目数和总大小 */
export const getFormatStatistics = (): FormatStat[] => {
  return getDb()
    .prepare(
      `SELECT
         COALESCE(NULLIF(codec, ''), 'Unknown') AS format,
         COUNT(*) AS count,
         COALESCE(SUM(file_size), 0) AS totalSize
       FROM tracks
       GROUP BY format
       ORDER BY count DESC`,
    )
    .all() as FormatStat[];
};

/** 专辑列表 */
export const getAlbumList = (): AlbumSummary[] => {
  if (albumCache) return albumCache;
  const rows = getDb()
    .prepare(
      `SELECT
         json_extract(album, '$.name') AS name,
         MAX(CASE WHEN cover IS NOT NULL THEN cover END) AS cover,
         MAX(artists) AS artists,
         COUNT(*) AS trackCount
       FROM tracks
       WHERE album IS NOT NULL AND json_extract(album, '$.name') IS NOT NULL
       GROUP BY name`,
    )
    .all() as { name: string; cover: string | null; artists: string; trackCount: number }[];
  // 缓存无效时重建：album/artist 聚合查询依赖 tracks 表，共用同一失效逻辑
  albumCache = rows.map((row) => ({
    name: row.name,
    cover: row.cover ?? undefined,
    artist: (JSON.parse(row.artists) as Artist[]).map((a) => a.name).join(" / "),
    trackCount: row.trackCount,
  }));
  return albumCache;
};

/** 歌手列表 */
export const getArtistList = (): ArtistSummary[] => {
  if (artistCache) return artistCache;
  const rows = getDb()
    .prepare(
      `SELECT
         json_extract(a.value, '$.name') AS name,
         COUNT(DISTINCT t.id) AS trackCount,
         MAX(CASE WHEN t.cover IS NOT NULL THEN t.cover END) AS cover
       FROM tracks t, json_each(t.artists) a
       WHERE json_extract(a.value, '$.name') IS NOT NULL
         AND TRIM(json_extract(a.value, '$.name')) != ''
       GROUP BY name`,
    )
    .all() as { name: string; trackCount: number; cover: string | null }[];
  artistCache = rows.map((row) => ({
    name: row.name,
    trackCount: row.trackCount,
    cover: row.cover ?? undefined,
  }));
  return artistCache;
};

/** 按专辑名获取全部曲目（从缓存派生，避免重复 DB 查询 + rowToTrack 创建临时对象） */
export const getAlbumTracks = (albumName: string): Track[] => {
  return getAllTracks().filter((t) => t.album?.name === albumName);
};

/** 按歌手名获取全部曲目（从缓存派生，避免重复 DB 查询 + rowToTrack 创建临时对象） */
export const getArtistTracks = (artistName: string): Track[] => {
  const lowerName = artistName.toLowerCase();
  return getAllTracks().filter((t) =>
    t.artists.some((a) => a.name.toLowerCase() === lowerName),
  );
};

/** 按 ID 批量获取曲目（从缓存派生，避免重复 DB + rowToTrack） */
export const getTracksByIds = (ids: string[]): Track[] => {
  if (ids.length === 0) return [];
  const idSet = new Set(ids);
  return getAllTracks().filter((t) => idSet.has(t.id));
};
