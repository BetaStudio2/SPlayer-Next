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

/** GET /file-records —— 返回增量扫描比对所需的文件记录 */
app.get("/file-records", (c) => {
  const rows = getDb()
    .prepare("SELECT path, COALESCE(file_mtime, 0) as mtime, file_size as size FROM tracks")
    .all() as { path: string; mtime: number; size: number }[];
  return c.json({ ok: true, records: rows });
});

/* ------------------------------------------------------------------ */
/* 扫描蓝图表（Blueprint）—— 替代纯内存 \"records + allSeen\"           */
/* 崩溃安全：蓝图持久化在 SQLite 中，扫描崩溃后不会丢失"已处理"状态      */
/* ------------------------------------------------------------------ */

/**
 * POST /blueprint/init —— 创建扫描蓝图表，记录当前 DB 中所有文件路径。
 * 蓝图表是普通持久表（非 TEMP，以避免 HTTP 多连接不可见）。
 * 扫描结束后 cleanup 删除。
 */
app.post("/blueprint/init", (c) => {
  const db = getDb();
  db.exec(`
    DROP TABLE IF EXISTS _scanner_blueprint;
    CREATE TABLE IF NOT EXISTS _scanner_blueprint (
      path TEXT PRIMARY KEY,
      mtime INTEGER NOT NULL DEFAULT 0,
      size INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO _scanner_blueprint (path, mtime, size)
    SELECT path, COALESCE(file_mtime, 0), COALESCE(file_size, 0) FROM tracks;
  `);
  const count = db
    .prepare("SELECT COUNT(*) as cnt FROM _scanner_blueprint")
    .get() as { cnt: number };
  libraryLog.info(`[blueprint] 已创建蓝图，包含 ${count.cnt} 条记录`);
  return c.json({ ok: true, total: count.cnt });
});

/**
 * POST /blueprint/consume  body: { path, mtime?, size? }
 *
 * 原子操作：检查文件是否在蓝图中，并移除。
 * 响应：
 *   { ok: true, exists: true, unchanged: true }  → 文件未变，跳过
 *   { ok: true, exists: true, unchanged: false } → 文件已变，需要重新解析
 *   { ok: true, exists: false }                  → 新文件，需要入库
 */
app.post("/blueprint/consume", async (c) => {
  try {
    const { path, mtime, size } = (await c.req.json()) as {
      path: string;
      mtime?: number;
      size?: number;
    };
    if (!path) return c.json({ ok: false, error: "missing path" }, 400);

    const db = getDb();
    const row = db
      .prepare("SELECT mtime, size FROM _scanner_blueprint WHERE path = ?")
      .get(path) as { mtime: number; size: number } | undefined;

    if (!row) {
      return c.json({ ok: true, exists: false });
    }

    // 从蓝图中移除（无论是否变化，都已"被处理"）
    db.prepare("DELETE FROM _scanner_blueprint WHERE path = ?").run(path);

    // 判断文件是否未变化（mtime + size 精确比对）
    const unchanged =
      mtime !== undefined && size !== undefined &&
      row.mtime === mtime && row.size === size;

    return c.json({ ok: true, exists: true, unchanged });
  } catch (err) {
    libraryLog.error("[blueprint] consume 失败:", err);
    return c.json({ ok: false, error: err instanceof Error ? err.message : "unknown" }, 500);
  }
});

/**
 * POST /blueprint/cleanup —— 删除蓝图中残留的曲目（＝磁盘已删除），并销毁蓝图
 * 同时清理关联的 scrape_queue 孤儿项，防止 Pending 任务指向不存在的曲目。
 * 响应：{ ok: true, deleted: N }
 */
app.post("/blueprint/cleanup", async (c) => {
  try {
    const db = getDb();
    const stale = db
      .prepare("SELECT path FROM _scanner_blueprint")
      .all() as { path: string }[];

    if (stale.length === 0) {
      db.exec("DROP TABLE IF EXISTS _scanner_blueprint");
      return c.json({ ok: true, deleted: 0 });
    }

    const paths = stale.map((r) => r.path);
    deleteTracksByPaths(paths);

    // 清理 scrape_queue 孤儿：从 scrapestate.db 移除无效引用
    const sdb = getScraperDb();
    const orphanCleanup = sdb.transaction(() => {
      let orphanCount = 0;
      const orphans = sdb
        .prepare(
          `SELECT s.track_id FROM scrape_queue s
           WHERE s.track_id NOT IN (SELECT id FROM tracks)`,
        )
        .all() as { track_id: string }[];
      const delStmt = sdb.prepare("DELETE FROM scrape_queue WHERE track_id = ?");
      for (const o of orphans) {
        delStmt.run(o.track_id);
        orphanCount++;
      }
      return orphanCount;
    });
    const orphanCount = orphanCleanup();
    if (orphanCount > 0) {
      libraryLog.info(`[blueprint] 清理 ${orphanCount} 个 scrape_queue 孤儿项`);
    }

    db.exec("DROP TABLE IF EXISTS _scanner_blueprint");

    libraryLog.info(`[blueprint] 清理 ${paths.length} 条失效记录`);
    return c.json({ ok: true, deleted: paths.length, orphans: orphanCount });
  } catch (err) {
    libraryLog.error("[blueprint] cleanup 失败:", err);
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
