/**
 * SQLite 写入代理
 *
 * 多语言架构中，C# 扫描器 / C++ 刮削器 / C# 下载引擎等子进程
 * 不直接写 SQLite（避免 SQLITE_BUSY 多进程冲突），统一通过此 HTTP 接口代理。
 * better-sqlite3 同步 API 天然串行化写入，无需额外锁。
 *
 * 内部鉴权：通过 x-proxy-key header 校验（环境变量 PROXY_KEY），
 * 默认值仅用于开发，生产环境必须设置。
 */
import { existsSync } from "node:fs";
import { Hono } from "hono";
import { upsertTracks, deleteTracksByPaths, type UpsertTrack } from "@main/database";
import { getDb, getScraperDb } from "@main/database";
import { libraryLog } from "@main/utils/logger";
import type { DownloadTask } from "@shared/types/download";

const app = new Hono();

const PROXY_KEY = process.env.PROXY_KEY ?? "dev-proxy-key";

/** 校验代理密钥 */
app.use("/*", async (c, next) => {
  const key = c.req.header("x-proxy-key");
  if (key !== PROXY_KEY) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

/* ------------------------------------------------------------------ */
/* Scanner 写入                                                        */
/* ------------------------------------------------------------------ */

/** POST /upsert  body: UpsertTrack[] —— 批量插入/更新曲目 */
app.post("/upsert", async (c) => {
  try {
    const tracks = (await c.req.json()) as UpsertTrack[];
    if (!Array.isArray(tracks) || tracks.length === 0) {
      return c.json({ ok: true, affected: 0 });
    }
    // 单批上限 200：避免单次 JSON 解析分配大量内存推高 V8 高水位
    if (tracks.length > 200) {
      return c.json({ ok: false, error: `batch too large: ${tracks.length} > 200` }, 413);
    }
    upsertTracks(tracks);
    return c.json({ ok: true, affected: tracks.length });
  } catch (err) {
    libraryLog.error("[db-proxy] upsert 失败:", err);
    return c.json({ ok: false, error: err instanceof Error ? err.message : "unknown" }, 500);
  }
});

/** POST /delete  body: { paths: string[] } —— 按路径批量删除曲目 */
app.post("/delete", async (c) => {
  try {
    const { paths } = (await c.req.json()) as { paths: string[] };
    if (!Array.isArray(paths) || paths.length === 0) {
      return c.json({ ok: true, affected: 0 });
    }
    deleteTracksByPaths(paths);
    return c.json({ ok: true, affected: paths.length });
  } catch (err) {
    libraryLog.error("[db-proxy] delete 失败:", err);
    return c.json({ ok: false, error: err instanceof Error ? err.message : "unknown" }, 500);
  }
});

/* ------------------------------------------------------------------ */
/* Scraper 读取（getTrack 供队列模式使用）                               */
/* ------------------------------------------------------------------ */
/** GET /tracks/:id —— 获取曲目元数据（供 C++ scraper 调用） */
app.get("/tracks/:id", (c) => {
  const id = c.req.param("id");
  const row = getDb()
    .prepare(
      `SELECT id, title, path, artists, album, duration,
              COALESCE(file_mtime, 0) as mtime, file_size as size,
              COALESCE(composer, '') as composer,
              COALESCE(album_artist, '') as album_artist,
              COALESCE(track, 0) as track,
              COALESCE(disc_number, 0) as disc,
              COALESCE(mbid, '') as mbid,
              COALESCE(album_mbid, '') as album_mbid,
              COALESCE(artist_mbid, '') as artist_mbid,
              COALESCE(isrc, '') as isrc
       FROM tracks WHERE id = ?`,
    )
    .get(id) as {
    id: string;
    title: string;
    path: string;
    artists: string;
    album: string;
    duration: number;
    mtime: number;
    size: number;
    composer: string;
    album_artist: string;
    track: number;
    disc: number;
    mbid: string;
    album_mbid: string;
    artist_mbid: string;
    isrc: string;
  } | undefined;
  if (!row) return c.json({ ok: false, error: "not found" }, 404);
  // artists 存储为 JSON 数组字符串
  let artists: string[] = [];
  try {
    const parsed = JSON.parse(row.artists);
    if (Array.isArray(parsed)) artists = parsed.map((a) => a.name ?? a).filter(Boolean);
  } catch {
    artists = row.artists ? [row.artists] : [];
  }
  let album = "";
  try {
    const parsed = JSON.parse(row.album);
    album = parsed?.name ?? row.album ?? "";
  } catch {
    album = row.album ?? "";
  }
  return c.json({
    ok: true,
    id: row.id,
    title: row.title,
    artist: artists[0] ?? "",
    album,
    album_artist: row.album_artist,
    composer: row.composer,
    track: row.track,
    disc: row.disc,
    mbid: row.mbid,
    album_mbid: row.album_mbid,
    artist_mbid: row.artist_mbid,
    isrc: row.isrc,
    duration: row.duration,
    path: row.path,
  });
});

/**
 * GET /analyze —— 数据库完整性分析
 *
 * 返回 tracks 表的状态统计，用于诊断数据库共享导致的脏数据问题。
 * 无需代理密钥鉴权（只读操作）。
 */
app.get("/analyze", (c) => {
  const db = getDb();

  // 总行数
  const totalRow = db.prepare("SELECT COUNT(*) as count FROM tracks").get() as { count: number };

  // 唯一 path 数
  const uniquePathRow = db.prepare("SELECT COUNT(DISTINCT path) as count FROM tracks").get() as {
    count: number;
  };

  // path 重复统计
  const dupRows = db
    .prepare(
      `SELECT path, COUNT(*) as cnt, GROUP_CONCAT(id) as ids
       FROM tracks
       GROUP BY path
       HAVING cnt > 1
       LIMIT 20`,
    )
    .all() as { path: string; cnt: number; ids: string }[];

  // path 中文件还在磁盘上的比例（采样前 1000 条）
  const samplePaths = db
    .prepare("SELECT path FROM tracks LIMIT 1000")
    .all() as { path: string }[];
  let onDisk = 0;
  for (const row of samplePaths) {
    if (existsSync(row.path)) onDisk++;
  }

  return c.json({
    ok: true,
    totalRows: totalRow.count,
    uniquePaths: uniquePathRow.count,
    duplicatePaths: dupRows.length,
    duplicates: dupRows.map((r) => ({
      path: r.path,
      count: r.cnt,
      ids: r.ids.split(","),
    })),
    diskHealth: {
      sampled: samplePaths.length,
      onDisk,
      orphanEstimate: samplePaths.length - onDisk,
    },
  });
});

/* ------------------------------------------------------------------ */
/* Download 写入                                                       */
/* ------------------------------------------------------------------ */

/** POST /download/progress  body: { taskId, received, total } —— 更新下载进度 */
app.post("/download/progress", async (c) => {
  try {
    const { taskId, received, total } = (await c.req.json()) as {
      taskId: string;
      received: number;
      total: number;
    };
    getDb()
      .prepare(
        "UPDATE download_tasks SET received = ?, total = ? WHERE task_id = ?",
      )
      .run(received, total, taskId);
    return c.json({ ok: true });
  } catch (err) {
    libraryLog.error("[db-proxy] download/progress 失败:", err);
    return c.json({ ok: false, error: err instanceof Error ? err.message : "unknown" }, 500);
  }
});

/** POST /download/status  body: Partial<DownloadTask> —— 更新下载任务状态 */
app.post("/download/status", async (c) => {
  try {
    const task = (await c.req.json()) as Partial<DownloadTask> & { taskId: string };
    if (!task.taskId) return c.json({ ok: false, error: "missing taskId" }, 400);
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (task.status != null) { sets.push("status = ?"); params.push(task.status); }
    if (task.received != null) { sets.push("received = ?"); params.push(task.received); }
    if (task.total != null) { sets.push("total = ?"); params.push(task.total); }
    if (task.filePath != null) { sets.push("file_path = ?"); params.push(task.filePath); }
    if (task.errorCode != null) { sets.push("error_code = ?"); params.push(task.errorCode); }
    if (task.finishedAt != null) { sets.push("finished_at = ?"); params.push(task.finishedAt); }
    if (sets.length === 0) return c.json({ ok: true });
    params.push(task.taskId);
    getDb().prepare(`UPDATE download_tasks SET ${sets.join(", ")} WHERE task_id = ?`).run(...params);
    return c.json({ ok: true });
  } catch (err) {
    libraryLog.error("[db-proxy] download/status 失败:", err);
    return c.json({ ok: false, error: err instanceof Error ? err.message : "unknown" }, 500);
  }
});

export default app;
