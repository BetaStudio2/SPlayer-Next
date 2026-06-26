/**
 * 下载任务持久化
 *
 * 表：download_tasks（在 database/index.ts 建表）
 * - 内存 Map 作为运行态权威源，SQLite 仅做重启恢复
 * - 进度更新只改内存 + WS 推送，不落盘（避免高频 IO）
 * - 状态变更（downloading/done/failed/canceled）才落盘
 */
import { getDb } from "./index";
import type { DownloadTask, DownloadStatus } from "@shared/types/download";
import type { Track } from "@shared/types/player";
import type { PluginQuality } from "@shared/types/plugin";

interface DownloadTaskRow {
  task_id: string;
  track_json: string;
  quality_level: string;
  status: string;
  received: number;
  total: number;
  file_path: string | null;
  error_code: string | null;
  tag_warning: number;
  created_at: number;
  finished_at: number | null;
}

const rowToTask = (row: DownloadTaskRow): DownloadTask => ({
  taskId: row.task_id,
  track: JSON.parse(row.track_json) as Track,
  qualityLevel: row.quality_level as PluginQuality,
  status: row.status as DownloadStatus,
  received: row.received,
  total: row.total,
  filePath: row.file_path ?? undefined,
  errorCode: row.error_code ?? undefined,
  tagWarning: row.tag_warning === 1,
  createdAt: row.created_at,
  finishedAt: row.finished_at ?? undefined,
});

/** 启动时从 SQLite 恢复任务列表（interrupted 状态重置为 failed） */
export const loadAllTasks = (): DownloadTask[] => {
  const rows = getDb()
    .prepare("SELECT * FROM download_tasks ORDER BY created_at DESC")
    .all() as DownloadTaskRow[];
  return rows.map((row) => {
    // 重启后进行中的任务标记为 interrupted
    if (row.status === "downloading" || row.status === "queued") {
      return rowToTask({ ...row, status: "interrupted", finished_at: Date.now() });
    }
    return rowToTask(row);
  });
};

/** 插入或全量替换一条任务（状态变更时调用） */
export const upsertTask = (task: DownloadTask): void => {
  getDb()
    .prepare(
      `INSERT INTO download_tasks
        (task_id, track_json, quality_level, status, received, total, file_path, error_code, tag_warning, created_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         status = excluded.status,
         received = excluded.received,
         total = excluded.total,
         file_path = excluded.file_path,
         error_code = excluded.error_code,
         tag_warning = excluded.tag_warning,
         finished_at = excluded.finished_at`,
    )
    .run(
      task.taskId,
      JSON.stringify(task.track),
      task.qualityLevel,
      task.status,
      task.received,
      task.total,
      task.filePath ?? null,
      task.errorCode ?? null,
      task.tagWarning ? 1 : 0,
      task.createdAt,
      task.finishedAt ?? null,
    );
};

/** 删除一条任务记录（remove 时调用） */
export const deleteTask = (taskId: string): void => {
  getDb().prepare("DELETE FROM download_tasks WHERE task_id = ?").run(taskId);
};

/** 清除所有已结束任务记录 */
export const clearFinishedTasks = (): void => {
  getDb()
    .prepare(
      "DELETE FROM download_tasks WHERE status IN ('done', 'failed', 'canceled', 'interrupted')",
    )
    .run();
};
