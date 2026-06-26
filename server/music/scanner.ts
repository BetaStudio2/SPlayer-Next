import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseFile } from "music-metadata";
import type { IAudioMetadata } from "music-metadata";
import { upsertTracks, getFileRecords, deleteTracksByPaths, type UpsertTrack } from "@main/database";
import type { Artist, Album } from "@shared/types/player";
import { getCoverCacheDir } from "@main/utils/config";
import { libraryLog } from "@main/utils/logger";
import { musicDir } from "@main/utils/paths";
import { emit } from "@main/utils/events";

/** 支持扫描的音频扩展名 */
const AUDIO_EXT = new Set([
  "mp3", "flac", "ogg", "opus", "oga", "m4a", "aac", "wav",
  "ape", "wv", "dsf", "dsd", "dff", "mp4", "aiff", "aif",
]);

/** 扫描进度 */
export interface ScanProgress {
  scanning: boolean;
  scanned: number;
  total: number;
  current: string;
  startedAt: number;
}

let progress: ScanProgress = { scanning: false, scanned: 0, total: 0, current: "", startedAt: 0 };
let cancelRequested = false;

/** 当前扫描进度（只读快照） */
export const getScanProgress = (): ScanProgress => ({ ...progress });

/** 是否正在扫描 */
export const isScanning = (): boolean => progress.scanning;

/** 取消正在进行的扫描 */
export const cancelScan = (): void => {
  if (progress.scanning) cancelRequested = true;
};

/** 由路径生成稳定 id（md5(path)） */
const idOf = (filePath: string): string =>
  createHash("md5").update(filePath).digest("hex");

/** 递归收集目录下全部音频文件 */
const collectFiles = async (dirs: string[]): Promise<string[]> => {
  const result: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      libraryLog.warn(`[scanner] 无法读取目录 ${dir}:`, err);
      return;
    }
    for (const name of entries) {
      if (cancelRequested) return;
      const full = path.join(dir, name);
      try {
        const s = await stat(full);
        if (s.isDirectory()) {
          await walk(full);
        } else if (s.isFile() && AUDIO_EXT.has(path.extname(name).slice(1).toLowerCase())) {
          result.push(full);
        }
      } catch {
        /* 软链接/权限等问题跳过 */
      }
    }
  };
  for (const d of dirs) await walk(d);
  return result;
};

/** 把单个文件解析成 UpsertTrack（失败返回 null） */
export const parseToUpsert = async (filePath: string): Promise<UpsertTrack | null> => {
  let s: Awaited<ReturnType<typeof stat>>;
  try {
    s = await stat(filePath);
  } catch {
    return null;
  }
  let meta: IAudioMetadata;
  try {
    meta = await parseFile(filePath, { duration: true });
  } catch (err) {
    libraryLog.warn(`[scanner] 解析失败 ${filePath}:`, err);
    return null;
  }
  const common = meta.common;
  const format = meta.format;

  const id = idOf(filePath);
  const title = common.title || path.basename(filePath, path.extname(filePath));
  const trackNo = common.track?.no ?? undefined;
  const artists: Artist[] =
    common.artists && common.artists.length > 0
      ? common.artists.map((name) => ({ name }))
      : [{ name: "未知歌手" }];
  const album: Album | undefined = common.album
    ? {
        name: common.album,
        year: common.year,
        artist: common.artists?.[0],
      }
    : undefined;
  const duration = Math.round((format.duration ?? 0) * 1000);

  // 嵌入封面：写入缓存目录，cover 字段记录 HTTP 路由 URL
  let cover: string | undefined;
  if (common.picture && common.picture.length > 0) {
    try {
      const coverDir = getCoverCacheDir();
      if (!existsSync(coverDir)) mkdirSync(coverDir, { recursive: true });
      const coverPath = path.join(coverDir, `${id}.img`);
      writeFileSync(coverPath, common.picture[0].data);
      cover = `/api/music/cover/${id}`;
    } catch (err) {
      libraryLog.warn(`[scanner] 封面写入失败 ${filePath}:`, err);
    }
  }

  // 嵌入歌词：music-metadata 把 USLT/SYLT/LYRICS 等标签合并到 common.lyrics（string[]）
  let lyrics: string | undefined;
  if (Array.isArray(common.lyrics) && common.lyrics.length > 0) {
    const joined = common.lyrics
      .map((l) => (typeof l === "string" ? l : l?.text ?? ""))
      .filter((t) => t && t.trim().length > 0)
      .join("\n")
      .trim();
    if (joined) lyrics = joined;
  }

  return {
    id,
    path: filePath,
    title,
    track: trackNo,
    artists,
    album,
    duration,
    cover,
    codec: format.codec,
    sampleRate: format.sampleRate,
    bitRate: format.bitrate,
    channels: format.numberOfChannels,
    bitsPerSample: format.bitsPerSample,
    fileSize: s.size,
    mtime: s.mtimeMs,
    ctime: s.ctimeMs,
    lyrics,
  };
};

