/**
 * 下载任务路由
 *
 * 服务端 fetch 音频流 → 写入 data/downloads/ → WS 推送进度
 * 前端通过 /api/download/file/:taskId 浏览器取回已下载文件
 *
 * 替代桌面端主进程下载 + Electron 下载目录：
 * - 任务持久化到 SQLite（重启恢复，interrupted 标记）
 * - 进度经 WS 实时推送（download:state / download:progress）
 * - 凭据/cookie 注入由 server 处理（如 netease song_url 需 cookie）
 */
import { Hono } from "hono";
import { createWriteStream, createReadStream, existsSync, mkdirSync, renameSync, unlinkSync, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dataRoot } from "@main/utils/paths";
import { serverLog } from "@main/utils/logger";
import { emit } from "@main/utils/events";
import {
  loadAllTasks,
  upsertTask,
  deleteTask,
  clearFinishedTasks,
} from "@main/database/downloads";
import type {
  DownloadRequest,
  DownloadTask,
  DownloadProgress,
  EnqueueResult,
} from "@shared/types/download";

const app = new Hono();

/** 下载目录（可在 dataRoot/downloads 下按歌手/专辑分类，当前扁平） */
let downloadDir = path.join(dataRoot, "downloads");
if (!existsSync(downloadDir)) mkdirSync(downloadDir, { recursive: true });

/** 运行态任务（内存权威源） */
const tasks = new Map<string, DownloadTask>();
/** 进行中的 AbortController（cancel 用） */
const controllers = new Map<string, AbortController>();

/** 懒加载任务列表（避免模块加载时 DB 未初始化） */
let tasksLoaded = false;
const ensureTasksLoaded = (): void => {
  if (tasksLoaded) return;
  tasksLoaded = true;
  try {
    for (const t of loadAllTasks()) tasks.set(t.taskId, t);
  } catch (err) {
    serverLog.warn("[download] 恢复任务列表失败:", err);
  }
};

/** 扩展名推断 */
const extOf = (url: string, declared?: string): string => {
  if (declared) return declared;
  const m = url.match(/\.(\w+)(\?|$)/);
  return m ? m[1].toLowerCase() : "mp3";
};

/** 安全文件名（去除路径分隔符） */
const safeName = (name: string): string => name.replace(/[\\/]/g, "-").slice(0, 200);

/** 构造目标文件路径 */
const buildFileName = (req: DownloadRequest): string => {
  const artist = req.track.artists.map((a) => a.name).join(", ");
  const title = req.track.title;
  const base = artist ? `${artist} - ${title}` : title;
  const ext = extOf(req.url, req.declaredFormat);
  return `${safeName(base)}.${ext}`;
};

/** 构造目标文件路径 */
const buildFilePath = (req: DownloadRequest): string => {
  return path.join(downloadDir, buildFileName(req));
};

/** 广播状态变更 */
const broadcastState = (task: DownloadTask): void => {
  upsertTask(task);
  emit({ type: "download:state", data: task });
};

/** 广播进度（不落盘，避免高频 IO） */
const broadcastProgress = (data: DownloadProgress): void => {
  emit({ type: "download:progress", data });
};

