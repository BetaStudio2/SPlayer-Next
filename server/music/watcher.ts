import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { upsertTracks, deleteTracksByPaths } from "@main/database";
import { musicDir } from "@main/utils/paths";
import { libraryLog } from "@main/utils/logger";
import { parseToUpsert } from "./scanner";

/** 支持监听的音频扩展名（与 scanner 保持一致） */
const AUDIO_EXT = new Set([
  "mp3", "flac", "ogg", "opus", "oga", "m4a", "aac", "wav",
  "ape", "wv", "dsf", "dsd", "dff", "mp4", "aiff", "aif",
]);

const isAudio = (filePath: string): boolean =>
  AUDIO_EXT.has(path.extname(filePath).slice(1).toLowerCase());

let watcher: FSWatcher | null = null;
let debounceTimer: NodeJS.Timeout | null = null;
/** 待处理事件累积（add/change → 重新解析；unlink → 删除） */
const pendingUpsert = new Set<string>();
const pendingDelete = new Set<string>();

/** 触发一次批量处理（防抖） */
const scheduleFlush = (): void => {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void flush();
  }, 800);
};

const flush = async (): Promise<void> => {
  const toUpsert = [...pendingUpsert];
  const toDelete = [...pendingDelete];
  pendingUpsert.clear();
  pendingDelete.clear();
  if (toDelete.length > 0) {
    deleteTracksByPaths(toDelete);
    libraryLog.info(`[watcher] 删除 ${toDelete.length} 条记录`);
  }
  if (toUpsert.length > 0) {
    const results = await Promise.allSettled(toUpsert.map((p) => parseToUpsert(p)));
    const ok = results
      .map((r) => (r.status === "fulfilled" ? r.value : null))
      .filter((v): v is NonNullable<typeof v> => v !== null);
    if (ok.length > 0) upsertTracks(ok);
    libraryLog.info(`[watcher] 更新 ${ok.length}/${toUpsert.length} 条记录`);
  }
};

/**
 * 启动曲库目录监听，文件变更时增量更新数据库
 */
export const startWatcher = (): void => {
  if (watcher) return;
  watcher = watch(musicDir, {
    ignored: (p) => /(^|[/\\])\./.test(p), // 忽略隐藏文件/目录
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 600, pollInterval: 100 },
  });
  watcher
    .on("add", (p) => {
      if (isAudio(p)) {
        pendingUpsert.add(p);
        scheduleFlush();
      }
    })
    .on("change", (p) => {
      if (isAudio(p)) {
        pendingUpsert.add(p);
        scheduleFlush();
      }
    })
    .on("unlink", (p) => {
      if (isAudio(p)) {
        pendingDelete.add(p);
        scheduleFlush();
      }
    })
    .on("error", (err) => libraryLog.error("[watcher] 监听错误:", err));
  libraryLog.info(`[watcher] 已启动监听: ${musicDir}`);
};

/** 停止监听 */
export const stopWatcher = async (): Promise<void> => {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (watcher) {
    await watcher.close();
    watcher = null;
    libraryLog.info("[watcher] 已停止");
  }
};
