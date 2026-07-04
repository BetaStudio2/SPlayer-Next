/**
 * 音乐库扫描调度器（C# 调度器封装）
 *
 * 实际扫描由 C# 二进制 `splayer-scanner` 执行：
 * - TS 层 spawn 子进程，传递 scan 子命令与目录列表
 * - C# 端用 TagLibSharp 解析元数据，通过 SqliteDirectWriter 直写 SQLite
 * - 进度通过 stdout JSON lines 上报，TS 解析后经 WS 转发
 * - 取消通过 SIGTERM 终止子进程（C# 端捕获 Ctrl+C 后清理）
 *
 * TS 层职责：进度广播 / 取消 / 子进程生命周期管理
 *
 * 注意：`parseToUpsert` 仍保留 TS 实现，供 watcher.ts 实时单文件解析使用
 *      （避免每次文件变更都 spawn 进程，watcher 场景对延迟敏感）
 */
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { parseFile } from "music-metadata";
import type { IAudioMetadata } from "music-metadata";
import { type UpsertTrack, invalidateTracksCache } from "@main/database";
import type { Artist, Album } from "@shared/types/player";
import { getCoverCacheDir } from "@main/utils/config";
import { libraryLog } from "@main/utils/logger";
import { databaseDir, musicDir } from "@main/utils/paths";
import { emit } from "@main/utils/events";
import { store } from "@main/store";

/** C# 扫描引擎二进制路径（容器内默认 /app/bin/splayer-scanner） */
const SCANNER_BIN = process.env.SPLAYER_SCANNER_BIN ?? "/app/bin/splayer-scanner";

/** 扫描超时（默认 1 小时，防止异常卡死） */
const SCAN_TIMEOUT_MS = parseInt(process.env.SPLAYER_SCAN_TIMEOUT_MS ?? "3600000", 10);

/** 单文件最大大小（默认 500 MB，跳过异常巨大的"音频文件"） */
const MAX_FILE_SIZE_MB = parseInt(process.env.SPLAYER_SCAN_MAX_FILE_SIZE_MB ?? "500", 10);

/** 扫描进度 */
export interface ScanProgress {
  scanning: boolean;
  scanned: number;
  total: number;
  current: string;
  startedAt: number;
}

let progress: ScanProgress = { scanning: false, scanned: 0, total: 0, current: "", startedAt: 0 };
/** 进行中的 C# 子进程（cancel 用） */
let child: ChildProcess | null = null;

/** 当前扫描进度（只读快照） */
export const getScanProgress = (): ScanProgress => ({ ...progress });

/** 是否正在扫描 */
export const isScanning = (): boolean => progress.scanning;

/** 取消正在进行的扫描（SIGTERM 子进程） */
export const cancelScan = (): void => {
  if (!progress.scanning) return;
  if (child && !child.killed) {
    try {
      child.kill("SIGTERM");
      libraryLog.info("[scanner] 已发送 SIGTERM 取消扫描");
    } catch (err) {
      libraryLog.warn("[scanner] SIGTERM 失败:", err);
    }
  }
};

/** 由路径生成稳定 id（md5(path)） */
const idOf = (filePath: string): string =>
  createHash("md5").update(filePath).digest("hex");

/** C# stdout 单行 JSON 协议 */
interface ScannerEvent {
  type: "progress" | "done";
  scanning?: boolean;
  scanned?: number;
  total?: number;
  current?: string;
  upserted?: number;
  deleted?: number;
  canceled?: boolean;
  errors?: number;
  trained?: number;
}

