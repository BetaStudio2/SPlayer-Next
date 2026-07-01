/**
 * window.api.download mock：服务端模式
 *
 * 下载在服务端执行（fetch + 落盘到 data/downloads/），
 * 进度经 WebSocket 推送（download:state / download:progress）。
 * 任务持久化到 SQLite，刷新/重启不丢失。
 *
 * 浏览器取回文件：GET /api/download/file/:taskId
 */
import type {
  DownloadApi,
  DownloadRequest,
  DownloadTask,
  DownloadProgress,
  EnqueueResult,
} from "@shared/types/download";
import { systemApi } from "./system";
import { subscribeServerEvent } from "./ws";

const stateCallbacks = new Set<(task: DownloadTask) => void>();
const progressCallbacks = new Set<(data: DownloadProgress) => void>();

/** 从 Content-Disposition 提取文件名 */
const parseFilename = (value: string | null, fallback: string): string => {
  if (!value) return fallback;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1];
  if (utf8) return decodeURIComponent(utf8);
  const plain = /filename="?([^"]+)"?/i.exec(value)?.[1];
  return plain ? decodeURIComponent(plain) : fallback;
};

// 订阅 WS 事件（懒初始化，首次注册回调时启动）
let subscribed = false;
const ensureSubscribed = (): void => {
  if (subscribed) return;
  subscribed = true;
  subscribeServerEvent((event) => {
    if (event.type === "download:state" && event.data) {
      const task = event.data as DownloadTask;
      stateCallbacks.forEach((cb) => cb(task));
    } else if (event.type === "download:progress" && event.data) {
      const data = event.data as DownloadProgress;
      progressCallbacks.forEach((cb) => cb(data));
    }
  });
};

export const downloadApi: DownloadApi = {
  async start(req: DownloadRequest): Promise<EnqueueResult> {
    const res = await fetch("/api/download/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    return (await res.json()) as EnqueueResult;
  },

  async browserSave(req: DownloadRequest): Promise<void> {
    // 流媒体源：直接触发浏览器下载（避免通过 Node.js 代理缓冲整个文件）
    // 利用 <a download> 标签让浏览器原生接管下载
    if (req.track.source === "streaming") {
      // 对于 streaming 源，url 已经是 /api/streaming/stream/ 代理路径
      // 通过 fetch + blob 方式触发浏览器下载
      const res = await fetch("/api/download/browser-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: req.url,
          fileName: req.track.title ? `${req.track.title}.${req.declaredFormat ?? "mp3"}` : "download.mp3",
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const fallbackArtist = req.track.artists.map((item) => item.name).join(", ");
      const fallbackName = `${fallbackArtist ? `${fallbackArtist} - ` : ""}${req.track.title}.${req.declaredFormat ?? "mp3"}`
        .replace(/[\\/:*?"<>|]/g, " ")
        .trim();
      const fileName = parseFilename(res.headers.get("content-disposition"), fallbackName);
      const result = await systemApi.saveFile(await blob.arrayBuffer(), fileName);
      if (!result.success) throw new Error(result.error ?? "save failed");
      return;
    }

    // 已有解析 URL：直接用 fetch 拉取后交给浏览器保存
    const res = await fetch("/api/download/browser", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const fallbackArtist = req.track.artists.map((item) => item.name).join(", ");
    const fallbackName = `${fallbackArtist ? `${fallbackArtist} - ` : ""}${req.track.title}.${req.declaredFormat ?? "mp3"}`
      .replace(/[\\/:*?"<>|]/g, " ")
      .trim();
    const fileName = parseFilename(res.headers.get("content-disposition"), fallbackName);
    const result = await systemApi.saveFile(await blob.arrayBuffer(), fileName);
    if (!result.success) throw new Error(result.error ?? "save failed");
  },

  async cancel(taskId: string): Promise<void> {
    await fetch(`/api/download/cancel/${taskId}`, { method: "POST" });
  },

  async retry(req: DownloadRequest): Promise<EnqueueResult> {
    const res = await fetch("/api/download/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    return (await res.json()) as EnqueueResult;
  },

  async remove(taskId: string): Promise<void> {
    await fetch(`/api/download/remove/${taskId}`, { method: "POST" });
  },

  async clearFinished(): Promise<void> {
    await fetch("/api/download/clearFinished", { method: "POST" });
  },

  async list(): Promise<DownloadTask[]> {
    const res = await fetch("/api/download/list");
    if (!res.ok) return [];
    return (await res.json()) as DownloadTask[];
  },

  async pickDir(): Promise<{ ok: boolean; dir: string; reason?: "canceled" }> {
    // Web 端无目录选择器，返回服务端当前目录（页面用 setDir 修改）
    const res = await fetch("/api/download/dir");
    const { dir } = (await res.json()) as { dir: string };
    return { ok: true, dir };
  },

  async getDir(): Promise<string> {
    const res = await fetch("/api/download/dir");
    const { dir } = (await res.json()) as { dir: string };
    return dir;
  },

  async setDir(dir: string): Promise<string> {
    const res = await fetch("/api/download/dir", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir }),
    });
    const { dir: newDir, error } = (await res.json()) as { dir?: string; error?: string };
    if (!newDir) throw new Error(error ?? "set dir failed");
    return newDir;
  },

  async resetDir(): Promise<string> {
    const res = await fetch("/api/download/dir/reset", { method: "POST" });
    const { dir } = (await res.json()) as { dir: string };
    return dir;
  },

  onProgress(callback: (data: DownloadProgress) => void): () => void {
    ensureSubscribed();
    progressCallbacks.add(callback);
    return () => progressCallbacks.delete(callback);
  },

  onState(callback: (task: DownloadTask) => void): () => void {
    ensureSubscribed();
    stateCallbacks.add(callback);
    return () => stateCallbacks.delete(callback);
  },
};

/**
 * 构造浏览器取回已下载文件的 URL（DownloadList 点击"打开文件"用）
 * 服务端以 attachment 形式返回文件流。
 */
export const getDownloadFileUrl = (taskId: string): string => `/api/download/file/${taskId}`;