/** 执行单个下载任务 */
const runDownload = async (req: DownloadRequest): Promise<void> => {
  const task: DownloadTask = {
    taskId: req.taskId,
    status: "downloading",
    track: req.track,
    qualityLevel: req.qualityLevel,
    received: 0,
    total: req.declaredSize ?? 0,
    createdAt: Date.now(),
  };
  tasks.set(req.taskId, task);
  broadcastState(task);

  const controller = new AbortController();
  controllers.set(req.taskId, controller);

  // 临时文件（下载完成才 rename，避免半成品被当作完成文件）
  const finalPath = buildFilePath(req);
  const tmpPath = `${finalPath}.${req.taskId}.tmp`;

  try {
    const res = await fetch(req.url, { signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    const total = Number(res.headers.get("content-length")) || req.declaredSize || 0;
    task.total = total;
    broadcastState(task);

    // 流式写入 + 进度统计
    const fileStream = createWriteStream(tmpPath);
    let received = 0;
    let lastEmit = 0;

    const counter = new ReadableStream({
      start(controller) {
        const reader = res.body!.getReader();
        const pump = async (): Promise<void> => {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          if (value) {
            received += value.length;
            task.received = received;
            // 节流推送（200ms）
            const now = Date.now();
            if (now - lastEmit > 200) {
              lastEmit = now;
              broadcastProgress({ taskId: req.taskId, received, total });
            }
            controller.enqueue(value);
          }
          void pump();
        };
        void pump();
      },
    });

    await pipeline(Readable.fromWeb(counter as any), fileStream);

    // 完成：rename + 更新状态
    renameSync(tmpPath, finalPath);
    task.status = "done";
    task.received = task.total || received;
    task.filePath = finalPath;
    task.finishedAt = Date.now();
    broadcastState(task);
    serverLog.info(`[download] 完成: ${path.basename(finalPath)}`);
  } catch (err) {
    // 清理临时文件
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    const aborted = err instanceof Error && err.name === "AbortError";
    task.status = aborted ? "canceled" : "failed";
    task.errorCode = aborted ? undefined : err instanceof Error ? err.message : "unknown";
    task.finishedAt = Date.now();
    broadcastState(task);
    if (!aborted) serverLog.warn(`[download] 失败 ${req.taskId}:`, err);
  } finally {
    controllers.delete(req.taskId);
  }
};

/** POST /start —— 入队下载 */
app.post("/start", async (c) => {
  ensureTasksLoaded();
  const req = (await c.req.json().catch(() => null)) as DownloadRequest | null;
  if (!req || !req.taskId || !req.url) {
    return c.json({ ok: false } satisfies EnqueueResult, 400);
  }
  const existing = tasks.get(req.taskId);
  if (existing && (existing.status === "downloading" || existing.status === "queued")) {
    return c.json({ ok: false, reason: "queued" } satisfies EnqueueResult);
  }
  // 已下载且文件仍在
  if (existing?.status === "done" && existing.filePath && existsSync(existing.filePath)) {
    return c.json({ ok: false, reason: "downloaded" } satisfies EnqueueResult);
  }
  void runDownload(req);
  return c.json({ ok: true } satisfies EnqueueResult);
});

/** POST /cancel/:taskId —— 取消下载 */
app.post("/cancel/:taskId", (c) => {
  const { taskId } = c.req.param();
  controllers.get(taskId)?.abort();
  return c.json({ ok: true });
});

/** POST /retry —— 重新下载（传入完整 DownloadRequest） */
app.post("/retry", async (c) => {
  const req = (await c.req.json().catch(() => null)) as DownloadRequest | null;
  if (!req) return c.json({ ok: false } satisfies EnqueueResult, 400);
  tasks.delete(req.taskId);
  deleteTask(req.taskId);
  void runDownload(req);
  return c.json({ ok: true } satisfies EnqueueResult);
});

/** POST /browser —— 服务端中转后直接交给浏览器保存，不落盘 */
app.post("/browser", async (c) => {
  const req = (await c.req.json().catch(() => null)) as DownloadRequest | null;
  if (!req?.url) return c.text("bad request", 400);
  try {
    const res = await fetch(req.url);
    if (!res.ok || !res.body) return c.text(`HTTP ${res.status}`, 502);
    const total = Number(res.headers.get("content-length")) || req.declaredSize || 0;
    const filename = encodeURIComponent(buildFileName(req));
    const headers: Record<string, string> = {
      "Content-Type": res.headers.get("content-type") ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${filename}`,
      "Cache-Control": "no-store",
    };
    if (total > 0) headers["Content-Length"] = String(total);
    return c.body(res.body, 200, headers);
  } catch (err) {
    serverLog.warn("[download] 浏览器下载中转失败:", err);
    return c.text(err instanceof Error ? err.message : "download failed", 502);
  }
});

/** POST /remove/:taskId —— 删除任务 + 文件 */
app.post("/remove/:taskId", (c) => {
  const { taskId } = c.req.param();
  controllers.get(taskId)?.abort();
  const task = tasks.get(taskId);
  if (task?.filePath && existsSync(task.filePath)) {
    try {
      unlinkSync(task.filePath);
    } catch {
      /* ignore */
    }
  }
  tasks.delete(taskId);
  deleteTask(taskId);
  return c.json({ ok: true });
});

/** POST /clearFinished —— 清除所有已结束任务（保留文件） */
app.post("/clearFinished", (c) => {
  for (const [id, task] of tasks) {
    if (["done", "failed", "canceled", "interrupted"].includes(task.status)) {
      tasks.delete(id);
    }
  }
  clearFinishedTasks();
  return c.json({ ok: true });
});

/** GET /list —— 返回全部任务 */
app.get("/list", (c) => {
  ensureTasksLoaded();
  const list = Array.from(tasks.values()).sort((a, b) => b.createdAt - a.createdAt);
  return c.json(list);
});

/** GET /dir —— 返回下载目录 */
app.get("/dir", (c) => c.json({ dir: downloadDir }));

/** PUT /dir —— 设置下载目录（web 服务端模式：用户输入服务端可访问路径） */
app.put("/dir", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { dir?: string } | null;
  const dir = body?.dir?.trim();
  if (!dir) return c.json({ error: "missing dir" }, 400);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    downloadDir = dir;
    serverLog.info(`[download] 下载目录已切换: ${dir}`);
    return c.json({ dir: downloadDir });
  } catch (err) {
    serverLog.warn("[download] 切换下载目录失败:", err);
    return c.json({ error: err instanceof Error ? err.message : "invalid dir" }, 400);
  }
});

/** POST /dir/reset —— 重置为默认目录 */
app.post("/dir/reset", (c) => {
  downloadDir = path.join(dataRoot, "downloads");
  if (!existsSync(downloadDir)) mkdirSync(downloadDir, { recursive: true });
  return c.json({ dir: downloadDir });
});

/** GET /file/:taskId —— 浏览器取回已下载文件（Content-Disposition: attachment） */
app.get("/file/:taskId", (c) => {
  const { taskId } = c.req.param();
  const task = tasks.get(taskId);
  if (!task || task.status !== "done" || !task.filePath || !existsSync(task.filePath)) {
    return c.text("not found", 404);
  }
  const stat = statSync(task.filePath);
  const filename = encodeURIComponent(path.basename(task.filePath));
  c.header("Content-Type", "application/octet-stream");
  c.header("Content-Length", String(stat.size));
  c.header("Content-Disposition", `attachment; filename="${filename}"`);
  return c.body(Readable.toWeb(createReadStream(task.filePath)) as ReadableStream);
});

export default app;