/** 解析子进程 stdout 行 → 更新内部状态 + WS 广播 */
const handleLine = (line: string): void => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let evt: ScannerEvent;
  try {
    evt = JSON.parse(trimmed) as ScannerEvent;
  } catch {
    // 非 JSON 输出（如异常日志），原样记录
    libraryLog.debug(`[scanner] stdout: ${trimmed}`);
    return;
  }

  switch (evt.type) {
    case "progress": {
      progress.scanning = evt.scanning ?? progress.scanning;
      progress.scanned = evt.scanned ?? progress.scanned;
      progress.total = evt.total ?? progress.total;
      progress.current = evt.current ?? progress.current;
      emit({ type: "scan:progress", data: getScanProgress() });
      break;
    }
    case "done": {
      progress.scanned = evt.scanned ?? progress.scanned;
      progress.total = evt.total ?? progress.total;
      progress.scanning = false;
      progress.current = "";
      // C# scanner 直写 SQLite，绕过 Node.js，需手动失效缓存
      invalidateTracksCache();
      emit({
        type: "scan:done",
        data: {
          total: progress.total,
          scanned: progress.scanned,
          canceled: evt.canceled ?? false,
        },
      });
      emit({ type: "scan:progress", data: getScanProgress() });
      libraryLog.info(
        `[scanner] 扫描完成: ${progress.scanned}/${progress.total}` +
          `（upsert=${evt.upserted ?? 0}, delete=${evt.deleted ?? 0}, trained=${evt.trained ?? 0}, errors=${evt.errors ?? 0}）`,
      );
      break;
    }
  }
};

/** 将子进程 stdout 流按行拆分回调 */
const attachLineReader = (stream: NodeJS.ReadableStream | null): void => {
  if (!stream) return;
  let buf = "";
  stream.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      handleLine(line);
    }
  });
  stream.on("end", () => {
    if (buf.trim()) handleLine(buf);
  });
};

/**
 * 启动扫描 —— spawn C# splayer-scanner 执行
 * @param dirs 扫描目录列表（为空时回退到 musicDir）
 * @param incremental 是否增量（按 mtime+size 跳过未变文件）
 */