/**
 * 启动扫描
 * @param dirs 扫描目录列表（为空时回退到 musicDir）
 * @param incremental 是否增量（按 mtime+size 跳过未变文件）
 */
export const startScan = async (dirs: string[], incremental = true): Promise<void> => {
  if (progress.scanning) {
    libraryLog.warn("[scanner] 已有扫描在进行中，忽略本次请求");
    return;
  }
  const targets = dirs.length > 0 ? dirs : [musicDir];
  cancelRequested = false;
  progress = { scanning: true, scanned: 0, total: 0, current: "", startedAt: Date.now() };
  emit({ type: "scan:progress", data: getScanProgress() });
  let lastEmit = Date.now();
  // 节流推送：每 500ms 最多一次，避免 WS 洪泛
  const maybeEmit = (): void => {
    if (Date.now() - lastEmit > 500) {
      lastEmit = Date.now();
      emit({ type: "scan:progress", data: getScanProgress() });
    }
  };
  libraryLog.info(`[scanner] 开始扫描 (incremental=${incremental}): ${targets.join(", ")}`);

  // 收集文件
  const files = await collectFiles(targets);
  progress.total = files.length;
  emit({ type: "scan:progress", data: getScanProgress() });
  libraryLog.info(`[scanner] 发现 ${files.length} 个音频文件`);

  // 增量比对：未变更的跳过
  const records = incremental ? new Map(getFileRecords().map((r) => [r.path, r])) : new Map();
  // 收集已不存在文件，扫描结束后清理
  const seen = new Set<string>();

  // 批量 upsert（每 50 条提交一次）
  const BATCH = 50;
  let batch: UpsertTrack[] = [];

  const flush = (): void => {
    if (batch.length > 0) {
      upsertTracks(batch);
      batch = [];
    }
  };

  for (const file of files) {
    if (cancelRequested) break;
    progress.current = file;
    seen.add(file);
    const rec = records.get(file);
    if (rec) {
      try {
        const s = await stat(file);
        // mtime + size 一致则跳过解析
        if (s.mtimeMs === rec.mtime && s.size === rec.size) {
          progress.scanned++;
          maybeEmit();
          continue;
        }
      } catch {
        /* 文件可能在扫描中消失，交给下面 parse 返回 null */
      }
    }
    const upsert = await parseToUpsert(file);
    if (upsert) {
      batch.push(upsert);
      if (batch.length >= BATCH) flush();
    }
    progress.scanned++;
    maybeEmit();
  }
  flush();

  // 增量扫描时清理已删除的文件记录
  if (incremental) {
    const stale: string[] = [];
    for (const [p] of records) {
      if (!seen.has(p)) stale.push(p);
    }
    if (stale.length > 0) {
      deleteTracksByPaths(stale);
      libraryLog.info(`[scanner] 清理 ${stale.length} 条失效记录`);
    }
  }

  progress.scanning = false;
  progress.current = "";
  emit({
    type: "scan:done",
    data: {
      total: progress.total,
      scanned: progress.scanned,
      canceled: cancelRequested,
    },
  });
  emit({ type: "scan:progress", data: getScanProgress() });
  libraryLog.info(
    `[scanner] 扫描完成: ${progress.scanned}/${progress.total}（${cancelRequested ? "已取消" : "完成"}）`,
  );
};
