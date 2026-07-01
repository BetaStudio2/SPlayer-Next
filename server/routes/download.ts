/**
 * 下载任务路由（Rust 调度器封装）
 *
 * 实际下载由 Rust 二进制 `splayer-downloader` 执行：
 * - TS 层 spawn 子进程，传递 task-id / url / dest / tmp
 * - Rust 端流式拉取 → 临时文件落盘 → 完成后 rename
 * - 进度通过 stdout JSON lines 上报，TS 解析后经 WS 转发
 * - 取消通过 SIGTERM 终止子进程（Rust 端捕获后清理 .tmp）
 *
 * TS 层职责：任务持久化 / 队列管理 / 文件取回 / 目录管理 / 进度广播
 */
import { Hono } from "hono";
import { existsSync, mkdirSync, unlinkSync, statSync, createReadStream } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
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

/** Rust 下载引擎二进制路径（容器内默认 /app/bin/splayer-downloader） */
const DOWNLOADER_BIN =
  process.env.SPLAYER_DOWNLOADER_BIN ?? "/app/bin/splayer-downloader";

/** 下载目录（可在 dataRoot/downloads 下按歌手/专辑分类，当前扁平） */
let downloadDir = path.join(dataRoot, "downloads");
if (!existsSync(downloadDir)) mkdirSync(downloadDir, { recursive: true });

/** 运行态任务（内存权威源） */
const tasks = new Map<string, DownloadTask>();
/** 进行中的 Rust 子进程（cancel 用） */
const children = new Map<string, ChildProcess>();

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

/** 构造目标文件名 */
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

/** Rust stdout 单行 JSON 协议 */
interface DownloaderEvent {
  type: "progress" | "done" | "error";
  taskId: string;
  received?: number;
  total?: number;
  filePath?: string;
  error?: string;
}

/** 解析子进程 stdout 行 → 转发到 WS */
const handleLine = (taskId: string, line: string): void => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let evt: DownloaderEvent;
  try {
    evt = JSON.parse(trimmed) as DownloaderEvent;
  } catch {
    // 非 JSON 输出（如 panic / 调试日志），原样记录
    serverLog.debug(`[download] ${taskId} stderr/stdout: ${trimmed}`);
    return;
  }
  const task = tasks.get(taskId);
  if (!task) return;

  switch (evt.type) {
    case "progress": {
      task.received = evt.received ?? task.received;
      task.total = evt.total ?? task.total;
      broadcastProgress({
        taskId,
        received: task.received,
        total: task.total,
      });
      break;
    }
    case "done": {
      task.status = "done";
      task.received = task.total || task.received;
      task.filePath = evt.filePath ?? task.filePath;
      task.finishedAt = Date.now();
      broadcastState(task);
      serverLog.info(`[download] 完成: ${path.basename(task.filePath ?? "")}`);
      break;
    }
    case "error": {
      task.status = "failed";
      task.errorCode = evt.error ?? "unknown";
      task.finishedAt = Date.now();
      broadcastState(task);
      serverLog.warn(`[download] 失败 ${taskId}: ${evt.error}`);
      break;
    }
  }
};

/** 将子进程 stdout 流按行拆分回调 */
const attachLineReader = (
  child: ChildProcess,
  taskId: string,
  stream: NodeJS.ReadableStream | null,
): void => {
  if (!stream) return;
  let buf = "";
  stream.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      handleLine(taskId, line);
    }
  });
  stream.on("end", () => {
    if (buf.trim()) handleLine(taskId, buf);
  });
};