export const startScan = async (dirs: string[], incremental = true): Promise<void> => {
  if (progress.scanning) {
    libraryLog.warn("[scanner] 已有扫描在进行中，忽略本次请求");
    return;
  }
  const targets = dirs.length > 0 ? dirs : [musicDir];

  progress = { scanning: true, scanned: 0, total: 0, current: "正在统计文件...", startedAt: Date.now() };
  // 立即广播初始状态，让前端显示“正在统计文件...”而不是 0/0
  emit({ type: "scan:progress", data: getScanProgress() });
  libraryLog.info(`[scanner] 启动 C# 扫描 (incremental=${incremental}): ${targets.join(", ")}`);

  const args = [
    "scan",
    "--dirs",
    targets.join(","),
    "--batch",
    "50",
    ...(incremental ? [] : ["--full"]),
  ];

  // 扫描超时定时器（exit 回调中清理）
  let scanTimeout: NodeJS.Timeout | null = null;

  try {
    const scannerMaxParallelism = store.store.library.scannerMaxParallelism;
    child = spawn(SCANNER_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        // 直写模式：扫描器直接操作 SQLite，数据不经过 V8 堆
        SPLAYER_DB_PATH: process.env.SPLAYER_DB_PATH ?? path.join(databaseDir, "library.db"),
        // 传递给 C++ 刮削器的安全限制
          SCRAPER_MAX_SCAN_FILES: process.env.SCRAPER_MAX_SCAN_FILES ?? "50000",
        SCRAPER_MAX_FILE_SIZE_MB: process.env.SCRAPER_MAX_FILE_SIZE_MB ?? "500",
        SCRAPER_MAX_SCAN_ERRORS: process.env.SCRAPER_MAX_SCAN_ERRORS ?? "50",
        // 传递给 C# 扫描器的安全限制
        SCANNER_MAX_SCAN_FILES: process.env.SCANNER_MAX_SCAN_FILES ?? process.env.SCRAPER_MAX_SCAN_FILES ?? "50000",
        SCANNER_MAX_FILE_SIZE_MB: process.env.SCANNER_MAX_FILE_SIZE_MB ?? process.env.SCRAPER_MAX_FILE_SIZE_MB ?? "500",
        SCANNER_MAX_SCAN_ERRORS: process.env.SCANNER_MAX_SCAN_ERRORS ?? process.env.SCRAPER_MAX_SCAN_ERRORS ?? "50",
        // C# 端单次 DB 请求超时（毫秒）：0=禁用（默认），-1=自动（>=30s），>0=指定值
        SCANNER_DB_REQUEST_TIMEOUT_MS: process.env.SCANNER_DB_REQUEST_TIMEOUT_MS ?? "0",
        ...(scannerMaxParallelism > 0
          ? { SCANNER_MAX_PARALLELISM: scannerMaxParallelism.toString() }
          : {}),
      },
    });

    // 超时保护：超过 SCAN_TIMEOUT_MS 未完成则终止
    scanTimeout = setTimeout(() => {
      if (child && !child.killed) {
        libraryLog.warn(`[scanner] 扫描超时（${SCAN_TIMEOUT_MS}ms），强制终止`);
        child.kill("SIGTERM");
      }
    }, SCAN_TIMEOUT_MS);
  } catch (err) {
    progress.scanning = false;
    libraryLog.error(`[scanner] spawn 失败:`, err);
    emit({
      type: "scan:done",
      data: { total: 0, scanned: 0, canceled: false },
    });
    return;
  }

  attachLineReader(child.stdout);
  // C# 端 stderr 输出人类可读日志，转发到 libraryLog
  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) libraryLog.info(`[scanner] ${text}`);
    });
  }

  child.on("exit", (code, signal) => {
    // 清理超时定时器
    if (scanTimeout) {
      clearTimeout(scanTimeout);
      scanTimeout = null;
    }
    child = null;
    if (progress.scanning) {
      // 子进程退出但未收到 done 事件 —— 兜底收尾
      progress.scanning = false;
      progress.current = "";
      const canceled = signal === "SIGTERM" || signal === "SIGKILL";
      emit({
        type: "scan:done",
        data: {
          total: progress.total,
          scanned: progress.scanned,
          canceled,
        },
      });
      emit({ type: "scan:progress", data: getScanProgress() });
      if (canceled) {
        libraryLog.info(`[scanner] 已取消`);
      } else if (code !== 0) {
        libraryLog.warn(`[scanner] 异常退出: code=${code} signal=${signal}`);
      }
    }
  });

  child.on("error", (err) => {
    child = null;
    progress.scanning = false;
    progress.current = "";
    libraryLog.error(`[scanner] 子进程错误:`, err);
    emit({
      type: "scan:done",
      data: { total: progress.total, scanned: progress.scanned, canceled: false },
    });
    emit({ type: "scan:progress", data: getScanProgress() });
  });
};

/* ================================================================== */
/* 以下为 watcher.ts 专用的单文件解析逻辑（TS 实现，保留）              */
/* 原因：watcher 监听文件变更时需实时响应，每次都 spawn C# 进程开销过大 */
/* ================================================================== */

/** 支持扫描的音频扩展名 */
const AUDIO_EXT = new Set([
  "mp3", "flac", "ogg", "opus", "oga", "m4a", "aac", "wav",
  "ape", "wv", "dsf", "dsd", "dff", "mp4", "aiff", "aif",
]);

/** 把单个文件解析成 UpsertTrack（失败返回 null）—— watcher 专用 */
export const parseToUpsert = async (filePath: string): Promise<UpsertTrack | null> => {
  let s: Awaited<ReturnType<typeof stat>>;
  try {
    s = await stat(filePath);
  } catch {
    return null;
  }

  // 文件大小预检（跳过过大/异常文件）
  const maxBytes = MAX_FILE_SIZE_MB * 1024 * 1024;
  if (s.size === 0 || s.size > maxBytes) {
    libraryLog.warn(`[scanner] 跳过异常文件 ${filePath}: size=${s.size} bytes`);
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
    mtime: Math.round(s.mtimeMs),
    ctime: Math.round(s.ctimeMs),
    lyrics,
  };
};

// AUDIO_EXT 保留导出（watcher.ts 自行维护副本，此处仅为本模块 parseToUpsert 使用）
export { AUDIO_EXT };