/** spawn Rust 下载引擎执行单个任务 */
const spawnDownloader = (req: DownloadRequest): void => {
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

  const dest = buildFilePath(req);
  const args = [
    "start",
    "--task-id",
    req.taskId,
    "--url",
    req.url,
    "--dest",
    dest,
  ];

  let child: ChildProcess;
  try {
    child = spawn(DOWNLOADER_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (err) {
    task.status = "failed";
    task.errorCode = err instanceof Error ? err.message : "spawn failed";
    task.finishedAt = Date.now();
    broadcastState(task);
    serverLog.warn(`[download] spawn 失败 ${req.taskId}:`, err);
    return;
  }

  children.set(req.taskId, child);
  serverLog.info(`[download] 启动 ${req.taskId} → ${path.basename(dest)}`);

  attachLineReader(child, req.taskId, child.stdout);
  // Rust 端的错误日志也尝试按行解析（panic 可能输出非 JSON，记录即可）
  attachLineReader(child, req.taskId, child.stderr);

  child.on("exit", (code, signal) => {
    children.delete(req.taskId);
    const current = tasks.get(req.taskId);
    if (!current) return;
    // 已被 cancel/failed/done 标记的不再覆盖
    if (current.status !== "downloading") return;

    if (signal === "SIGTERM" || signal === "SIGKILL") {
      current.status = "canceled";
      current.finishedAt = Date.now();
      broadcastState(current);
      serverLog.info(`[download] 取消 ${req.taskId}`);
    } else if (code !== 0) {
      current.status = "failed";
      current.errorCode = current.errorCode ?? `exit ${code ?? signal ?? "?"}`;
      current.finishedAt = Date.now();
      broadcastState(current);
      serverLog.warn(`[download] 异常退出 ${req.taskId}: code=${code} signal=${signal}`);
    }
    // code === 0 的情况由 "done" 事件处理
  });

  child.on("error", (err) => {
    children.delete(req.taskId);
    const current = tasks.get(req.taskId);
    if (!current) return;
    if (current.status === "downloading") {
      current.status = "failed";
      current.errorCode = err.message;
      current.finishedAt = Date.now();
      broadcastState(current);
    }
    serverLog.warn(`[download] 子进程错误 ${req.taskId}:`, err);
  });
};

/** POST /start —— 入队下载 */
app.post("/start", (c) => {
  ensureTasksLoaded();
  return c.req
    .json()
    .catch(() => null)
    .then((req) => {
      if (!req || !req.taskId || !req.url) {
        return c.json({ ok: false } satisfies EnqueueResult, 400);
      }
      const downloadReq = req as DownloadRequest;
      const existing = tasks.get(downloadReq.taskId);
      if (
        existing &&
        (existing.status === "downloading" || existing.status === "queued")
      ) {
        return c.json({ ok: false, reason: "queued" } satisfies EnqueueResult);
      }
      if (
        existing?.status === "done" &&
        existing.filePath &&
        existsSync(existing.filePath)
      ) {
        return c.json({ ok: false, reason: "downloaded" } satisfies EnqueueResult);
      }
      spawnDownloader(downloadReq);
      return c.json({ ok: true } satisfies EnqueueResult);
    });
});

/** POST /cancel/:taskId —— 取消下载（SIGTERM 子进程） */
app.post("/cancel/:taskId", (c) => {
  const { taskId } = c.req.param();
  const child = children.get(taskId);
  if (child && !child.killed) {
    child.kill("SIGTERM");
  }
  return c.json({ ok: true });
});

/** POST /retry —— 重新下载（传入完整 DownloadRequest） */
app.post("/retry", async (c) => {
  const req = (await c.req.json().catch(() => null)) as DownloadRequest | null;
  if (!req) return c.json({ ok: false } satisfies EnqueueResult, 400);
  tasks.delete(req.taskId);
  deleteTask(req.taskId);
  spawnDownloader(req);
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

/** POST /browser-stream —— 流式下载中转（流媒体源专用，独立于完整 DownloadRequest） */
app.post("/browser-stream", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { url: string; fileName: string } | null;
  if (!body?.url) return c.text("bad request", 400);
  const fileName = body.fileName || "download.mp3";
  try {
    const res = await fetch(body.url);
    if (!res.ok || !res.body) return c.text(`HTTP ${res.status}`, 502);
    const headers: Record<string, string> = {
      "Content-Type": res.headers.get("content-type") ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Cache-Control": "no-store",
    };
    return c.body(res.body, 200, headers);
  } catch (err) {
    serverLog.warn("[download] 流式下载中转失败:", err);
    return c.text(err instanceof Error ? err.message : "download failed", 502);
  }
});

/** POST /remove/:taskId —— 删除任务 + 文件 */
app.post("/remove/:taskId", (c) => {
  const { taskId } = c.req.param();
  const child = children.get(taskId);
  if (child && !child.killed) {
    child.kill("SIGTERM");
  }
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
